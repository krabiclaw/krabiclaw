import { reservationAllocationPredicate, reservationReschedulePolicyPredicate, requireLocationReservationConfig } from '~/server/utils/reservations'
import { refreshProductBusy } from '~/server/domain/member-scheduling'
import { recordBookingChangeAnswer } from '~/server/domain/booking-analytics'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { HTTPError } from 'nitro'
import { z } from 'zod'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { listSessions, sessionMoveQuery, sessionAssignmentQuery } from '~/server/utils/availability'
import { formatTimestamp, localDateTimeToInstant } from '~/utils/timezone'
import { assertResourceAccess, resolveOrganizationMembership, memberAccessPrincipal } from '~/server/utils/member-access'
import { resolveBookingPresentation, type BookingKind } from '~/utils/booking-presentation'
import type { CloudflareEnv } from '~/server/utils/auth'
import { guestPresentation, notifyBookingChangeOwner } from '~/server/utils/notifications'
import { platformLocale } from '~/shared/platform-locales'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { formatTenantLocalePath } from '~/utils/tenant-locale-path'
import { appendEntry, findEntryByDedupeKey, getEntryById } from './entries'
import { createDeliveryReceipt, deliverGuestThreadEmail } from './deliveries'
import { getEmailDeliveryMode } from '~/server/utils/email-delivery'
import { renderNotificationEmail } from '~/server/emails/render'
import { bookingChangeProposalMessage } from '~/server/notifications/guest-events'
import { organizationLogo } from '~/server/notifications/hero'
import { getPlatformDomain } from '~/server/utils/dashboard-notification-links'
import { updateThreadProjectionIfLatestEntry } from './repository'
import { getGuestRequest, getThreadOperationalRecord, requestSummary, REQUEST_CURRENT_BUYER_SQL } from '~/server/domain/requests'
import type { GuestThreadRow } from './types'

/**
 * Guest-facing copy uses the tenant's own word for the booking, resolved from
 * the same table the dashboard reads. Deriving it here from submission_type
 * alone told a professional-services client's guest about their "booking" while
 * every screen their host saw said consultation.
 */
async function bookingNoun(db: DbClient, thread: Pick<GuestThreadRow, 'organization_id' | 'kind'>): Promise<string> {
	const organization = await queryFirst<{ vertical: string }>(db, 'SELECT vertical FROM organization WHERE id = ? LIMIT 1', [thread.organization_id])
	const kind: BookingKind = thread.kind === 'reservation' ? 'reservation' : 'booking'
	return resolveBookingPresentation(kind, organization?.vertical).noun
}

/**
 * What a change proposes.
 *
 * A booking and a reservation are different capabilities, so a change to one
 * is not a change to the other wearing different field names. A booking moves
 * to another SESSION of the same product — the occurrence is a real row, so
 * the proposal names it. A reservation has no occurrence row, so it moves to a
 * location, date and time.
 */
const bookingFieldsSchema = z.object({ kind: z.literal('booking'), sessionId: z.string().min(1), partySize: z.number().int().min(1).max(99) })
const reservationFieldsSchema = z.object({
  kind: z.literal('reservation'),
  locationId: z.string().min(1),
  bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }),
  bookingTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  partySize: z.number().int().min(1).max(99),
  overridePolicy: z.boolean().optional(),
})
const fieldsSchema = z.discriminatedUnion('kind', [bookingFieldsSchema, reservationFieldsSchema])
const requestSchema = z.intersection(fieldsSchema, z.object({ expectedUpdatedAt: z.string().min(1) }))
const sourceSchema = z.object({
  recordKind: z.enum(['booking', 'reservation']),
  assignedMemberId: z.string().nullable().default(null),
  recordId: z.string(),
  status: z.string(),
  partySize: z.number().int(),
  startsAt: z.string(),
  endsAt: z.string(),
  timezone: z.string(),
  locationId: z.string().nullable(),
  productId: z.string().nullable(),
  partySizeIsMinimum: z.boolean(),
  notes: z.string().nullable(),
  guest: z.object({ name: z.string(), email: z.string(), phone: z.string().nullable() }),
})
const proposalSchema = z.object({
  before: sourceSchema, after: fieldsSchema, updatedAt: z.string(),
  locationTitle: z.string(), originalLocationTitle: z.string(), afterLabel: z.string(),
  // Written since the WhatsApp template gained real date and time slots.
  // Proposals recorded before that are immutable facts without them, and the
  // send falls back to the template's own placeholders for those.
  afterDate: z.string().optional(), afterTime: z.string().optional(),
  afterStartsAt: z.string().optional(), afterTimezone: z.string().optional(), afterLocationId: z.string().nullable().optional(),
})
type Fields = z.infer<typeof fieldsSchema>
type Source = z.infer<typeof sourceSchema> & { updatedAt: string }
type ChangeEnv = CloudflareEnv

