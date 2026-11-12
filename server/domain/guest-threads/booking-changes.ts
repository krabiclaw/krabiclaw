import { recordBookingChangeAnswer } from '~/server/domain/booking-analytics'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { HTTPError } from 'nitro'
import { z } from 'zod'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertBookingBatchWrite, bookingBatchWriteRefused, partyPaysOnline, partySizeRefusal, requireBookingConfig, resolveBookingSession, sessionMoveQuery, sessionAllocationPredicate } from '~/server/utils/availability'
import { readTimedBookingPrice } from '~/server/domain/bookings'
import { isCurrencyCode } from '~/shared/currencies'
import { formatTimestamp } from '~/utils/timezone'
import { assertResourceAccess, assertAssignedBookingAccess, resolveOrganizationMembership, memberAccessPrincipal } from '~/server/utils/member-access'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import type { CloudflareEnv } from '~/server/utils/auth'
import { guestPresentation, notifyBookingChangeOwner } from '~/server/utils/notifications'
import { platformLocale } from '~/shared/platform-locales'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { formatTenantLocalePath } from '~/utils/tenant-locale-path'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { CURRENT_GUEST_SQL, MessageStateConflictError, appendMessage, findMessageByDedupeKey, getMessage, messageQueries, type MessageRow } from '~/server/domain/conversations'
import { createDeliveryReceipt, deliverGuestThreadEmail, isDeliverySent } from './deliveries'
import { getEmailDeliveryMode } from '~/server/utils/email-delivery'
import { renderNotificationEmail } from '~/server/emails/render'
import { bookingChangeProposalMessage } from '~/server/notifications/guest-events'
import { occurrenceChangeDifferences } from '~/server/notifications/events'
import { organizationLogo } from '~/server/notifications/hero'
import { getPlatformDomain, buildBuyerRequestActivityUrl } from '~/server/utils/dashboard-notification-links'
import { bookingChangeStates, type BookingChangeStatus } from './booking-change-state'
import { isStayChangeRequest, stayChangeView } from './stay-change-requests'
import { conversationTaskQueries, reconcileConversationTasks } from './repository'
import { getGuestRequest, getThreadOperationalRecord, readBookedRecord, requestSummary } from '~/server/domain/requests'
import type { StayAccess } from '~/server/domain/stays'
import type { GuestThreadRow } from './types'
import type { ProductKind } from '~/shared/product-details'

/**
 * Guest-facing copy uses the tenant's own word for the booking, resolved from
 * the same table the dashboard reads. Deriving it here from submission_type
 * alone told a professional-services client's guest about their "booking" while
 * every screen their host saw said consultation.
 */
async function bookingNoun(db: DbClient, thread: Pick<GuestThreadRow, 'id' | 'organization_id'>): Promise<string> {
	const booked = await queryFirst<{ vertical: string; kind: ProductKind }>(db, `SELECT o.vertical, p.kind FROM organization o JOIN conversations c ON c.organization_id = o.id
	  JOIN bookings b ON b.id = c.booking_id AND b.organization_id = o.id JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
	  WHERE o.id = ? AND c.id = ? LIMIT 1`, [thread.organization_id, thread.id])
	if (!booked) throw new HTTPError({ statusCode: 409, message: 'This conversation has no booking to change', data: { code: 'BOOKING_CHANGE_UNSUPPORTED', field: 'kind' } })
	return resolveBookingPresentation(booked.kind, booked.vertical).noun
}

/**
 * A change names a destination occurrence and party size. A table booking
 * may move to a seating of the same business's tables at another location.
 */
const fieldsSchema = z.object({ kind: z.literal('booking'), product_session_id: z.string().min(1).max(64), party_size: z.number().int().min(1).max(99), product_id: z.string().min(1).max(64).optional() })
const changeInputSchema = fieldsSchema.partial({ kind: true, party_size: true }).extend({ version: z.number().int().min(1) })
const sourceSchema = z.object({
  recordKind: z.literal('booking'),
  assignedMemberId: z.string().nullable().default(null),
  sessionId: z.string().nullable().optional(),
  recordId: z.string(),
  status: z.string(),
  partySize: z.number().int(),
  startsAt: z.string(),
  endsAt: z.string(),
  timezone: z.string(),
  locationId: z.string().nullable(),
  productId: z.string().nullable(),
  partySizeIsMinimum: z.boolean(),
  guest: z.object({ name: z.string(), email: z.string(), phone: z.string().nullable() }),
})
const proposalSchema = z.object({
  before: sourceSchema, after: fieldsSchema, version: z.number().int().optional(), updated_at: z.string().optional(),
  locationTitle: z.string(), originalLocationTitle: z.string(), afterLabel: z.string(),
  // Written since the WhatsApp template gained real date and time slots.
  // Proposals recorded before that are immutable facts without them, and the
  // send falls back to the template's own placeholders for those.
  afterDate: z.string().optional(), afterTime: z.string().optional(),
  beforeAssignedMemberName: z.string().nullable().optional(), afterAssignedMemberId: z.string().nullable().optional(), afterAssignedMemberName: z.string().nullable().optional(),
  afterStartsAt: z.string().optional(), afterEndsAt: z.string().optional(), afterTimezone: z.string().optional(), afterLocationId: z.string().nullable().optional(),
})
type Fields = z.infer<typeof fieldsSchema>
type Source = z.infer<typeof sourceSchema> & { version: number }
type ChangeEnv = CloudflareEnv

