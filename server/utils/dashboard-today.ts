import { HTTPError, type H3Event } from 'nitro'
import { d1JsonStringSet, queryAll, queryFirst, type DbClient } from '~/server/db'
import { listAgenda, listTodayAgenda, parseAgendaQuery, type AgendaQuery } from '~/server/utils/dashboard-agenda'
import { getDashboardMemberContext, type DashboardOrganizationRow } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { firstUnansweredGuestEntryTimes, listOrganizationGuestThreads } from '~/server/domain/guest-threads/repository'
import type { GuestThreadDeliveryRow, GuestThreadListItemViewModel } from '~/server/domain/guest-threads/types'
import { agendaToTodayCard, todayFeedSchema, type TodayCard, type TodayFeedPayload } from '~/shared/dashboard-today'
import { isValidInstant, localDateAt } from '~/utils/timezone'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { bookingEditorPath, guestConversationPath, postEditorPath } from '~/server/utils/dashboard-links'
import { loadOwnerPictures } from '~/server/notifications/hero'
import { isDeliverySent, isVisibleDeliveryFailure } from '~/server/domain/guest-threads/deliveries'
import { getReviewBookingContext, type ReviewBookingType } from '~/server/utils/review-requests'

export interface TodayFeedQuery {
  range: 'today' | 'upcoming'
  from?: string
  to?: string
  locationId?: string
  assignedMemberId?: string
  kinds?: Array<'reservation' | 'booking' | 'stay'>
}

export function parseTodayFeedQuery(query: Record<string, unknown>): TodayFeedQuery {
  const read = (key: string) => typeof query[key] === 'string' && query[key] ? String(query[key]) : undefined
  const range = read('range') ?? 'today'
  if (range !== 'today' && range !== 'upcoming') throw new HTTPError({ statusCode: 400, message: 'range must be today or upcoming' })
  const kindsValue = read('kinds')
  const kinds = kindsValue?.split(',').map(kind => kind.trim())
  if (kinds?.some(kind => kind !== 'reservation' && kind !== 'booking' && kind !== 'stay')) throw new HTTPError({ statusCode: 400, message: 'Today supports reservation, booking and stay types' })
  const dates = range === 'upcoming' ? parseAgendaQuery(query) : {}
  return { range, ...dates, kinds: kinds as TodayFeedQuery['kinds'], locationId: read('locationId'), assignedMemberId: read('assigned_member_id') }
}

function card(input: Pick<TodayCard, 'id' | 'to' | 'eyebrow' | 'headline' | 'priority'> & Partial<TodayCard>): TodayCard {
  return { description: null, imageUrl: null, imageFit: 'cover', imageIcon: 'i-lucide-circle-check', badgeImageUrl: null, badgeIcon: null,
    locationId: null, assignedMemberId: null, bookingKind: null, stayId: null, productId: null, stayChannel: null, occurrenceAt: null, timeZone: null,
    actionAt: null, completedAt: null, reason: null, decision: null, ...input }
}

function pendingBookingCard(thread: GuestThreadListItemViewModel, organization: DashboardOrganizationRow): TodayCard | null {
  if (thread.manuallyArchived || thread.mailbox !== 'current' || thread.submissionType !== 'booking' || thread.operationalStatus !== 'pending') return null
  const noun = resolveBookingPresentation('booking', organization.vertical).noun
  return threadCard(thread, {
    id: `attention:${thread.id}`, priority: 'attention', to: bookingEditorPath(organization.slug, 'booking', thread.id),
    eyebrow: 'Awaiting your decision', headline: `Review ${thread.guestName ?? thread.participantLabel}’s ${noun}`,
  }, organization)
}