async function sourceSummary(db: DbClient, thread: GuestThreadRow) {
  if (thread.kind !== 'booking' && thread.kind !== 'reservation') throw new HTTPError({ statusCode: 400, message: 'This conversation has no changeable booking or reservation', data: { code: 'BOOKING_CHANGE_UNSUPPORTED', field: 'kind' } })
  return { ...await requestSummary(db, thread), guestName: thread.payload.guest.name }
}

function localLabel(instant: string, timezone: string): string {
  return localParts(instant, timezone).label
}

/**
 * The occurrence as one label and as its date and time separately, all read
 * from the same instant and the same zone in one place.
 *
 * The split exists because the approved WhatsApp template has a date slot and a
 * time slot; it is derived here rather than at the send site so there is still
 * only one answer to "which zone did the guest agree to".
 */
function localParts(instant: string, timezone: string): { label: string; date: string; time: string } {
  const at = new Date(instant)
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options }).format(at)
  return {
    label: format({ dateStyle: 'medium', timeStyle: 'short' }),
    date: format({ dateStyle: 'medium' }),
    time: format({ timeStyle: 'short' }),
  }
}

/**
 * The current state of what the thread actually refers to.
 *
 * Read from the booking or reservation, never from the thread: the thread
 * stopped holding a copy of the occurrence precisely so the two could not
 * disagree.
 */
async function loadSource(db: DbClient, thread: GuestThreadRow): Promise<Source> {
  if (thread.kind === 'contact') throw new HTTPError({ statusCode: 400, message: 'This conversation is not a reservation or booking' })
  // A stay's dates and party are changed on the stay itself, not proposed through its thread.
  if (thread.kind === 'stay') throw new HTTPError({ statusCode: 400, message: 'Change a stay from the stay itself' })
  const record = await getThreadOperationalRecord(db, thread.id)
  if (!record || record.kind === 'stay') throw new HTTPError({ statusCode: 409, message: 'This conversation has no booking or reservation to change' })
  const payload = thread.payload as { party_size_is_minimum: boolean; notes: string | null; guest: { name: string; email: string; phone: string | null } }
  return {
    assignedMemberId: record.assigned_member_id,
    recordKind: record.kind, recordId: record.id, status: record.status, partySize: record.party_size,
    startsAt: record.starts_at, endsAt: record.ends_at, timezone: record.timezone,
    locationId: record.location_id, productId: record.product_id,
    updatedAt: thread.updated_at, partySizeIsMinimum: payload.party_size_is_minimum, notes: payload.notes, guest: payload.guest,
  }
}

interface Destination { locationId: string | null; title: string; label: string; date: string; time: string; startsAt: string; timezone: string; endsAt?: string; claim?: (bookingId: string, now: string) => BatchQuery | Promise<BatchQuery>; sessionId?: string }

/**
 * Check that the proposed target can actually take this party, and return the
 * statement that claims it.
 *
 * For a booking the statement is the session claim, carrying its own capacity
 * predicate so the seat is taken atomically with the release of the old one.
 * For a reservation the slot is checked against the location's configured
 * capacity for that start time.
 */