async function sourceSummary(db: DbClient, thread: GuestThreadRow) {
  if (thread.kind !== 'booking') throw new HTTPError({ statusCode: 400, message: 'This conversation has no changeable booking', data: { code: 'BOOKING_CHANGE_UNSUPPORTED', field: 'kind' } })
  const summary = await requestSummary(db, thread)
  const { name, email } = thread.payload.guest
  if (name === null || email === null) throw new HTTPError({ statusCode: 400, message: 'This conversation has no changeable booking', data: { code: 'BOOKING_CHANGE_UNSUPPORTED', field: 'guest' } })
  return { ...summary, guestName: name, guestEmail: email }
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
 * Read from the booking, never from the thread: the thread stopped holding a
 * copy of the occurrence. A guest writing in the conversation leaves the
 * booking version alone, so the business can still propose a change.
 */
async function loadSource(db: DbClient, thread: GuestThreadRow): Promise<Source> {
  if (thread.kind === 'contact') throw new HTTPError({ statusCode: 400, message: 'This conversation is not a booking' })
  const record = await getThreadOperationalRecord(db, thread.id)
  if (!record) throw new HTTPError({ statusCode: 409, message: 'This conversation has no booking to change' })
  // A stay's dates and party are changed on the stay itself, not proposed through its thread.
  if (record.unit === 'nights') throw new HTTPError({ statusCode: 400, message: 'Change a stay from the stay itself' })
  const { name, email, phone } = thread.payload.guest
  if (name === null || email === null) throw new HTTPError({ statusCode: 409, message: 'This conversation has no booking to change' })
  const booking = await queryFirst<{ product_session_id: string }>(db, 'SELECT product_session_id FROM bookings WHERE id=? AND organization_id=? AND version=?', [record.id, thread.organization_id, record.version])
  if (!booking) throw new HTTPError({ statusCode: 409, message: 'The booking changed while its current state was being read. Reload and try again.' })
  return {
    assignedMemberId: record.assigned_member_id, sessionId: booking.product_session_id,
    recordKind: 'booking', recordId: record.id, status: record.status, partySize: record.party_size,
    startsAt: record.starts_at, endsAt: record.ends_at, timezone: record.timezone,
    locationId: record.location_id, productId: record.product_id,
    version: record.version, partySizeIsMinimum: record.party_size_is_minimum, guest: { name, email, phone },
  }
}

/** The booking still matches the version the change was made from. */
function sourceGuard(thread: GuestThreadRow, before: Source): BatchQuery {
  return { query: `EXISTS (SELECT 1 FROM bookings operational
      WHERE operational.id=? AND operational.organization_id=? AND operational.id=(SELECT booking_id FROM conversations WHERE id=?) AND operational.status=? AND operational.party_size=? AND operational.version=?
        AND operational.product_session_id=? AND operational.starts_at=? AND operational.ends_at=? AND operational.timezone=? AND operational.location_id IS ?)`,
    params: [before.recordId, thread.organization_id, thread.id, before.status, before.partySize, before.version, before.sessionId, before.startsAt, before.endsAt, before.timezone, before.locationId] }
}

function attorneyEligibility(organizationId: string, memberId: string | null): BatchQuery {
  return { query: "EXISTS (SELECT 1 FROM member m JOIN user u ON u.id=m.userId JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId WHERE m.id=? AND m.organizationId=? AND u.emailVerified=1 AND ms.public_approved=1 AND length(trim(ms.public_name))>0)", params: [memberId, organizationId] }
}

interface Destination { assignedMemberId: string | null; locationId: string | null; title: string; label: string; date: string; time: string; startsAt: string; timezone: string; endsAt: string; claim: (bookingId: string, now: string, writeGuard?: BatchQuery) => Promise<BatchQuery[]> }

/**
 * Check that the proposed target can actually take this party, and return the
 * statement that claims it: the session claim, carrying its own capacity
 * predicate so the seat is taken atomically with the release of the old one.
 *
 * The target is a session of the booked product, or, for a table, a seating of
 * the same business's tables at another location. A paid booking keeps its
 * quantity and location; an unpaid one may not become a booking that has to be
 * paid for online.
 */
async function validateDestination(db: DbClient, env: CloudflareEnv, thread: GuestThreadRow, before: Source, after: Fields, actorId: string, decisionDedupeKey?: string): Promise<Destination> {
  if (!before.productId) throw new Error('A booking has no product')
  const productId = after.product_id ?? (after.product_session_id.startsWith('p.')
    ? before.productId
    : (await queryFirst<{ product_id: string }>(db, 'SELECT product_id FROM product_sessions WHERE id=? AND organization_id=?', [after.product_session_id, thread.organization_id]))?.product_id)
  const targetProduct = productId && await queryFirst<{ kind: ProductKind; source_kind: ProductKind }>(db, `SELECT p.kind, source.kind AS source_kind FROM products p
      JOIN products source ON source.id=? AND source.organization_id=p.organization_id
     WHERE p.id=? AND p.organization_id=?`, [before.productId, productId, thread.organization_id])
  // A class moves within its own sessions; a table to any seating of the business's tables.
  if (!productId || !targetProduct || (productId !== before.productId && !(targetProduct.kind === 'table' && targetProduct.source_kind === 'table'))) throw new HTTPError({ statusCode: 409, message: 'That session is not open for booking' })
  const now = new Date().toISOString()
  const resolved = await resolveBookingSession(db, { env, organizationId: thread.organization_id, productId, sessionId: after.product_session_id, actorId, now })
  const target = resolved.session
  const service = targetProduct.kind === 'service'
  const config = await requireBookingConfig(db, thread.organization_id, productId)
  const partyRefusal = partySizeRefusal(config, after.party_size)
  if (partyRefusal) throw new HTTPError({ statusCode: 409, message: partyRefusal, data: { code: 'party_size_unavailable', field: 'party_size' } })
  const eligibility = attorneyEligibility(thread.organization_id, config.assigned_member_id)
  if (service && !await queryFirst(db, `SELECT 1 WHERE ${eligibility.query}`, eligibility.params)) throw new HTTPError({ statusCode: 409, message: 'The attorney needs a verified account and an approved public profile' })
  const allocation = await sessionAllocationPredicate(db, { env, organizationId: thread.organization_id, productId, sessionId: target.id, partySize: after.party_size, replacingBookingId: before.recordId, now, resolved, preview: true })
  if (!await queryFirst(db, `SELECT 1 WHERE ${allocation.query}`, allocation.params)) throw new HTTPError({ statusCode: 409, message: service ? 'The proposed consultation time or attorney is no longer available' : 'That session filled up or is no longer available' })
  const booking = await queryFirst<{ product_variant_id: string }>(db, 'SELECT product_variant_id FROM bookings WHERE id = ? AND organization_id = ?', [before.recordId, thread.organization_id])
  if (!booking) throw new HTTPError({ statusCode: 409, message: 'The original booking is missing' })
  const paid = await queryFirst(db, "SELECT id FROM payments WHERE organization_id=? AND subject_type='booking' AND subject_id=? AND captured_amount>refunded_amount LIMIT 1", [thread.organization_id, before.recordId])
  if (paid && (after.party_size !== before.partySize || target.location_id !== before.locationId)) throw new HTTPError({ statusCode: 409, message: 'Refund the paid booking before changing its quantity or location' })
  // The booking keeps its option; at another location's tables it takes that product's one option.
  let variantId = booking.product_variant_id
  if (productId !== before.productId) {
    const variants = await queryAll<{ id: string }>(db, 'SELECT id FROM product_variants WHERE organization_id = ? AND product_id = ? AND active = 1', [thread.organization_id, productId])
    if (variants.length !== 1) throw new HTTPError({ statusCode: 409, message: 'Those tables have no single bookable option' })
    variantId = variants[0]!.id
  }
  if (!paid && partyPaysOnline(config, after.party_size)) {
    const organization = await queryFirst<{ slug: string; default_currency: string }>(db, 'SELECT slug, default_currency FROM organization WHERE id = ?', [thread.organization_id])
    if (!organization || !isCurrencyCode(organization.default_currency)) throw new Error('The booking organization or its currency is missing')
    const price = await readTimedBookingPrice(db, { organizationId: thread.organization_id, variantId, currency: organization.default_currency, locationId: target.location_id, now })
    if (!price) throw new HTTPError({ statusCode: 409, message: 'A current one-time price is required for this offering', data: { code: 'price_unavailable' } })
    if (price.unit_amount > 0) throw new HTTPError({ statusCode: 409, message: 'This change needs an online payment before it can replace the current booking', data: { code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(organization.slug)}/bookings/${encodeURIComponent(before.recordId)}` } })
  }
  const location = target.location_id
    ? await queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE id = ? AND organization_id = ?', [target.location_id, thread.organization_id])
    : null
  return {
    assignedMemberId: config.assigned_member_id, locationId: target.location_id, title: location?.title ?? '',
    startsAt: target.starts_at, endsAt: target.ends_at, timezone: target.timezone, ...localParts(target.starts_at, target.timezone),
    // The same Booking moves under the shared allocation predicate. Exclude
    // its existing allocation; a full destination leaves the record unchanged.
    claim: async (bookingId, now, writeGuard) => {
      const guarded: BatchQuery = { query: `product_session_id = ? AND party_size = ? AND status = ? AND version = ?
        AND starts_at=? AND ends_at=? AND timezone=? AND location_id IS ?
        AND EXISTS (SELECT 1 FROM product_sessions target WHERE target.id=? AND target.organization_id=? AND target.starts_at=? AND target.ends_at=? AND target.timezone=? AND target.location_id IS ?)
        AND EXISTS (SELECT 1 FROM product_booking_configs target_config WHERE target_config.organization_id=bookings.organization_id AND target_config.product_id=? AND target_config.assigned_member_id IS ? AND target_config.scheduling_mode=?)
        AND (${service ? eligibility.query : '1'}) AND (${writeGuard?.query ?? '1'})`,
        params: [before.sessionId, before.partySize, before.status, before.version, before.startsAt, before.endsAt, before.timezone, before.locationId, target.id, thread.organization_id, target.starts_at, target.ends_at, target.timezone, target.location_id, productId, config.assigned_member_id, config.scheduling_mode, ...(service ? eligibility.params! : []), ...(writeGuard?.params ?? [])] }
      const move = await sessionMoveQuery(db, {
        env, bookingId, organizationId: thread.organization_id, fromProductId: before.productId!, productId, productVariantId: variantId,
        sessionId: target.id, partySize: after.party_size, replacingBookingId: before.recordId, writeGuard: guarded, resolved,
        requireUndecided: { requestId: thread.id, organizationId: thread.organization_id, decisionDedupeKey: decisionDedupeKey ?? '' }, now,
      })
      return [...resolved.preceding, move]
    },
  }
}

/** The booking's own location and the one it would move to are both within the member's reach. */
async function assertChangeLocations(db: DbClient, env: CloudflareEnv, membership: NonNullable<Awaited<ReturnType<typeof resolveOrganizationMembership>>>, before: Source, afterLocationId: string | null): Promise<void> {
  for (const locationId of new Set([before.locationId, afterLocationId].filter((value): value is string => Boolean(value)))) {
    await assertResourceAccess(db, { ...memberAccessPrincipal(membership, { env }), resourceLocationId: locationId })
  }
}

async function proposalLocation(db: DbClient, thread: GuestThreadRow, proposal: z.infer<typeof proposalSchema>): Promise<string | null> {
  if (proposal.afterLocationId !== undefined) return proposal.afterLocationId
  const target = await queryFirst<{ location_id: string | null }>(db, 'SELECT location_id FROM product_sessions WHERE id=? AND organization_id=?', [proposal.after.product_session_id, thread.organization_id])
  if (!target) throw new HTTPError({ statusCode: 409, message: 'The proposal destination is missing' })
  return target.location_id
}

/** Change the booking through its inventory transaction and publish the resulting conversation. */
export async function changeBooking(db: DbClient, env: CloudflareEnv, input: {
  organizationId: string; bookingId: string; actorUserId: string; body: Record<string, unknown>; apply: boolean
  idempotencyKey?: string; stayAccess?: StayAccess
}) {
  const record = await readBookedRecord(db, input.organizationId, input.bookingId)
  if (!record) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  if (record.unit === 'nights') {
    if (input.stayAccess?.organizationId !== input.organizationId || input.stayAccess.actorId !== input.actorUserId) {
      throw new HTTPError({ statusCode: 403, message: 'Organization access required' })
    }
    if (!input.apply || input.body.product_session_id !== undefined) {
      throw new HTTPError({ statusCode: 422, message: 'A stay can be moved by the business to new dates or a different home' })
    }
    const { moveStay, updateStay } = await import('~/server/domain/stays')
    if (input.body.product_id !== undefined && input.body.product_id !== record.product_id) {
      if (input.body.check_in_date !== undefined || input.body.check_out_date !== undefined) {
        throw new HTTPError({ statusCode: 422, message: 'Choose either new dates or a different home' })
      }
      const stay = await moveStay(db, env, input.stayAccess, input.bookingId, { version: input.body.version, product_id: input.body.product_id })
      return { kind: 'stay' as const, stay, scheduledMessageId: stay.scheduled_message_id }
    }
    if (input.body.check_in_date === undefined && input.body.check_out_date === undefined) {
      throw new HTTPError({ statusCode: 422, message: 'Choose new dates or a different home' })
    }
    const stay = await updateStay(db, env, input.stayAccess, input.bookingId, { ...input.body, version: input.body.version })
    return { kind: 'stay' as const, stay, scheduledMessageId: null }
  }
  const key = input.idempotencyKey?.trim()
  if (!key || key.length > 100) throw new HTTPError({ statusCode: 400, message: 'Request key is required' })
  const thread = record.conversation_id && await getGuestRequest(db, record.conversation_id, input.organizationId, 'booking')
  if (!thread) throw new HTTPError({ statusCode: 409, message: 'The booking conversation is missing' })
  const change = input.apply
    ? await moveBooking(db, env, thread, { userId: input.actorUserId }, input.body, key)
    : await requestBookingChange(db, env, thread, input.actorUserId, input.body, key)
  await publishConversationEvent(env, db, { conversationId: thread.id, type: 'MESSAGE_CREATE' })
  return { kind: 'booking' as const, conversationId: thread.id, ...change }
}

function linkToken(env: ChangeEnv, threadId: string, requestId: string) {
  if (!env.EMAIL_REPLY_SECRET) throw new HTTPError({ statusCode: 503, message: 'Guest email signing is not configured' })
  return createHmac('sha256', env.EMAIL_REPLY_SECRET).update(`booking-change:v1:${threadId}:${requestId}`).digest('hex')
}

async function assignedMemberName(db: DbClient, organizationId: string, memberId: string | null | undefined): Promise<string | null> {
  if (!memberId) return null
  const member = await queryFirst<{ name: string }>(db, 'SELECT CASE WHEN ms.public_approved=1 THEN ms.public_name ELSE u.name END name FROM member m JOIN user u ON u.id=m.userId LEFT JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId WHERE m.id=? AND m.organizationId=?', [memberId, organizationId])
  if (!member?.name?.trim()) throw new HTTPError({ statusCode: 409, message: 'The assigned attorney identity is unavailable' })
  return member.name
}

async function changePresentation(db: DbClient, thread: GuestThreadRow, proposal: z.infer<typeof proposalSchema>) {
  const organization = await queryFirst<{ name: string; vertical: string | null }>(db, 'SELECT name, vertical FROM organization WHERE id = ?', [thread.organization_id])
  if (!organization?.name) throw new HTTPError({ statusCode: 409, message: 'Organization name is not configured' })
  // Keep the proposed instant immutable. Older entries are rendered from their
  // canonical target only while it still agrees with the recorded label.
  let startsAt = proposal.afterStartsAt
  let timezone = proposal.afterTimezone
  let locationId = proposal.afterLocationId !== undefined ? proposal.afterLocationId : proposal.before.locationId
  if (!startsAt || !timezone) {
    const target = await queryFirst<{ starts_at: string; timezone: string; location_id: string | null }>(db,
      'SELECT starts_at, timezone, location_id FROM product_sessions WHERE id = ? AND organization_id = ?',
      [proposal.after.product_session_id, thread.organization_id])
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
  const beforeAssignedMemberName = proposal.beforeAssignedMemberName !== undefined ? proposal.beforeAssignedMemberName : await assignedMemberName(db, thread.organization_id, proposal.before.assignedMemberId)
  const afterAssignedMemberId = proposal.afterAssignedMemberId !== undefined ? proposal.afterAssignedMemberId : null
  const afterAssignedMemberName = proposal.afterAssignedMemberName !== undefined ? proposal.afterAssignedMemberName : await assignedMemberName(db, thread.organization_id, afterAssignedMemberId)
  const labels = platformLocale(guest.locale)!.messages
  const copy = getVerticalCopy(organization.vertical, guest.locale)
  return {
    ...guest, fromName: organization.name, vertical: organization.vertical, labels, copy,
    before: { assigned_member_id: proposal.before.assignedMemberId, assigned_member_name: beforeAssignedMemberName, when_label: formatTimestamp(proposal.before.startsAt, guest.locale, proposal.before.timezone, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }), party_size: proposal.before.partySize },
    after: { assigned_member_id: afterAssignedMemberId, assigned_member_name: afterAssignedMemberName, when_label: formatTimestamp(startsAt, guest.locale, timezone, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }), party_size: proposal.after.party_size },
    location_title: guest.locationName?.trim() || labels['booking.online']!, original_location_title: original.locationName?.trim() || labels['booking.online']!,
    afterStartsAt: startsAt, afterTimezone: timezone,
  }
}

async function deliverEmail(db: DbClient, env: ChangeEnv, thread: GuestThreadRow, entryId: string, proposalEntryId: string, status: 'requested' | 'accepted' | 'declined' | 'moved', proposal: z.infer<typeof proposalSchema>, noun: string) {
  const summary = await sourceSummary(db, thread)
  if (!summary.guestEmail) throw new HTTPError({ statusCode: 400, message: 'Guest email is required' })
  const guest = await changePresentation(db, thread, proposal)
  const subject = guest.labels[`booking.change_${status === 'requested' ? 'review' : status}`]!
  const actionUrl = status === 'requested'
    ? new URL(formatTenantLocalePath(`/booking-changes/${thread.id}/${entryId}`, guest.locale, 'en'), env.NUXT_PUBLIC_PLATFORM_DOMAIN)
    : null
  if (actionUrl) actionUrl.hash = linkToken(env, thread.id, entryId)
  const delivery = await createDeliveryReceipt(db, {
    subject: { messageId: entryId },
    channel: 'email',
    provider: getEmailDeliveryMode(env) === 'provider' ? 'resend' : 'log_only',
    purpose: 'status_update',
    idempotencyKey: `booking-change:${entryId}`,
  })
  // What is booked beside what the change makes it: one row where a detail
  // stays the same, the before and the proposed where it changes.
  const rows: [string, string][] = []
  const compare = (label: string, before: string | null, after: string | null) => {
    if (before === after) { if (after !== null) rows.push([label, after]) }
    else {
      if (before !== null) rows.push([`${guest.labels['booking.change_before']} · ${label}`, before])
      if (after !== null) rows.push([`${guest.labels['booking.change_proposed']} · ${label}`, after])
    }
  }
  if (status !== 'declined') {
    compare(guest.copy.dateLabel, guest.before.when_label, guest.after.when_label)
    compare(guest.copy.assigneeLabel, guest.before.assigned_member_name, guest.after.assigned_member_name)
    compare(guest.copy.locationLabel, guest.original_location_title, guest.location_title)
    compare(guest.copy.guestsLabel, String(guest.before.party_size), String(guest.after.party_size))
  }
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
      intro: guest.labels[`booking.change_${status === 'requested' ? 'pending' : status === 'declined' ? 'unchanged' : status === 'moved' ? 'moved_detail' : 'updated'}`]!,
      rows,
      manageUrl: await buildBuyerRequestActivityUrl(env, db, { organizationId: thread.organization_id, threadId: thread.id }),
      actionUrl: actionUrl?.href ?? null,
      actionLabel: actionUrl ? guest.labels['booking.change_review']! : null,
    }), { platformDomain: getPlatformDomain(env) }),
    conversationId: thread.id,
  })
  if (!isDeliverySent(sent)) throw new HTTPError({ statusCode: 502, message: sent.error || 'Guest email delivery has not been confirmed. Review the recorded delivery outcome.', data: { code: 'DELIVERY_INCOMPLETE', field: 'delivery', delivery_id: sent.id, delivery_status: sent.status } })
  // A move is the business's own doing; the guest is told, the owners already know.
  if (status === 'moved') return
  // A pending proposal names the member who just made it; an answer names the guest who gave it.
  const proposer = status === 'requested'
    ? await queryFirst<{ name: string | null }>(db, 'SELECT u.name FROM messages e JOIN user u ON u.id = e.author_user_id WHERE e.id = ? AND e.conversation_id = ?', [proposalEntryId, thread.id])
    : null
  if (status === 'requested' && !proposer?.name?.trim()) throw new HTTPError({ statusCode: 409, message: 'The member who proposed this change has no name to show the owners', data: { code: 'CHANGE_PROPOSER_UNKNOWN', field: 'author_user_id', entry_id: proposalEntryId } })
  // The owners read English, in each occurrence's own zone.
  const booked = await queryFirst<{ kind: ProductKind }>(db, 'SELECT kind FROM products WHERE id = ? AND organization_id = ?', [proposal.before.productId, thread.organization_id])
  if (!booked) throw new Error('The changed booking names no product')
  const presentation = resolveBookingPresentation(booked.kind, guest.vertical)
  const ownerCopy = getVerticalCopy(guest.vertical, 'en')
  const [before, after] = [localParts(proposal.before.startsAt, proposal.before.timezone), localParts(guest.afterStartsAt, guest.afterTimezone)]
  const offering = proposal.before.productId ? await queryFirst<{ name: string }>(db, 'SELECT name FROM products WHERE id = ? AND organization_id = ?', [proposal.before.productId, thread.organization_id]) : null
  const current = { date: before.date, time: before.time, nights: null, total: null, partySize: presentation.formatCount(proposal.before.partySize),
    location: proposal.originalLocationTitle || 'Online', assignee: guest.before.assigned_member_name }
  const requested = { date: after.date, time: after.time, nights: null, total: null, partySize: presentation.formatCount(proposal.after.party_size),
    location: proposal.locationTitle || 'Online', assignee: guest.after.assigned_member_name }
  await notifyBookingChangeOwner(env, db, {
    organizationId: thread.organization_id, organizationName: guest.fromName,
    threadId: thread.id, submissionType: 'booking', submissionId: thread.id, messageId: entryId,
    vertical: guest.vertical,
    locationId: status === 'declined' ? proposal.before.locationId : proposal.afterLocationId !== undefined ? proposal.afterLocationId : proposal.before.locationId,
    assignment: thread.kind === 'booking' && proposal.beforeAssignedMemberName !== undefined && proposal.afterAssignedMemberId !== undefined && proposal.afterAssignedMemberName !== undefined
      ? { beforeMemberId: proposal.before.assignedMemberId, beforeName: proposal.beforeAssignedMemberName, afterMemberId: proposal.afterAssignedMemberId, afterName: proposal.afterAssignedMemberName, label: ownerCopy.assigneeLabel } : undefined,
    change: {
      recordKind: noun, offering: offering?.name ?? null, channel: null, guestName: summary.guestName, requestedBy: { kind: 'business', name: proposer?.name ?? null }, status,
      assigneeLabel: ownerCopy.assigneeLabel, current, requested,
      differences: occurrenceChangeDifferences(current, requested, { party: presentation.partyLabel, assignee: ownerCopy.assigneeLabel }),
    },
  })
}

/** A proposal is an immutable fact in the existing conversation, not a second booking record. */
export async function requestBookingChange(db: DbClient, env: CloudflareEnv, thread: GuestThreadRow, actorUserId: string, body: unknown, idempotencyKey: string) {
  const parsed = changeInputSchema.safeParse(body)
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'Valid change details and the booking version are required' })
  const { version } = parsed.data
  const before = await loadSource(db, thread)
  const summary = await sourceSummary(db, thread)
  const membership = await resolveOrganizationMembership(env, { organizationId: thread.organization_id, userId: actorUserId })
  if (!membership) throw new HTTPError({ statusCode: 403, message: 'Organization access required' })
  await assertAssignedBookingAccess(db, { ...memberAccessPrincipal(membership, { env }), bookingId: before.recordId })
  const externalId = `booking-change-request:${thread.id}:${idempotencyKey}`
  let entry = await findMessageByDedupeKey(db, externalId)
  if (entry) {
    const previous = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
    const after = fieldsSchema.parse({ ...parsed.data, kind: 'booking', party_size: parsed.data.party_size ?? previous.before.partySize })
    if (JSON.stringify(previous.after) !== JSON.stringify(after) || (previous.version !== undefined && previous.version !== version)) throw new HTTPError({ statusCode: 409, message: 'Request key was reused for different changes' })
    await assertChangeLocations(db, env, membership, before, await proposalLocation(db, thread, previous))
    const decision = await findMessageByDedupeKey(db, `booking-change-decision:${entry.id}`)
    if (decision) {
      if (decision.event_name === 'booking_change.accepted') return { changeStatus: 'accepted' as const }
      if (decision.event_name === 'booking_change.declined') return { changeStatus: 'declined' as const }
      throw new HTTPError({ statusCode: 500, message: 'Booking change decision is invalid' })
    }
  } else {
    if (!['pending', 'confirmed'].includes(before.status)) throw new HTTPError({ statusCode: 409, message: 'This booking can no longer be changed' })
    if (before.endsAt <= new Date().toISOString()) throw new HTTPError({statusCode:409,message:'This visit has ended and cannot be rescheduled'})
    if (before.version !== version) throw new HTTPError({ statusCode: 409, message: 'The booking changed. Reload before sending a request.' })
    const after = fieldsSchema.parse({ ...parsed.data, kind: 'booking', party_size: parsed.data.party_size ?? before.partySize })
    const destination = await validateDestination(db, env, thread, before, after, actorUserId)
    await assertChangeLocations(db, env, membership, before, destination.locationId)
    // Moving a table booking to another branch at the same time for the same
    // party is a change; comparing only the label and the party size rejected it.
    if (destination.startsAt === before.startsAt && destination.endsAt === before.endsAt && destination.timezone === before.timezone
      && after.party_size === before.partySize
      && destination.locationId === before.locationId) {
      throw new HTTPError({ statusCode: 400, message: 'Choose at least one change' })
    }
    const original = before.locationId
      ? await queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE id = ? AND organization_id = ?', [before.locationId, thread.organization_id])
      : null
    // Validate delivery configuration before persisting a proposal.
    linkToken(env, thread.id, 'configuration-check')
    if (!summary.guestEmail || !env.NUXT_PUBLIC_PLATFORM_DOMAIN) throw new HTTPError({ statusCode: 503, message: 'Guest email delivery is not configured' })
    const unchanged = sourceGuard(thread, before)
    entry = await appendMessage(db, { guard: { sql: unchanged.query, params: unchanged.params ?? [] }, conversationId: thread.id, authorKind: 'krabiclaw', authorUserId: actorUserId,
      eventName: 'booking_change.requested', dedupeKey: externalId,
      body: `Requested ${destination.label} for ${after.party_size} guests${destination.title ? ` at ${destination.title}` : ''}.`,
      payload: { before: sourceSchema.parse(before), after, version: before.version,
        beforeAssignedMemberName: await assignedMemberName(db, thread.organization_id, before.assignedMemberId), afterAssignedMemberId: destination.assignedMemberId ?? null, afterAssignedMemberName: await assignedMemberName(db, thread.organization_id, destination.assignedMemberId),
        locationTitle: destination.title, originalLocationTitle: original?.title ?? '', afterLabel: destination.label,
        afterDate: destination.date, afterTime: destination.time, afterStartsAt: destination.startsAt, afterEndsAt: destination.endsAt, afterTimezone: destination.timezone, afterLocationId: destination.locationId },
    }).catch((error: unknown) => {
      if (error instanceof MessageStateConflictError) throw new HTTPError({ statusCode: 409, message: 'The consultation changed. Reload before sending a new request.', cause: error })
      throw error
    })
  }
  const noun = await bookingNoun(db, thread)
  const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
  const state = (await bookingChangeStates(db, [entry.id])).get(entry.id)
  if (!state) throw new Error('The booking change proposal disappeared')
  if (state.status === 'accepted' || state.status === 'declined') return { changeStatus: state.status }
  if (state.status === 'stale' || state.status === 'expired') throw new HTTPError({ statusCode: state.status === 'expired' ? 410 : 409, message: state.message })
  await deliverEmail(db, env, thread, entry.id, entry.id, 'requested', proposal, noun)
  await reconcileConversationTasks(db, thread.id)
  const decision = await findMessageByDedupeKey(db, `booking-change-decision:${entry.id}`)
  if (decision) {
    if (decision.event_name === 'booking_change.accepted') return { changeStatus: 'accepted' as const }
    if (decision.event_name === 'booking_change.declined') return { changeStatus: 'declined' as const }
    throw new HTTPError({ statusCode: 500, message: 'Booking change decision is invalid' })
  }
  return { changeStatus: 'awaiting_guest_acceptance' as const }
}

/**
 * Move a booking now, without a proposal: the business's own
 * change, from its dashboard or ChatGPT. The destination passes the same
 * checks as a proposal; the guest is told the new time rather than asked.
 * Refused — a 409 naming why — when the change needs the guest's consent or
 * the destination cannot take the party, and then nothing has moved.
 */
export async function moveBooking(db: DbClient, env: CloudflareEnv, thread: GuestThreadRow, actor: { userId: string }, body: unknown, idempotencyKey: string) {
  const parsed = changeInputSchema.safeParse(body)
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'Valid change details and the booking version are required' })
  const before = await loadSource(db, thread)
  if (before.productId && await queryFirst(db, "SELECT 1 FROM products WHERE id=? AND organization_id=? AND kind='service'", [before.productId, thread.organization_id])) {
    return requestBookingChange(db, env, thread, actor.userId, parsed.data, idempotencyKey)
  }
  const summary = await sourceSummary(db, thread)
  const membership = await resolveOrganizationMembership(env, { organizationId: thread.organization_id, userId: actor.userId })
  if (!membership) throw new HTTPError({ statusCode: 403, message: 'Organization access required' })
  await assertAssignedBookingAccess(db, { ...memberAccessPrincipal(membership, { env }), bookingId: before.recordId })
  const dedupeKey = `booking-change-move:${thread.id}:${idempotencyKey}`
  let entry = await findMessageByDedupeKey(db, dedupeKey)
  if (entry) {
    const previous = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
    const after = fieldsSchema.parse({ ...parsed.data, kind: 'booking', party_size: parsed.data.party_size ?? previous.before.partySize })
    if (JSON.stringify(previous.after) !== JSON.stringify(after) || (previous.version !== undefined && previous.version !== parsed.data.version)) throw new HTTPError({ statusCode: 409, message: 'Request key was reused for different changes' })
    await assertChangeLocations(db, env, membership, before, await proposalLocation(db, thread, previous))
  } else {
    if (!['pending', 'confirmed'].includes(before.status)) throw new HTTPError({ statusCode: 409, message: 'This booking can no longer be changed' })
    if (before.endsAt <= new Date().toISOString()) throw new HTTPError({ statusCode: 409, message: 'This visit has ended and cannot be rescheduled' })
    if (before.version !== parsed.data.version) throw new HTTPError({ statusCode: 409, message: 'The booking changed. Reload before moving it.' })
    const after = fieldsSchema.parse({ ...parsed.data, kind: 'booking', party_size: parsed.data.party_size ?? before.partySize })
    const destination = await validateDestination(db, env, thread, before, after, actor.userId, dedupeKey)
    await assertChangeLocations(db, env, membership, before, destination.locationId)
    if (destination.startsAt === before.startsAt && destination.endsAt === before.endsAt && destination.timezone === before.timezone && after.party_size === before.partySize && destination.locationId === before.locationId) {
      throw new HTTPError({ statusCode: 400, message: 'Choose at least one change' })
    }
    const original = before.locationId
      ? await queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE id = ? AND organization_id = ?', [before.locationId, thread.organization_id])
      : null
    if (!summary.guestEmail || !env.NUXT_PUBLIC_PLATFORM_DOMAIN) throw new HTTPError({ statusCode: 503, message: 'Guest email delivery is not configured' })
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const payload = proposalSchema.parse({ before: sourceSchema.parse(before), after, version: before.version,
      beforeAssignedMemberName: await assignedMemberName(db, thread.organization_id, before.assignedMemberId), afterAssignedMemberId: destination.assignedMemberId ?? null, afterAssignedMemberName: await assignedMemberName(db, thread.organization_id, destination.assignedMemberId),
      locationTitle: destination.title, originalLocationTitle: original?.title ?? '', afterLabel: destination.label,
      afterDate: destination.date, afterTime: destination.time, afterStartsAt: destination.startsAt, afterEndsAt: destination.endsAt, afterTimezone: destination.timezone, afterLocationId: destination.locationId })
    // The move and its record land together: a destination that cannot take
    // the party changes no row, so the entry is not written either.
    const queries: BatchQuery[] = [...await destination.claim(before.recordId, now),
      ...messageQueries({ id, conversationId: thread.id, authorKind: 'krabiclaw', authorUserId: actor.userId, eventName: 'booking_change.moved',
        body: `Moved to ${destination.label} for ${after.party_size} guests${destination.title ? ` at ${destination.title}` : ''}.`,
        payload, dedupeKey, occurredAt: now, guard: { sql: 'c.organization_id = ? AND changes() = 1', params: [thread.organization_id] } }).queries, {
      // A moved booking is the party it moved with, no longer "this many or more".
      query: 'UPDATE bookings SET party_size_is_minimum = 0 WHERE id = ? AND organization_id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)',
      params: [before.recordId, thread.organization_id, id],
    }, ...conversationTaskQueries(thread.id, now, before.sessionId),
    assertBookingBatchWrite({ query: 'EXISTS (SELECT 1 FROM messages WHERE id=?)', params: [id] })]
    try {
      await executeBatch(db, queries, { operation: 'move booking' })
    } catch (error) {
      if (!bookingBatchWriteRefused(error)) throw error
      const raced = await findMessageByDedupeKey(db, dedupeKey)
      if (!raced || JSON.stringify(proposalSchema.parse(JSON.parse(raced.payload_json || '{}')).after) !== JSON.stringify(after)) {
        throw new HTTPError({ statusCode: 409, message: 'That session filled up or the booking changed; it has not moved', cause: error })
      }
    }
    entry = await findMessageByDedupeKey(db, dedupeKey)
    if (!entry) throw new HTTPError({ statusCode: 409, message: 'That session filled up or the booking changed; it has not moved' })
  }
  // Its automatic messages move with it.
  await (await import('~/server/domain/scheduled-guest-messages')).planSourceMessages(db, thread.organization_id, before.recordId)
  const noun = await bookingNoun(db, thread)
  await deliverEmail(db, env, thread, entry.id, entry.id, 'moved', proposalSchema.parse(JSON.parse(entry.payload_json || '{}')), noun)
  await reconcileConversationTasks(db, thread.id)
  return { changeStatus: 'moved' as const }
}

type ChangeSide = { when_label: string; party_size: number; assigned_member_id: string | null; assigned_member_name: string | null; total_label?: string }
export type BookingChangeView = {
  /** A stay's change (its channel's request) or any other booking's. */
  type: 'booking' | 'stay'; noun: string; guest_name: string; locale: string; vertical: string | null
  /** The business proposes and the guest answers; a guest's request on their channel is answered by the business. */
  requested_by: 'business' | 'guest'; channel?: 'airbnb'
  before: ChangeSide
  after: ChangeSide
  location_title: string; original_location_title: string
  status: BookingChangeStatus; message?: string
}

async function proposalView(db: DbClient, thread: GuestThreadRow, proposal: z.infer<typeof proposalSchema>, state: Pick<BookingChangeView, 'status' | 'message'>): Promise<BookingChangeView> {
  const guest = await changePresentation(db, thread, proposal)
  const summary = await sourceSummary(db, thread)
  return { type: 'booking', noun: await bookingNoun(db, thread), guest_name: summary.guestName, locale: guest.locale, vertical: guest.vertical, requested_by: 'business',
    before: guest.before, after: guest.after, location_title: guest.location_title, original_location_title: guest.original_location_title, ...state }
}

/** Conversation readers reuse the response operation's immutable details and state. */
export async function bookingChangeViews(db: DbClient, thread: GuestThreadRow, entries: MessageRow[], now = new Date().toISOString()): Promise<Map<string, BookingChangeView>> {
  const proposals = entries.filter(entry => entry.event_name === 'booking_change.requested')
  const views = new Map<string, BookingChangeView>()
  if (!proposals.length) return views
  const states = await bookingChangeStates(db, proposals.map(entry => entry.id), now)
  for (const entry of proposals) {
    const state = states.get(entry.id)
    if (!state) throw new Error('The booking change proposal disappeared')
    if (isStayChangeRequest(entry)) {
      views.set(entry.id, await stayChangeView(db, thread, entry, state.status))
      continue
    }
    const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
    views.set(entry.id, await proposalView(db, thread, proposal, state))
  }
  return views
}

/** GET only reads the immutable proposal. POST records one idempotent guest decision. */
export async function respondToBookingChange(db: DbClient, env: ChangeEnv, input: { threadId: string; requestId: string; decision?: 'accept' | 'decline' } & ({ token: string } | { buyerUserId: string })) {
  // The guest answers from the email link, or signed in as the account that owns the booking.
  if ('token' in input) {
    const expected = linkToken(env, input.threadId, input.requestId)
    if (!/^[a-f0-9]{64}$/.test(input.token) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.token, 'hex'))) throw new HTTPError({ statusCode: 404, message: 'Change request not found' })
  } else if (!await queryFirst(db, `SELECT 1 FROM conversations r WHERE r.id = ? AND r.user_id = ? AND ${CURRENT_GUEST_SQL('r')}`, [input.threadId, input.buyerUserId])) {
    throw new HTTPError({ statusCode: 404, message: 'Change request not found' })
  }
  const entry = await getMessage(db, input.requestId)
  if (!entry || entry.conversation_id !== input.threadId || entry.event_name !== 'booking_change.requested' || isStayChangeRequest(entry)) throw new HTTPError({ statusCode: 404, message: 'Change request not found' })
  const thread = await getGuestRequest(db, entry.conversation_id)
  if (!thread) throw new HTTPError({ statusCode: 404, message: 'Change request not found' })
  const proposal = proposalSchema.parse(JSON.parse(entry.payload_json || '{}'))
  const resultId = `booking-change-decision:${entry.id}`
  const current = await loadSource(db, thread as GuestThreadRow)
  const state = (await bookingChangeStates(db, [entry.id])).get(entry.id)
  if (!state) throw new Error('The booking change proposal disappeared')
  let result = state.decisionId ? await getMessage(db, state.decisionId) : null
  if (input.decision && state.status === 'expired') throw new HTTPError({ statusCode: 410, message: state.message })
  if (input.decision && state.status === 'stale') throw new HTTPError({ statusCode: 409, message: state.message })

  if (!result && input.decision) {
    if (!['pending', 'confirmed'].includes(current.status)) throw new HTTPError({ statusCode: 409, message: 'This booking can no longer be changed' })
    const destination = input.decision === 'accept' ? await validateDestination(db, env, thread as GuestThreadRow, current, proposal.after, thread.user_id ?? 'system', resultId) : null
    if (destination && (destination.label !== proposal.afterLabel || (proposal.afterStartsAt && destination.startsAt !== proposal.afterStartsAt) || (proposal.afterEndsAt && destination.endsAt !== proposal.afterEndsAt) || (proposal.afterTimezone && destination.timezone !== proposal.afterTimezone) || (proposal.afterLocationId !== undefined && destination.locationId !== proposal.afterLocationId))) throw new HTTPError({ statusCode: 409, message: 'The proposed time has changed. Ask the business for a new change request.' })
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    // The decision entry is guarded on the thread still being exactly what the
    // guest was shown. Everything else in the batch depends on that row
    // existing, so a concurrent edit makes the whole decision a no-op rather
    // than half-applying it.
    const currentGuard = sourceGuard(thread as GuestThreadRow, current)
    const ownership: BatchQuery = 'buyerUserId' in input ? { query: `EXISTS (SELECT 1 FROM conversations r WHERE r.id=? AND r.user_id=? AND ${CURRENT_GUEST_SQL('r')})`, params: [thread.id, input.buyerUserId] } : { query: '1', params: [] }
    // The guest's answer, by the guest: their account when the conversation has one.
    const entryInsert = messageQueries({ id, conversationId: thread.id, authorKind: 'krabiclaw', authorUserId: thread.user_id,
      eventName: `booking_change.${input.decision === 'accept' ? 'accepted' : 'declined'}`,
      body: `Guest ${input.decision === 'accept' ? 'accepted' : 'declined'} the requested changes.`,
      payload: { requestId: entry.id, booking_id: current.recordId, beforeStatus: current.status, before: { starts_at: current.startsAt, ends_at: current.endsAt, party_size: current.partySize }, after: destination ? { starts_at: destination.startsAt, ends_at: destination.endsAt ?? new Date(Date.parse(destination.startsAt) + Date.parse(current.endsAt) - Date.parse(current.startsAt)).toISOString(), party_size: proposal.after.party_size } : null },
      dedupeKey: resultId, occurredAt: now,
      guard: destination ? { sql: 'c.organization_id = ? AND changes()=1', params: [thread.organization_id] } : {
        sql: `c.organization_id = ? AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.conversation_id=c.id AND newer.event_name='booking_change.requested' AND newer.sequence>?)
          AND EXISTS (SELECT 1 FROM messages proposal WHERE proposal.id=? AND proposal.occurred_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'))
          AND ? > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (${currentGuard.query}) AND (${ownership.query})`,
        params: [thread.organization_id, entry.sequence, entry.id, current.endsAt, ...currentGuard.params!, ...ownership.params!],
      } }).queries

    const guard = `EXISTS (SELECT 1 FROM messages WHERE id = ?)`

    const queries: BatchQuery[] = []
    if (destination) {
      // Move the canonical record and append the decision in one batch. A
      // failed allocation changes no row, so changes() cannot record acceptance.
      const decisionGuard: BatchQuery = { query: `NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.conversation_id=? AND newer.event_name='booking_change.requested' AND newer.sequence>?) AND EXISTS (SELECT 1 FROM messages proposal WHERE proposal.id=? AND proposal.occurred_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')) AND (${ownership.query})`, params: [thread.id, entry.sequence, entry.id, ...ownership.params!] }
      queries.push(...await destination.claim(current.recordId, now, decisionGuard))
    }
    queries.push(...entryInsert)
    if (destination) {
      queries.push({
        query: `UPDATE bookings SET party_size_is_minimum = 0 WHERE id = ? AND organization_id = ? AND ${guard}`,
        params: [current.recordId, thread.organization_id, id],
      })
    }
    queries.push(...conversationTaskQueries(thread.id, now, current.sessionId))

    if (destination) queries.push(assertBookingBatchWrite({ query: guard, params: [id] }))
    try {
      await executeBatch(db, queries, { operation: 'respond to booking change' })
    } catch (error) {
      if (!bookingBatchWriteRefused(error)) throw error
      result = await findMessageByDedupeKey(db, resultId)
      if (!result) throw new HTTPError({ statusCode: 409, message: 'That session filled up or the booking changed; your original appointment is unchanged', cause: error })
    }
    result ??= await findMessageByDedupeKey(db, resultId)
    if (!result) {
      throw new HTTPError({ statusCode: 409, message: 'That session filled up or the booking changed; your original appointment is unchanged' })
    }
  }

  // Resolved once and returned, so the guest-facing page names the booking with
  // the same word as the email it arrived from.
  const noun = await bookingNoun(db, thread as GuestThreadRow)
  if (result && input.decision) {
    const accepted = result.event_name === 'booking_change.accepted'
    // An accepted move takes its automatic messages with it.
    if (accepted) await (await import('~/server/domain/scheduled-guest-messages')).planSourceMessages(db, thread.organization_id, current.recordId)
    await reconcileConversationTasks(db, thread.id)
    if (!result.payload_json) throw new Error('A booking change answer has no recorded payload')
    const answered = JSON.parse(result.payload_json) as { booking_id?: unknown }
    if (thread.kind === 'booking' && typeof answered.booking_id === 'string') {
      await recordBookingChangeAnswer(db, { organizationId: thread.organization_id, bookingId: answered.booking_id, changeRequestId: entry.id, accepted })
    }
    // Told once the answer and its analytics are recorded, so a send that fails cannot skip them.
    await deliverEmail(db, env, thread as GuestThreadRow, result.id, entry.id, accepted ? 'accepted' : 'declined', proposal, noun)
  }
  const finalState = (await bookingChangeStates(db, [entry.id])).get(entry.id)
  if (!finalState) throw new Error('The booking change proposal disappeared')
  return proposalView(db, thread as GuestThreadRow, proposal, finalState)
}