async function publicationCards(db: DbClient, organization: DashboardOrganizationRow, locationId?: string): Promise<TodayCard[]> {
  const rows = await queryAll<{ id: string; title: string | null; location_id: string | null; channel: string; error_message: string | null }>(db, `
    SELECT p.id,p.title,p.location_id,publication.channel,publication.error_message
      FROM post_publications publication JOIN content_documents p ON p.id=publication.post_id AND p.organization_id=publication.organization_id
     WHERE publication.organization_id=? AND publication.state IN ('failed','unknown')
       ${locationId ? 'AND p.location_id=?' : ''} ORDER BY publication.updated_at,p.id,publication.channel`, [organization.id, ...(locationId ? [locationId] : [])])
  const pictures = await loadOwnerPictures(db, organization.id, 'content_document', rows.map(row => row.id))
  const grouped = new Map<string, typeof rows>()
  for (const row of rows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row])
  return [...grouped].map(([id, failures]) => card({
    id: `publication:${id}`, to: `${postEditorPath(organization.slug, id)}/publishing`, priority: 'attention', eyebrow: 'Publishing needs attention',
    headline: failures[0]!.title ? `Finish publishing “${failures[0]!.title}”` : 'Finish publishing your post',
    description: failures.map(row => `${row.channel === 'facebook' ? 'Facebook' : row.channel === 'instagram' ? 'Instagram' : 'Discord'}${row.error_message ? `: ${row.error_message}` : ''}`).join(' · '),
    imageUrl: pictures.get(id)?.imageUrl ?? null, imageIcon: 'i-lucide-send', locationId: failures[0]!.location_id,
  }))
}

async function threadRecords(db: DbClient, organization: DashboardOrganizationRow, principal: ReturnType<typeof memberAccessPrincipal>, input: TodayFeedQuery) {
  const threads: GuestThreadListItemViewModel[] = []
  for (let offset = 0; ; offset += 200) {
    const page = await listOrganizationGuestThreads(db, {
      organizationId: organization.id, principal, userId: organization.userId,
      locationId: input.locationId, assignedMemberId: input.assignedMemberId, limit: 200, offset,
    })
    threads.push(...page.filter(thread => !input.kinds?.length || thread.submissionType !== 'contact' && input.kinds.includes(thread.submissionType)))
    if (page.length < 200) break
  }
  return threads
}

function threadCard(thread: GuestThreadListItemViewModel, input: Pick<TodayCard, 'id' | 'headline' | 'eyebrow' | 'priority'> & Partial<TodayCard>, organization: DashboardOrganizationRow): TodayCard {
  return card({ to: guestConversationPath(organization.slug, thread.id),
    description: [thread.locationLabel, thread.whenLabel].filter(Boolean).join(' · '), imageUrl: thread.imageUrl, imageFit: thread.imageFit,
    imageIcon: 'i-lucide-message-circle', locationId: thread.locationId, assignedMemberId: thread.assignedMemberId,
    bookingKind: thread.submissionType === 'contact' ? null : thread.submissionType, productId: thread.productId,
    stayChannel: thread.stayChannel, occurrenceAt: thread.occurrenceAt, timeZone: thread.timeZone, ...input })
}

interface PlannedMessage {
  id: string; request_id: string | null; stay_id: string | null; product_id: string | null; location_id: string | null
  assigned_member_id: string | null; title: string; due_at: string | null; timezone: string | null
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'needs_review'; reason: string | null
  entry_id: string | null; entry_channel: string | null; sent_at: string | null; automatic: number
  user_id: string | null
}