async function validateDestination(db: DbClient, thread: GuestThreadRow, before: Source, after: Fields, decisionDedupeKey?: string): Promise<Destination> {
  if (after.kind === 'booking') {
    if (before.recordKind !== 'booking' || !before.productId) throw new HTTPError({ statusCode: 409, message: 'This conversation is a reservation, not a booking' })
    const [target] = await listSessions(db, {
      organizationId: thread.organization_id, productId: before.productId,
      fromInstant: new Date().toISOString(), toInstant: new Date(Date.now() + 400 * 86_400_000).toISOString(),
    })
      .then(sessions => sessions.filter(session => session.id === after.sessionId))
    if (!target) throw new HTTPError({ statusCode: 409, message: 'That session is not open for booking' })
    const booking = await queryFirst<{ product_variant_id: string; user_id: string | null }>(db,
      'SELECT product_variant_id, user_id FROM bookings WHERE id = ?', [before.recordId])
    if (!booking) throw new HTTPError({ statusCode: 409, message: 'The original booking is missing' })
    if (after.partySize !== before.partySize || target.location_id !== before.locationId) {
      const paid = await queryFirst(db, "SELECT id FROM payments WHERE organization_id=? AND subject_type='booking' AND subject_id=? AND captured_amount>refunded_amount LIMIT 1", [thread.organization_id, before.recordId])
      if (paid) throw new HTTPError({ statusCode: 409, message: 'Refund the paid booking before changing its quantity or location' })
    }
    const location = target.location_id
      ? await queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE id = ? AND organization_id = ?', [target.location_id, thread.organization_id])
      : null
    return {
      locationId: target.location_id, title: location?.title ?? '', sessionId: target.id,
      startsAt: target.starts_at, endsAt: target.ends_at, timezone: target.timezone, ...localParts(target.starts_at, target.timezone),
      // The same Booking moves under the shared allocation predicate. Exclude
      // its existing allocation; a full destination leaves the record unchanged.
      claim: (bookingId, now) => sessionMoveQuery(db, {
        bookingId, organizationId: thread.organization_id, productId: before.productId!,
        sessionId: target.id, partySize: after.partySize,
        replacingBookingId: before.recordId,
        requireUndecided: {
          requestId: thread.id, organizationId: thread.organization_id, updatedAt: before.updatedAt,
          decisionDedupeKey: decisionDedupeKey ?? '',
        }, now,
      }),
    }
  }

  if (before.recordKind !== 'reservation') throw new HTTPError({ statusCode: 409, message: 'This conversation is a booking, not a reservation' })
  if (!before.locationId) throw new Error('Reservation has no source location')
  const reschedulePolicy = reservationReschedulePolicyPredicate({ organizationId: thread.organization_id, locationId: before.locationId, reservationId: before.recordId, startsAt: before.startsAt, overridePolicy: after.overridePolicy })
  if (!await queryFirst(db, `SELECT 1 WHERE ${reschedulePolicy.query}`, reschedulePolicy.params)) throw new HTTPError({ statusCode: 409, message: 'This reservation’s change policy does not allow this request. The business can explicitly approve an exception.', data: { code: 'policy_exception_required' } })
  const location = await queryFirst<{ id: string; title: string; timezone: string | null }>(db,
    'SELECT id, title, timezone FROM business_locations WHERE id = ? AND organization_id = ?',
    [after.locationId, thread.organization_id])
  if (!location) throw new HTTPError({ statusCode: 400, message: 'Choose a location belonging to this organization' })
  if (!location.timezone) throw new HTTPError({ statusCode: 409, message: 'Set the location timezone before changing reservations' })
  const startsAt = localDateTimeToInstant(after.bookingDate, after.bookingTime, location.timezone, 'reject').toISOString()
  const policy = await requireLocationReservationConfig(db, { organizationId: thread.organization_id, locationId: location.id })
  const paid = await queryFirst(db, "SELECT id FROM payments WHERE organization_id = ? AND subject_type = 'reservation' AND subject_id = ? AND captured_amount > refunded_amount LIMIT 1", [thread.organization_id, before.recordId])
  if (paid && (after.partySize !== before.partySize || location.id !== before.locationId)) throw new HTTPError({ statusCode: 409, message: 'Refund this paid reservation before changing its quantity or location' })
  if (!paid && policy.deposit_required && (policy.deposit_trigger_party_size === null || after.partySize >= policy.deposit_trigger_party_size)) {
    const organization = await queryFirst<{slug:string}>(db, 'SELECT slug FROM organization WHERE id=?', [thread.organization_id])
    if (!organization) throw new Error('Reservation organization is missing')
    throw new HTTPError({ statusCode: 409, message: 'This new reservation needs a deposit before it can replace the current one', data: { code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(organization.slug)}/bookings/reservation/${encodeURIComponent(thread.id)}` } })
  }
  const endsAt = new Date(Date.parse(startsAt) + Date.parse(before.endsAt) - Date.parse(before.startsAt)).toISOString()
  const allocation = await reservationAllocationPredicate(db, { organizationId: thread.organization_id, locationId: location.id, timezone: location.timezone, startsAt, endsAt, partySize: after.partySize, replacingReservationId: before.recordId })
  if (!await queryFirst(db, `SELECT 1 WHERE ${allocation.query}`, allocation.params)) throw new HTTPError({ statusCode: 409, message: 'The requested time is closed or no longer has capacity for this party' })
  return { locationId: location.id, title: location.title, startsAt, endsAt, timezone: location.timezone, ...localParts(startsAt, location.timezone),
    claim: async (reservationId, now) => {
      const currentAllocation = await reservationAllocationPredicate(db, { organizationId: thread.organization_id, locationId: location.id, timezone: location.timezone!, startsAt, endsAt, partySize: after.partySize, replacingReservationId: reservationId })
      return { query: `UPDATE reservations SET starts_at = ?, ends_at = ?, timezone = ?, party_size = ?, location_id = ?, updated_at = ?
        WHERE id = ? AND organization_id = ? AND status = 'confirmed' AND ${currentAllocation.query}
          AND ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND ${reschedulePolicy.query} AND starts_at = ? AND ends_at = ? AND location_id = ? AND party_size = ?
          AND (NOT EXISTS (SELECT 1 FROM payments p WHERE p.organization_id=reservations.organization_id AND p.subject_type='reservation' AND p.subject_id=reservations.id AND p.captured_amount>p.refunded_amount) OR (party_size=? AND location_id=?))
          AND (EXISTS (SELECT 1 FROM payments p WHERE p.organization_id=reservations.organization_id AND p.subject_type='reservation' AND p.subject_id=reservations.id AND p.captured_amount>p.refunded_amount)
            OR EXISTS (SELECT 1 FROM location_reservation_configs c WHERE c.organization_id=reservations.organization_id AND c.location_id=? AND (c.deposit_required=0 OR c.deposit_trigger_party_size>?)))
          AND EXISTS (SELECT 1 FROM requests WHERE id = ? AND organization_id = ? AND updated_at = ?)
          AND NOT EXISTS (SELECT 1 FROM activity_entries WHERE dedupe_key = ?)`,
        params: [startsAt, endsAt, location.timezone!, after.partySize, location.id, now, reservationId, thread.organization_id, ...currentAllocation.params!, ...reschedulePolicy.params!, before.startsAt, before.endsAt, before.locationId, before.partySize, after.partySize, location.id, location.id, after.partySize, thread.id, thread.organization_id, before.updatedAt, decisionDedupeKey ?? ''] }
    },
  }
}

function linkToken(env: ChangeEnv, threadId: string, requestId: string) {
  if (!env.EMAIL_REPLY_SECRET) throw new HTTPError({ statusCode: 503, message: 'Guest email signing is not configured' })
  return createHmac('sha256', env.EMAIL_REPLY_SECRET).update(`booking-change:v1:${threadId}:${requestId}`).digest('hex')
}

async function changePresentation(db: DbClient, thread: GuestThreadRow, proposal: z.infer<typeof proposalSchema>) {
  const organization = await queryFirst<{ name: string; vertical: string | null }>(db, 'SELECT name, vertical FROM organization WHERE id = ?', [thread.organization_id])
  if (!organization?.name) throw new HTTPError({ statusCode: 409, message: 'Organization name is not configured' })
  // Keep the proposed instant immutable. Older entries are rendered from their
  // canonical target only while it still agrees with the recorded label.
  let startsAt = proposal.afterStartsAt
  let timezone = proposal.afterTimezone
  let locationId = proposal.afterLocationId !== undefined ? proposal.afterLocationId : proposal.after.kind === 'reservation' ? proposal.after.locationId : proposal.before.locationId
  if (!startsAt || !timezone) {
    const target = proposal.after.kind === 'booking'
      ? await queryFirst<{ starts_at: string; timezone: string; location_id: string | null }>(db,
          'SELECT starts_at, timezone, location_id FROM product_sessions WHERE id = ? AND organization_id = ? AND product_id = ?',
          [proposal.after.sessionId, thread.organization_id, proposal.before.productId])
      : await queryFirst<{ timezone: string | null }>(db, 'SELECT timezone FROM business_locations WHERE id = ? AND organization_id = ?', [locationId, thread.organization_id])
          .then(location => location?.timezone && proposal.after.kind === 'reservation'
            ? { timezone: location.timezone, location_id: locationId, starts_at: localDateTimeToInstant(proposal.after.bookingDate, proposal.after.bookingTime, location.timezone, 'reject').toISOString() }
            : null)
    if (!target || localLabel(target.starts_at, target.timezone) !== proposal.afterLabel) throw new HTTPError({ statusCode: 409, message: 'The proposed time has changed. Ask the business for a new change request.' })
    startsAt = target.starts_at
    timezone = target.timezone
    locationId = target.location_id
  }
  const guest = await guestPresentation(db, {
    organizationId: thread.organization_id, organizationName: organization.name, locale: thread.payload.guest.locale,
    productId: proposal.before.productId, locationId, locationName: proposal.locationTitle,
  })
  const original = locationId === proposal.before.locationId ? guest
    : await guestPresentation(db, { organizationId: thread.organization_id, organizationName: organization.name, locale: guest.locale,
        locationId: proposal.before.locationId, locationName: proposal.originalLocationTitle })
  const labels = platformLocale(guest.locale)!.messages
  const copy = getVerticalCopy(organization.vertical, guest.locale)
  return {
    ...guest, fromName: organization.name, vertical: organization.vertical, labels, copy,
    before: { whenLabel: formatTimestamp(proposal.before.startsAt, guest.locale, proposal.before.timezone, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }), partySize: proposal.before.partySize },
    after: { whenLabel: formatTimestamp(startsAt, guest.locale, timezone, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }), partySize: proposal.after.partySize },
    locationTitle: guest.locationName?.trim() || labels['booking.online']!, originalLocationTitle: original.locationName?.trim() || labels['booking.online']!,
  }
}

async function deliverEmail(db: DbClient, env: ChangeEnv, thread: GuestThreadRow, entryId: string, status: 'requested' | 'accepted' | 'declined', proposal: z.infer<typeof proposalSchema>, noun: string) {
  const summary = await sourceSummary(db, thread)
  if (!summary.guestEmail) throw new HTTPError({ statusCode: 400, message: 'Guest email is required' })
  const guest = await changePresentation(db, thread, proposal)
  const subject = guest.labels[`booking.change_${status === 'requested' ? 'review' : status}`]!
  const actionUrl = status === 'requested'
    ? new URL(formatTenantLocalePath(`/booking-changes/${thread.id}/${entryId}`, guest.locale, 'en'), env.NUXT_PUBLIC_PLATFORM_DOMAIN)
    : null
  if (actionUrl) actionUrl.hash = linkToken(env, thread.id, entryId)
  const delivery = await createDeliveryReceipt(db, {
    entryId,
    channel: 'email',
    provider: getEmailDeliveryMode(env) === 'provider' ? 'resend' : 'log_only',
    purpose: 'status_update',
    idempotencyKey: `booking-change:${entryId}`,
  })
  const sent = await deliverGuestThreadEmail(db, {
    delivery,
    env,
    to: summary.guestEmail,
    fromName: guest.fromName,
    subject,
    email: await renderNotificationEmail(bookingChangeProposalMessage({
      guestName: summary.guestName,
      locale: guest.locale,
      organizationName: guest.organizationName,
      organizationLogoUrl: await organizationLogo(db, thread.organization_id),
      heading: subject,
      intro: guest.labels[`booking.change_${status === 'requested' ? 'pending' : status === 'declined' ? 'unchanged' : 'updated'}`]!,
      rows: status === 'declined' ? [] : [[guest.copy.locationLabel, guest.locationTitle], [guest.copy.dateLabel, guest.after.whenLabel], [guest.copy.guestsLabel, String(guest.after.partySize)]],
      actionUrl: actionUrl?.href ?? null,
      actionLabel: actionUrl ? guest.labels['booking.change_review']! : null,
    }), { platformDomain: getPlatformDomain(env) }),
    submissionType: thread.kind,
    submissionId: thread.id,
  })
  if (sent.status === 'failed') throw new HTTPError({ statusCode: 502, message: sent.error || 'Guest email could not be sent' })
  await notifyBookingChangeOwner(env, db, {
    organizationId: thread.organization_id, organizationName: guest.fromName,
    threadId: thread.id, submissionType: thread.kind === 'reservation' ? 'reservation' : 'booking', submissionId: thread.id, sourceEntryId: entryId,
    guestName: summary.guestName, guestEmail: summary.guestEmail, status, noun,
    whenLabel: proposal.afterLabel, whenDate: proposal.afterDate ?? null, whenTime: proposal.afterTime ?? null,
    guests: proposal.after.partySize, locationTitle: proposal.locationTitle,
  })
}

/** A proposal is an immutable fact in the existing conversation, not a second booking record. */
export async function requestBookingChange(db: DbClient, env: CloudflareEnv, thread: GuestThreadRow, actorUserId: string, body: unknown, idempotencyKey: string) {
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'Valid change details and the latest booking timestamp are required' })
  const [afterInput, meta] = [parsed.data as Fields & { expectedUpdatedAt: string }, parsed.data as { expectedUpdatedAt: string }]
  const after = fieldsSchema.parse(afterInput)
  const before = await loadSource(db, thread)
  const summary = await sourceSummary(db, thread)
  const membership = await resolveOrganizationMembership(env, { organizationId: thread.organization_id, userId: actorUserId })
  if (!membership) throw new HTTPError({ statusCode: 403, message: 'Organization access required' })
  // Both the current and the proposed location must be within reach, so a
  // branch editor cannot move a guest into a branch they do not manage.
  const locations = new Set([before.locationId, after.kind === 'reservation' ? after.locationId : null].filter((value): value is string => Boolean(value)))
  for (const locationId of locations) {
    await assertResourceAccess(db, { ...memberAccessPrincipal(membership, { env}), resourceLocationId: locationId })
  }
  const externalId = `booking-change-request:${thread.id}:${idempotencyKey}`
  let entry = await findEntryByDedupeKey(db, externalId)
  if (entry) {
    const previous = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
    if (JSON.stringify(previous.after) !== JSON.stringify(after) || previous.updatedAt !== meta.expectedUpdatedAt) throw new HTTPError({ statusCode: 409, message: 'Request key was reused for different changes' })
    const decision = await findEntryByDedupeKey(db, `booking-change-decision:${entry.id}`)
    if (decision) {
      if (decision.event_name === 'booking_change.accepted') return { changeStatus: 'accepted' as const }
      if (decision.event_name === 'booking_change.declined') return { changeStatus: 'declined' as const }
      throw new HTTPError({ statusCode: 500, message: 'Booking change decision is invalid' })
    }
  } else {
    if (!['pending', 'confirmed'].includes(before.status)) throw new HTTPError({ statusCode: 409, message: 'This reservation or booking can no longer be changed' })
    if (before.endsAt <= new Date().toISOString()) throw new HTTPError({statusCode:409,message:'This visit has ended and cannot be rescheduled'})
    if (before.updatedAt !== meta.expectedUpdatedAt) throw new HTTPError({ statusCode: 409, message: 'The reservation changed. Reload before sending a request.' })
    const destination = await validateDestination(db, thread, before, after)
    // Moving a reservation to another branch at the same time for the same
    // party is a change; comparing only the label and the party size rejected it.
    if (destination.label === localLabel(before.startsAt, before.timezone)
      && after.partySize === before.partySize
      && destination.locationId === before.locationId) {
      throw new HTTPError({ statusCode: 400, message: 'Choose at least one change' })
    }
    const original = before.locationId
      ? await queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE id = ? AND organization_id = ?', [before.locationId, thread.organization_id])
      : null
    // Validate delivery configuration before persisting a proposal.
    linkToken(env, thread.id, 'configuration-check')
    if (!summary.guestEmail || !env.NUXT_PUBLIC_PLATFORM_DOMAIN) throw new HTTPError({ statusCode: 503, message: 'Guest email delivery is not configured' })
    entry = await appendEntry(db, { threadId: thread.id, kind: 'operation', actorKind: 'member', actorUserId,
      eventName: 'booking_change.requested', dedupeKey: externalId,
      body: `Requested ${destination.label} for ${after.partySize} guests${destination.title ? ` at ${destination.title}` : ''}.`,
      payloadJson: { before: sourceSchema.parse(before), after, updatedAt: before.updatedAt,
        locationTitle: destination.title, originalLocationTitle: original?.title ?? '', afterLabel: destination.label,
        afterDate: destination.date, afterTime: destination.time, afterStartsAt: destination.startsAt, afterTimezone: destination.timezone, afterLocationId: destination.locationId },
    })
  }
  const noun = await bookingNoun(db, thread)
  const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
  await deliverEmail(db, env, thread, entry.id, 'requested', proposal, noun)
  await updateThreadProjectionIfLatestEntry(db, thread.id, entry.id, { conversationState: 'waiting_on_guest' })
  const decision = await findEntryByDedupeKey(db, `booking-change-decision:${entry.id}`)
  if (decision) {
    if (decision.event_name === 'booking_change.accepted') return { changeStatus: 'accepted' as const }
    if (decision.event_name === 'booking_change.declined') return { changeStatus: 'declined' as const }
    throw new HTTPError({ statusCode: 500, message: 'Booking change decision is invalid' })
  }
  return { changeStatus: 'awaiting_guest_acceptance' as const }
}

/** GET only reads the immutable proposal. POST records one idempotent guest decision. */
export async function respondToBookingChange(db: DbClient, env: ChangeEnv, input: { threadId: string; requestId: string; decision?: 'accept' | 'decline' } & ({ token: string } | { buyerUserId: string })) {
  // The guest answers from the email link, or signed in as the account that owns the booking.
  if ('token' in input) {
    const expected = linkToken(env, input.threadId, input.requestId)
    if (!/^[a-f0-9]{64}$/.test(input.token) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.token, 'hex'))) throw new HTTPError({ statusCode: 404, message: 'Change request not found' })
  } else if (!await queryFirst(db, `SELECT 1 FROM requests r WHERE r.id = ? AND r.user_id = ? AND ${REQUEST_CURRENT_BUYER_SQL}`, [input.threadId, input.buyerUserId])) {
    throw new HTTPError({ statusCode: 404, message: 'Change request not found' })
  }
  const entry = await getEntryById(db, input.requestId)
  if (!entry || entry.request_id !== input.threadId || entry.event_name !== 'booking_change.requested') throw new HTTPError({ statusCode: 404, message: 'Change request not found' })
  const thread = await getGuestRequest(db, entry.request_id)
  if (!thread) throw new HTTPError({ statusCode: 404, message: 'Change request not found' })
  const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
  const resultId = `booking-change-decision:${entry.id}`
  let result = await findEntryByDedupeKey(db, resultId)
  if (!result && Date.now() > Date.parse(entry.occurred_at) + 7 * 86400_000) throw new HTTPError({ statusCode: 410, message: 'This change request has expired' })
  const current = await loadSource(db, thread as GuestThreadRow)
  if (!result && JSON.stringify(sourceSchema.parse(current)) !== JSON.stringify(proposal.before)) throw new HTTPError({ statusCode: 409, message: 'This reservation has changed since the request was sent. Ask your host for a new request.' })

  if (!result && input.decision) {
    if (!['pending', 'confirmed'].includes(current.status)) throw new HTTPError({ statusCode: 409, message: 'This reservation or booking can no longer be changed' })
    if(input.decision==='accept' && current.productId)await refreshProductBusy(db,env,thread.organization_id,current.productId)
    const destination = input.decision === 'accept' ? await validateDestination(db, thread as GuestThreadRow, current, proposal.after, resultId) : null
    if (destination && (destination.label !== proposal.afterLabel || (proposal.afterStartsAt && destination.startsAt !== proposal.afterStartsAt) || (proposal.afterTimezone && destination.timezone !== proposal.afterTimezone) || (proposal.afterLocationId !== undefined && destination.locationId !== proposal.afterLocationId))) throw new HTTPError({ statusCode: 409, message: 'The proposed time has changed. Ask the business for a new change request.' })
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    // The decision entry is guarded on the thread still being exactly what the
    // guest was shown. Everything else in the batch depends on that row
    // existing, so a concurrent edit makes the whole decision a no-op rather
    // than half-applying it.
    const entryInsert: BatchQuery = {
      query: `INSERT INTO activity_entries
        (id, request_id, kind, scope_kind, actor_kind, event_name, body, payload_json, dedupe_key, sequence, occurred_at, created_at)
        SELECT ?, ?, 'operation', 'request', 'guest', ?, ?, ?, ?,
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM activity_entries WHERE request_id = ?), ?, ?
        FROM requests source WHERE source.id = ? AND source.organization_id = ? AND source.updated_at = ?
        ON CONFLICT DO NOTHING`,
      params: [id, thread.id, `booking_change.${input.decision === 'accept' ? 'accepted' : 'declined'}`,
        `Guest ${input.decision === 'accept' ? 'accepted' : 'declined'} the requested changes.`,
        JSON.stringify({ requestId: entry.id, request_id: thread.id, operational_booking_id: current.recordId, beforeStatus: current.status, before: { assigned_member_id:current.assignedMemberId, starts_at: current.startsAt, ends_at: current.endsAt, party_size: current.partySize }, after: destination ? { starts_at: destination.startsAt, ends_at: destination.endsAt ?? new Date(Date.parse(destination.startsAt) + Date.parse(current.endsAt) - Date.parse(current.startsAt)).toISOString(), party_size: proposal.after.partySize } : null }), resultId, thread.id, now, now,
        thread.id, thread.organization_id, current.updatedAt],
    }

    const guard = `EXISTS (SELECT 1 FROM activity_entries WHERE id = ?)`
    const movedBookingId = destination?.claim && current.recordKind === 'booking' ? current.recordId : null

    const queries: BatchQuery[] = []
    if (destination?.claim) {
      // Move the canonical record and append the decision in one batch. A
      // failed allocation changes no row, so changes() cannot record acceptance.
      queries.push(await destination.claim(current.recordId, now))
      queries.push(current.recordKind === 'booking' ? {
        ...entryInsert,
        query: entryInsert.query.replace('AND source.updated_at = ?', 'AND source.updated_at = ? AND changes() = 1').replace("'guest', ?, ?, ?, ?,", "'guest', ?, ?, json_set(?, '$.after.assigned_member_id', (SELECT assigned_member_id FROM bookings WHERE id=?)), ?,"),
        params: [...entryInsert.params!.slice(0,5), current.recordId, ...entryInsert.params!.slice(5)],
      } : { ...entryInsert, query: entryInsert.query.replace('AND source.updated_at = ?', 'AND source.updated_at = ? AND changes() = 1') })
    } else {
      queries.push(entryInsert)
    }
    if (destination) {
      queries.push({
        query: `UPDATE requests SET updated_at = ?, payload_json = json_set(payload_json, '$.party_size_is_minimum', json('false'))
                 WHERE id = ? AND organization_id = ? AND ${guard}`,
        params: [now, thread.id, thread.organization_id, id],
      })
    }

    if(destination && movedBookingId && destination.sessionId) queries.push(sessionAssignmentQuery(destination.sessionId,thread.organization_id,movedBookingId))
    await executeBatch(db, queries, { operation: 'respond to booking change' })
    result = await findEntryByDedupeKey(db, resultId)
    if (!result) {
      throw new HTTPError({ statusCode: 409, message: current.recordKind === 'booking' ? 'That session filled up or the booking changed; your original appointment is unchanged' : 'This reservation changed or is no longer available' })
    }
  }

  // Resolved once and returned, so the guest-facing page names the booking with
  // the same word as the email it arrived from.
  const noun = await bookingNoun(db, thread as GuestThreadRow)
  const summary = await sourceSummary(db, thread as GuestThreadRow)
  if (result && input.decision) {
    const accepted = result.event_name === 'booking_change.accepted'
    await deliverEmail(db, env, thread as GuestThreadRow, result.id, accepted ? 'accepted' : 'declined', proposal, noun)
    await updateThreadProjectionIfLatestEntry(db, thread.id, result.id, { conversationState: 'resolved' })
    if (!result.payload_json) throw new Error('A booking change answer has no recorded payload')
    const answered = JSON.parse(result.payload_json) as { operational_booking_id?: unknown }
    if (thread.kind === 'booking' && typeof answered.operational_booking_id === 'string') {
      await recordBookingChangeAnswer(db, { organizationId: thread.organization_id, bookingId: answered.operational_booking_id, changeRequestId: entry.id, accepted })
    }
  }
  const guest = await changePresentation(db, thread as GuestThreadRow, proposal)
  return {
    type: thread.kind, noun, guestName: summary.guestName, locale: guest.locale, vertical: guest.vertical,
    before: guest.before, after: guest.after,
    locationTitle: guest.locationTitle, originalLocationTitle: guest.originalLocationTitle,
    status: result ? result.event_name === 'booking_change.accepted' ? 'accepted' : 'declined' : 'pending',
  }
}