/** The schedule and its outcome remain owned by the message, never by a Today task. */
async function messageCards(db: DbClient, organization: DashboardOrganizationRow, threads: GuestThreadListItemViewModel[], input: TodayFeedQuery, zone: string, automatic: boolean): Promise<TodayCard[]> {
  const byId = new Map(threads.map(thread => [thread.id, thread]))
  const rows = await queryAll<PlannedMessage>(db, `SELECT * FROM (
    SELECT m.id,m.request_id,NULL AS stay_id,NULL AS product_id,NULL AS location_id,NULL AS assigned_member_id,
      'Scheduled reply' AS title,m.due_at,NULL AS timezone,m.status,m.reason,m.entry_id,e.channel AS entry_channel,m.sent_at,0 AS automatic,m.user_id
      FROM send_later_messages m LEFT JOIN activity_entries e ON e.id=m.entry_id AND e.request_id=m.request_id
     WHERE m.organization_id=? AND (m.user_id=? OR m.status='sent') AND m.status IN ('pending','sending','sent','failed','needs_review')
       AND m.request_id IN (SELECT value FROM json_each(?))
    ${automatic ? `UNION ALL
    SELECT m.id,m.request_id,m.stay_id,m.product_id,c.location_id,c.assigned_member_id,m.template_title,m.due_at,m.timezone,m.status,m.reason,
      m.entry_id,e.channel,m.sent_at,1 AS automatic,NULL AS user_id
      FROM scheduled_guest_messages m JOIN stays s ON s.organization_id=m.organization_id AND s.id=m.stay_id
      JOIN product_stay_configs c ON c.organization_id=m.organization_id AND c.product_id=m.product_id
      LEFT JOIN activity_entries e ON e.id=m.entry_id AND e.request_id=m.request_id
     WHERE m.organization_id=? AND m.status IN ('pending','sending','sent','failed','needs_review')
       AND (s.status='confirmed' OR m.status='sent')
       ${input.locationId ? 'AND c.location_id=?' : ''} ${input.assignedMemberId ? 'AND c.assigned_member_id=?' : ''}
       ${input.kinds?.length && !input.kinds.includes('stay') ? 'AND 0' : ''}` : ''}
    ) ORDER BY due_at,id`, [organization.id, organization.userId, d1JsonStringSet([...byId.keys()]),
    ...(automatic ? [organization.id, ...(input.locationId ? [input.locationId] : []), ...(input.assignedMemberId ? [input.assignedMemberId] : [])] : [])])
  const ids = rows.flatMap(row => row.entry_id ? [row.entry_id] : [])
  const receipts = ids.length ? await queryAll<GuestThreadDeliveryRow>(db, 'SELECT * FROM guest_thread_deliveries WHERE entry_id IN (SELECT value FROM json_each(?))', [d1JsonStringSet(ids)]) : []
  return rows.flatMap(row => {
    const thread = row.request_id ? byId.get(row.request_id) : null
    // Automatic correspondence is organization-wide. A missing conversation still opens its actual stay.
    if (!thread && !row.automatic) return []
    const timeZone = row.timezone ?? thread?.timeZone ?? zone
    const name = thread?.guestName ?? thread?.participantLabel
    const deliveries = receipts.filter(receipt => receipt.entry_id === row.entry_id && receipt.channel === row.entry_channel
      && receipt.purpose === (row.automatic ? 'scheduled_message' : 'member_reply'))
    const deliveryFailure = deliveries.find(isVisibleDeliveryFailure)
    const sent = row.status === 'sent'
    if (sent && (!isValidInstant(row.sent_at) || !row.entry_id)) throw new Error(`Sent message ${row.id} has no completion record`)
    const unconfirmed = sent && row.entry_channel !== 'web' && !deliveries.some(receipt => receipt.provider !== 'log_only' && isDeliverySent(receipt))
    const failed = row.status === 'failed' || row.status === 'needs_review' || Boolean(deliveryFailure) || unconfirmed
    const failureReason = row.reason ?? deliveryFailure?.error ?? (unconfirmed ? 'No successful delivery is recorded for this message.' : null)
    if (!row.automatic && row.user_id !== organization.userId && !sent) return []
    if (!failed) return []
    if (!failureReason) throw new Error(`Failed message ${row.id} has no recorded reason`)
    const automaticLabel = row.automatic ? 'Automatic' : row.user_id === organization.userId ? 'Scheduled by you' : 'Scheduled reply'
    const status = row.status === 'needs_review' || sent ? 'Delivery needs attention' : 'Message failed'
    const values = { id: `${row.automatic ? 'automatic-message' : 'send-later'}:${row.id}`, priority: 'attention' as const,
      eyebrow: `${status} · ${automaticLabel}`, headline: `${row.title}${name ? ` for ${name}` : ''}`,
      description: failureReason, timeZone,
      ...(row.automatic ? { stayId: row.stay_id, productId: row.product_id } : {}),
    }
    return [thread ? threadCard(thread, values, organization) : card({ ...values,
      to: `/dashboard/${encodeURIComponent(organization.slug)}/bookings/stay/${encodeURIComponent(row.stay_id!)}`,
      locationId: row.location_id, assignedMemberId: row.assigned_member_id, bookingKind: 'stay', imageIcon: 'i-lucide-message-circle' })]
  })
}

async function deliveryAttentionCards(db: DbClient, organization: DashboardOrganizationRow, threads: GuestThreadListItemViewModel[], unanswered: ReadonlyMap<string, string>): Promise<TodayCard[]> {
  if (!threads.length) return []
  const rows = await queryAll<GuestThreadDeliveryRow & { request_id: string; event_name: string }>(db, `
    SELECT d.*,e.request_id,e.event_name FROM guest_thread_deliveries d JOIN activity_entries e ON e.id=d.entry_id
      JOIN requests r ON r.id=e.request_id AND r.organization_id=?
     WHERE e.request_id IN (SELECT value FROM json_each(?)) AND d.purpose IN ('member_reply','status_update')
       AND NOT EXISTS (SELECT 1 FROM scheduled_guest_messages m WHERE m.entry_id=e.id)
       AND NOT EXISTS (SELECT 1 FROM send_later_messages m WHERE m.entry_id=e.id)
     ORDER BY e.sequence DESC,d.updated_at DESC,d.id`, [organization.id, d1JsonStringSet(threads.map(thread => thread.id))])
  const byId = new Map(threads.map(thread => [thread.id, thread])), cards = new Map<string, TodayCard>()
  const notified = new Set(rows.filter(row => row.purpose === 'status_update' && row.provider !== 'log_only' && isDeliverySent(row) && !isVisibleDeliveryFailure(row))
    .map(row => `${row.entry_id}:${row.channel}`))
  for (const row of rows) {
    const notification = `${row.entry_id}:${row.channel}`
    if (!isVisibleDeliveryFailure(row)) continue
    if (row.purpose === 'status_update' && notified.has(notification)) continue
    const thread = byId.get(row.request_id)!
    const acceptedWithError = Boolean(row.error) && row.provider !== 'log_only' && Boolean(row.provider_message_id?.trim())
      && ['accepted', 'sent', 'delivered', 'read'].includes(row.status)
    if (row.purpose === 'member_reply' && !unanswered.has(thread.id) && !acceptedWithError) continue
    if ((row.event_name === 'booking.confirm' || row.event_name === 'reservation.confirm') && thread.operationalStatus !== 'confirmed') continue
    if ((row.event_name === 'booking.reject' || row.event_name === 'reservation.reject' || row.event_name === 'booking.cancel' || row.event_name === 'reservation.cancel') && thread.operationalStatus !== 'cancelled') continue
    if (thread.manuallyArchived || thread.mailbox === 'blocked') continue
    const name = thread.guestName ?? thread.participantLabel
    const id = row.event_name === 'review.requested' ? `review-invitation:${thread.id}` : `attention:${thread.id}`
    if (!cards.has(id)) cards.set(id, threadCard(thread, { id, priority: 'attention',
      eyebrow: row.event_name === 'review.requested' ? 'Review invitation needs attention' : row.status === 'uncertain' ? 'Send outcome needs review' : 'Message needs attention',
      headline: row.event_name === 'review.requested' ? `Check the review invitation for ${name}` : `Check the message to ${name}`, description: row.error ?? 'The provider recorded that this message was not delivered.',
      imageIcon: 'i-lucide-message-circle-warning' }, organization))
  }
  return [...cards.values()]
}

async function reviewFailureCards(db: DbClient, organization: DashboardOrganizationRow, threads: GuestThreadListItemViewModel[]): Promise<TodayCard[]> {
  const failures = await queryAll<{ booking_id: string; last_error: string }>(db, 'SELECT booking_id,last_error FROM review_requests WHERE organization_id=? AND first_sent_at IS NULL AND last_error IS NOT NULL', [organization.id])
  const result: TodayCard[] = []
  for (const failure of failures) {
    const thread = threads.find(item => item.id === failure.booking_id && item.submissionType !== 'contact' && item.operationalStatus === 'confirmed')
    if (!thread) continue
    const context = await getReviewBookingContext(db, thread.submissionType as ReviewBookingType, thread.id)
    if (!context || context.no_show_at !== null) continue
    result.push(threadCard(thread, { id: `review-invitation:${thread.id}`, priority: 'attention',
      eyebrow: 'Review invitation needs attention', headline: `Check the review invitation for ${thread.guestName ?? thread.participantLabel}`,
      description: failure.last_error }, organization))
  }
  return result
}

export async function loadDashboardToday(event: H3Event, input: TodayFeedQuery, now = new Date()): Promise<TodayFeedPayload> {
  const { db, env, organization } = await getDashboardMemberContext(event)
  const principal = memberAccessPrincipal(organization, { env, event })
  const organizationWide = await roleAllows({ ...organization, permissions: { operations: ['read'] } })
  const resolvedAt = now.toISOString()
  const query: AgendaQuery = { from: input.from!, to: input.to!, kinds: input.kinds ?? ['reservation', 'booking', 'stay'], locationId: input.locationId,
    assignedMemberId: input.assignedMemberId, organizationSlug: organization.slug, principal: { env, membership: organization } }
  const agenda = input.range === 'today'
    ? await listTodayAgenda(db, { organizationId: organization.id }, { organizationSlug: organization.slug, principal: query.principal }, now)
    : await listAgenda(db, { organizationId: organization.id }, query)
  if (input.locationId && !agenda.locations.some(location => location.id === input.locationId)) throw new HTTPError({ statusCode: 404, message: 'Location not found' })
  const items = agenda.items.filter(item => (!input.locationId || item.locationId === input.locationId)
    && (!input.assignedMemberId || item.assignedMemberId === input.assignedMemberId)
    && (!input.kinds?.length || item.kind !== 'post' && input.kinds.includes(item.kind))
    && (input.range === 'today' || item.dayKey > localDateAt(now, item.timeZone)))
  const availableKinds = agenda.availableKinds.filter((kind): kind is 'reservation' | 'booking' | 'stay' => kind === 'reservation' || kind === 'booking' || kind === 'stay')
  const payload = { availableKinds, locations: agenda.locations, resolvedAt, priorities: null }
  const schedule = items.map(item => agendaToTodayCard(item, { resolvedAt, vertical: organization.vertical, assigned: !organizationWide }))
  if (input.range === 'upcoming') return todayFeedSchema.parse({ ...payload, cards: schedule })

  const zone = (await queryFirst<{ timezone: string }>(db, 'SELECT timezone FROM organization WHERE id = ?', [organization.id]))?.timezone
  if (!zone) throw new Error(`Organization ${organization.id} has no timezone`)
  const threads = organization.vertical !== 'lodging' || organizationWide ? await threadRecords(db, organization, principal, input) : []
  const unanswered = await firstUnansweredGuestEntryTimes(db, organization.id, threads.map(thread => thread.id))
  const [messages, reviews, deliveryFailures, publicationFailures] = await Promise.all([
    messageCards(db, organization, threads, input, zone, organizationWide && await roleAllows({ ...organization, permissions: { operations: ['update'] } })),
    organizationWide && await roleAllows({ ...organization, permissions: { operations: ['update'] } }) ? reviewFailureCards(db, organization, threads) : [],
    deliveryAttentionCards(db, organization, threads, unanswered),
    organizationWide && !input.assignedMemberId && !input.kinds?.length && await roleAllows({ ...organization, permissions: { content: ['publish'] } }) ? publicationCards(db, organization, input.locationId) : [],
  ])
  const failureIds = new Set(deliveryFailures.map(item => item.id))
  const pending = threads.flatMap(thread => {
    const item = pendingBookingCard(thread, organization)
    return item && !failureIds.has(item.id) ? [item] : []
  })
  const pendingRequests = new Set(pending.map(item => item.id.slice('attention:'.length)))
  return todayFeedSchema.parse({ ...payload, cards: [...pending, ...deliveryFailures, ...publicationFailures, ...messages,
    ...reviews.filter(item => !failureIds.has(item.id)), ...schedule.filter(item => !pendingRequests.has(item.id.slice(item.id.indexOf(':') + 1)))] })
}
