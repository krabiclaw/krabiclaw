import { HTTPError } from 'nitro'
import { visitRefundQueries } from '~/server/domain/payments/visit-refund'
import { recordBookingCancelled, recordBookingDecision } from '~/server/domain/booking-analytics'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { shouldSendRealEmail } from '~/server/utils/email-delivery'
import type { ReplyEmailEnv } from '~/server/utils/submission-messages'
import { canMarkNoShow, getGuestRequest, getThreadOperationalRecord, partySizeIsMinimum, requestActions, requestSummary, type ThreadOperationalRecord } from '~/server/domain/requests'
import { revokeReviewRequestQuery } from '~/server/utils/review-requests'
import { deliverGuestThreadEmail, getDeliveryById, isDeliverySent } from './deliveries'
import { findEntryByDedupeKey, parseEntryPayload } from './entries'
import { discardMessagePhotos, listMessagePhotos, MessagePhotoRejection, messagePhotoPlacements, uploadMessagePhotos, type MessagePhotoInput } from './attachments'
import type { UploadResolvedMediaInput } from '~/server/utils/media-upload'
import { mailboxTransitionQueries, updateThreadProjectionIfLatestEntry } from './repository'
import { resolveGuestThreadMailbox } from './mailbox'
import { renderNotificationEmail } from '~/server/emails/render'
import { guestThreadReplyMessage, guestThreadStatusMessage } from '~/server/notifications/guest-events'
import { organizationLogo } from '~/server/notifications/hero'
import { getPlatformDomain, buildBuyerRequestActivityUrl } from '~/server/utils/dashboard-notification-links'
import { isBookingComplete } from '~/shared/bookings'
import { creationRequestHash } from '~/server/utils/organization-events'
import { guestPresentation } from '~/server/utils/notifications'
import { platformLocale } from '~/shared/platform-locales'
import { notifyBuyerThread } from '~/server/utils/notification-center'
import { formatTimestamp } from '~/utils/timezone'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'
import { getChannelThreadMapping, replyThroughChannex } from './channel-messages'
import type { ChannexEnv, ChannexError } from '~/server/integrations/channex/client'
import { announceContentReport, assertSameReport, contentReportId, contentReportInsert, guestThreadExcerpt, reportReason, type ContentReportEnv } from '~/server/domain/content-reports'
import type {
  GuestThreadDeliveryProvider,
  GuestThreadDeliveryRow,
  GuestThreadEntryRow,
  GuestThreadRow,
  GuestThreadSubmissionType,
} from './types'

// A thread is never resolved by hand. Booking decisions resolve their review
// through the booking's own lifecycle; there is no separate resolve/reopen for a
// member to reach for. Archive and unarchive say where the conversation is
// filed, not what state it is in, and touch neither the booking nor
// conversation_state.
export const GUEST_THREAD_ACTIONS = new Set(['confirm', 'reject', 'cancel', 'no_show', 'reply', 'archive', 'unarchive', 'report', 'block', 'unblock'])

type SuccessfulOperationOutcome = { ok: true; status: 200; thread: GuestThreadRow; availableActions: string[] }

export type OperationOutcome =
  | SuccessfulOperationOutcome
  | { ok: false; status: 404; reason: 'thread_not_found' | 'source_not_found' }
  | { ok: false; status: 409; reason: 'invalid_transition'; message: string }
  | { ok: false; status: 400; reason: 'no_guest_email' }
  | { ok: false; status: 400; reason: 'empty_body' }
  | { ok: false; status: 409; reason: 'guest_invite_required'; code: 'GUEST_INVITE_REQUIRED'; field: 'request_id'; message: string }
  | { ok: false; status: 400; reason: 'missing_idempotency_key' }
  | { ok: false; status: 400; reason: 'invalid_photo'; message: string }
  | { ok: false; status: 409 | 502; reason: 'delivery_failed'; code: string; field: string; message: string; mutation_applied?: true; operation_completed?: false; request_id?: string; record?: ThreadOperationalRecord; retry_with_same_idempotency_key?: boolean; provider_error?: ChannexError['data'] }

/** A reply never asks for a guest email; a stay without one asks for an invite. */
export type ReplyOutcome = Exclude<OperationOutcome, { reason: 'no_guest_email' }>
type NotFoundOutcome = Extract<OperationOutcome, { status: 404 }>

export type ExecuteOperationInput = {
  threadId: string
  organizationId: string
  action: string
  body?: string
  /** Why a member reports or blocks the guest. */
  reason?: string
  /** The photos a reply carries, in the order they were chosen. */
  photos?: MessagePhotoInput
  env: ReplyEmailEnv & UploadResolvedMediaInput['env'] & ChannexEnv & ContentReportEnv
  idempotencyKey?: string
  actorUserId: string
  financialAuthorizationId?: string
  financialWritesAllowed?: boolean
}

interface ThreadContext {
  thread: GuestThreadRow
  /**
   * The booking or reservation this thread refers to, loaded once.
   *
   * Operational status lives there, not on the thread, so every transition
   * below reads and writes that record. A contact thread has none.
   */
  record: ThreadOperationalRecord | null
}

interface SourceMutationPlan {
  kind: 'reservation' | 'booking'
  action: 'confirm' | 'reject' | 'cancel'
  beforeStatus: string
  afterStatus: 'confirmed' | 'cancelled'
  requiresNotification: boolean
}

async function loadThreadContext(
  db: DbClient,
  threadId: string,
  organizationId: string,
): Promise<ThreadContext | NotFoundOutcome> {
  const thread = await getGuestRequest(db, threadId, organizationId)
  if (!thread) return { ok: false, status: 404, reason: 'thread_not_found' }
  return { thread, record: await getThreadOperationalRecord(db, thread.id) }
}

function operationDedupeKey(input: Pick<ExecuteOperationInput, 'threadId' | 'idempotencyKey'>): string {
  return `guest-thread-operation:${input.threadId}:${input.idempotencyKey}`
}

function deliveryDedupeKey(input: Pick<ExecuteOperationInput, 'threadId' | 'idempotencyKey'>): string {
  return `guest-thread-email:${input.threadId}:${input.idempotencyKey}`
}

// Provider mode records the provider it asks; a reserved test address is then
// refused by sendEmail with RESERVED_TEST_EMAIL_DOMAIN on that resend receipt.
function emailProvider(env: ReplyEmailEnv): GuestThreadDeliveryProvider {
  return shouldSendRealEmail(env) ? 'resend' : 'log_only'
}

function entryMatchesRequest(entry: GuestThreadEntryRow, eventName: string, body?: string): boolean {
  return entry.event_name === eventName && (body === undefined || (entry.body ?? '') === body)
}

function conflict(message = 'Idempotency key was reused with a different request'): Extract<OperationOutcome, { reason: 'invalid_transition' }> {
  return { ok: false, status: 409, reason: 'invalid_transition', message }
}

async function successfulOutcome(
  db: DbClient,
  context: ThreadContext,
): Promise<SuccessfulOperationOutcome | NotFoundOutcome> {
  const current = await loadThreadContext(db, context.thread.id, context.thread.organization_id)
  if ('ok' in current) return current
  if (context.record && !current.record) return { ok: false, status: 404, reason: 'source_not_found' }
  return {
    ok: true,
    status: 200,
    thread: current.thread,
    availableActions: requestActions(current.record, new Date().toISOString()),
  }
}

function sourceMutationPlan(context: ThreadContext, action: string): SourceMutationPlan | null {
  // A stay is changed from its own screen; its thread converses about it.
  if (context.thread.kind === 'contact' || context.thread.kind === 'stay' || !context.record || context.record.kind === 'stay') return null
  const { kind, status: beforeStatus } = context.record
  // Pending review and confirmed appointments share the same temporal guard.
  if (context.record.ends_at <= new Date().toISOString() || isBookingComplete(context.record, new Date().toISOString())) return null
  if (kind === 'booking' && beforeStatus === 'pending' && (action === 'confirm' || action === 'reject')) {
    return { kind, action, beforeStatus, afterStatus: action === 'confirm' ? 'confirmed' : 'cancelled', requiresNotification: true }
  }
  if ((beforeStatus === 'confirmed' || beforeStatus === 'pending') && action === 'cancel') {
    return { kind, action, beforeStatus, afterStatus: 'cancelled', requiresNotification: true }
  }
  return null
}

/**
 * The record has not finished yet, as the database sees it.
 *
 * A reservation holds its own end; a booking's is on its session. The first
 * guarded ledger insert checks this once for the atomic mutation batch.
 */
function sourceStillRunningSql(plan: SourceMutationPlan, table: string): string {
  return plan.kind === 'reservation'
    ? `${table}.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    : `EXISTS (SELECT 1 FROM product_sessions s WHERE s.id = ${table}.product_session_id AND s.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
}

function operationEntryQuery(
  context: ThreadContext,
  plan: SourceMutationPlan,
  input: ExecuteOperationInput,
  entryId: string,
  dedupeKey: string,
  now: string,
  email: Awaited<ReturnType<typeof renderStatusUpdate>> | null,
  financialGuard: BatchQuery | null = null,
): BatchQuery {
  return {
    query: `
      INSERT INTO activity_entries
        (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, body, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
      SELECT ?, gt.id, 'operation', 'request', ?, ?, NULL, ?, ?, ?, ?,
             COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id = gt.id), 0) + 1,
             ?, ?
      FROM requests gt
      WHERE gt.id = ? AND gt.organization_id = ? AND gt.kind = ? AND gt.updated_at = ?
        -- Guarded on the state of the record that holds the seats, because the
        -- thread has no status of its own: two dashboards acting at once must
        -- not both write an entry for the same transition.
        AND EXISTS (SELECT 1 FROM ${plan.kind === 'reservation' ? 'reservations src' : 'bookings src JOIN product_sessions occurrence ON occurrence.id=src.product_session_id AND occurrence.organization_id=src.organization_id AND occurrence.product_id=src.product_id'}
                     WHERE src.request_id = gt.id AND src.organization_id=gt.organization_id AND src.status = ? AND ${sourceStillRunningSql(plan, 'src')}
                       AND json_array(src.id,src.party_size,${plan.kind === 'reservation' ? 'NULL,NULL,src.starts_at,src.ends_at,src.timezone,src.location_id' : 'src.assigned_member_id,src.product_id,occurrence.starts_at,occurrence.ends_at,occurrence.timezone,occurrence.location_id'},json_extract(gt.payload_json,'$.party_size_is_minimum'))=json_array(?,CAST(? AS INTEGER),?,?,?,?,?,?,CAST(? AS INTEGER)))
        AND (${financialGuard?.query ?? '1=1'})
      ON CONFLICT(dedupe_key) DO NOTHING
    `,
    params: [
      entryId,
      input.actorUserId === null ? 'system' : 'member',
      input.actorUserId,
      email?.body ?? null,
      `${plan.kind}.${plan.action}`,
      JSON.stringify({
        action: plan.action, beforeStatus: plan.beforeStatus, afterStatus: plan.afterStatus,
        operational_booking_id: context.record!.id, request_id: context.thread.id,
        subject: email?.subject ?? null,
        email: email ? { to: email.to, fromName: email.fromName, locale: email.locale, ...email.email } : null,
        booking: {
          starts_at: context.record!.starts_at, ends_at: context.record!.ends_at,
          timezone: context.record!.timezone, party_size: context.record!.party_size,
          party_size_is_minimum: partySizeIsMinimum(context.thread),
          location_id: context.record!.location_id, product_id: context.record!.product_id,
        },
      }),
      dedupeKey,
      now,
      now,
      context.thread.id,
      context.thread.organization_id,
      plan.kind,
      context.thread.updated_at,
      plan.beforeStatus,
      context.record!.id, context.record!.party_size, context.record!.assigned_member_id, context.record!.product_id, context.record!.starts_at, context.record!.ends_at, context.record!.timezone, context.record!.location_id, Number(partySizeIsMinimum(context.thread)),
      ...(financialGuard?.params ?? []),
    ],
  }
}

/**
 * Move the operational record, not the thread.
 *
 * Cancelling here is what releases the seats, because availability is always
 * the sum over live bookings — there is no counter to keep in step. The
 * transition is guarded on the status the caller read, so two dashboards
 * confirming at once cannot both win.
 */
function sourceUpdateQuery(context: ThreadContext, plan: SourceMutationPlan, input: ExecuteOperationInput, entryId: string, now: string): BatchQuery {
  const table = plan.kind === 'reservation' ? 'reservations' : 'bookings'
  const stamps = plan.afterStatus === 'cancelled' ? ', cancelled_at = COALESCE(cancelled_at, ?), cancellation_reason = ?' : ''
  const stampParams = plan.afterStatus === 'cancelled' ? [now, plan.action === 'reject' ? 'host_rejected' : 'host_cancelled'] : []
  // The first ledger insert already checked the live source and end time.
  // This statement follows it in the same atomic batch, without a second clock gate.
  return {
    query: `
      UPDATE ${table}
      SET status = ?, updated_at = ?${stamps}
      WHERE id = ? AND status = ?
        AND EXISTS (SELECT 1 FROM activity_entries WHERE id = ?)
    `,
    params: [plan.afterStatus, now, ...stampParams, context.record!.id, plan.beforeStatus, entryId],
  }
}

function resolveThreadQuery(threadId: string, entryId: string, now: string): BatchQuery {
  return {
    query: `
      UPDATE requests
      SET conversation_state = 'resolved', resolved_at = ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM activity_entries WHERE id = ?)
    `,
    params: [now, now, threadId, entryId],
  }
}

function deliveryReceiptQuery(
  context: ThreadContext,
  input: ExecuteOperationInput,
  entryId: string,
  deliveryId: string,
  now: string,
): BatchQuery {
  return {
    query: `
      INSERT INTO guest_thread_deliveries
        (id, entry_id, channel, provider, purpose, status, created_at, updated_at)
      SELECT ?, id, 'email', ?, 'status_update', 'pending', ?, ?
      FROM activity_entries
      WHERE id = ? AND request_id = ?
      ON CONFLICT(id) DO NOTHING
    `,
    params: [
      deliveryId,
      emailProvider(input.env),
      now,
      now,
      entryId,
      context.thread.id,
    ],
  }
}

async function getOrganizationBrandName(db: DbClient, organizationId: string): Promise<string> {
  const row = await queryFirst<{ name: string | null }>(db, 'SELECT name FROM organization WHERE id = ? LIMIT 1', [organizationId])
  if (!row?.name?.trim()) throw new Error(`Organization ${organizationId} has no configured brand name`)
  return row.name.trim()
}

function replySubject(submissionType: GuestThreadSubmissionType, fromName: string): string {
  if (submissionType === 'contact') return `Re: your message to ${fromName}`
  if (submissionType === 'reservation') return `Re: your reservation at ${fromName}`
  return `Re: your booking at ${fromName}`
}

/**
 * Guest-facing inbox mail renders through the shared shell like every other
 * outbound message. A member's reply leads with their own words; a status
 * update leads with what changed.
 */
async function renderMemberReply(env: ReplyEmailEnv, db: DbClient, organizationId: string, organizationName: string, entry: GuestThreadEntryRow, locale: string | undefined) {
  const guest = await guestPresentation(db, { organizationId, organizationName, locale })
  const organizationLogoUrl = await organizationLogo(db, organizationId)
  const photos = (await listMessagePhotos(db, 'activity_entry', [entry.id])).get(entry.id) ?? []
  return renderNotificationEmail(guestThreadReplyMessage({
    locale: guest.locale,
    organizationName: guest.organizationName,
    organizationLogoUrl,
    body: entry.body ?? '',
    manageUrl: await buildBuyerRequestActivityUrl(env, db, { organizationId, threadId: entry.request_id }),
    photos: photos.map(photo => ({ imageUrl: photo.url, alt: photo.alt ?? `Photo from ${organizationName}` })),
  }), { platformDomain: getPlatformDomain(env) })
}

async function renderStatusUpdate(env: ReplyEmailEnv, db: DbClient, context: ThreadContext, action: SourceMutationPlan['action'], to: string, locationName: string | null) {
  if (!context.record) throw new Error('This thread has no booking or reservation')
  const fromName = await getOrganizationBrandName(db, context.thread.organization_id)
  const guest = await guestPresentation(db, {
    organizationId: context.thread.organization_id, organizationName: fromName,
    locale: context.thread.payload.guest.locale,
    productId: context.record.product_id, productTitle: context.record.product_name,
    locationId: context.record.location_id, locationName,
  })
  const labels = platformLocale(guest.locale)!.messages
  const titleKey = action === 'reject' ? 'booking.request_declined'
    : action === 'confirm' ? context.thread.kind === 'reservation' ? 'reservations.confirmed' : 'booking.confirmed'
      : context.thread.kind === 'reservation' ? 'site.reservation_cancel.cancelled_title' : 'site.experience_cancel.cancelled_title'
  const subject = `${labels[titleKey]} — ${guest.productTitle ?? guest.organizationName}`
  const guests = labels['site.experience_detail.guest_count']!.replace('{count}', `${context.record.party_size}${partySizeIsMinimum(context.thread) ? '+' : ''}`)
  const body = [guest.locationName, formatTimestamp(context.record.starts_at, guest.locale, context.record.timezone, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }), guests].filter(Boolean).join(' · ')
  const organizationLogoUrl = await organizationLogo(db, context.thread.organization_id)
  const email = await renderNotificationEmail(guestThreadStatusMessage({ locale: guest.locale, organizationName: guest.organizationName, organizationLogoUrl, heading: subject, body, manageUrl: await buildBuyerRequestActivityUrl(env, db, { organizationId: context.thread.organization_id, threadId: context.thread.id }) }), { platformDomain: getPlatformDomain(env) })
  return { to, fromName, locale: guest.locale, subject, body, email }
}

async function sendStatusUpdate(
  db: DbClient,
  context: ThreadContext,
  input: ExecuteOperationInput,
  entry: GuestThreadEntryRow,
  delivery: GuestThreadDeliveryRow,
): Promise<OperationOutcome> {
  if (!context.record) return { ok: false, status: 404, reason: 'source_not_found' }
  let outcome = delivery
  let deliveryError: string | undefined
  try {
    if (!isDeliverySent(delivery)) {
      const payload = parseEntryPayload(entry)
      const subject = payload?.subject
      const envelope = payload?.email
      if (!entry.body || typeof subject !== 'string' || !subject.trim() || typeof envelope !== 'object' || envelope === null) return conflict('Status update has no recorded email content')
      const to = Reflect.get(envelope, 'to')
      const fromName = Reflect.get(envelope, 'fromName')
      const locale = Reflect.get(envelope, 'locale')
      const html = Reflect.get(envelope, 'html')
      const text = Reflect.get(envelope, 'text')
      if (typeof to !== 'string' || !to.trim() || typeof fromName !== 'string' || !fromName.trim()
        || typeof locale !== 'string' || !platformLocale(locale)
        || typeof html !== 'string' || !html || typeof text !== 'string' || !text) return conflict('Status update has no recorded email content')
      if (typeof payload?.action !== 'string' || !['confirm', 'reject', 'cancel'].includes(payload.action)) return conflict('Status update has no recorded action')
      const booking = payload.booking
      if (typeof booking !== 'object' || booking === null) return conflict('Status update has no recorded booking facts')
      if (payload.afterStatus !== context.record.status || payload.operational_booking_id !== context.record.id
        || Reflect.get(booking, 'starts_at') !== context.record.starts_at || Reflect.get(booking, 'ends_at') !== context.record.ends_at
        || Reflect.get(booking, 'timezone') !== context.record.timezone || Reflect.get(booking, 'party_size') !== context.record.party_size
        || Reflect.get(booking, 'party_size_is_minimum') !== (partySizeIsMinimum(context.thread))
        || Reflect.get(booking, 'location_id') !== context.record.location_id || Reflect.get(booking, 'product_id') !== context.record.product_id) return conflict('Status update was superseded by a booking change')
      outcome = await deliverGuestThreadEmail(db, {
        delivery,
        env: input.env,
        to,
        fromName,
        subject,
        email: { html, text },
        submissionType: context.thread.kind,
        submissionId: context.thread.id,
      })
    }
  } catch (error) {
    deliveryError = describeErrorForTelemetry(error)
  }
  if (deliveryError === undefined && isDeliverySent(outcome)) {
    if (input.action === 'confirm') {
      // Confirming answers the booking request, not a separate guest message.
      // A retry must also leave newer conversation activity on its own state.
      await updateThreadProjectionIfLatestEntry(db, context.thread.id, entry.id, {
        conversationState: 'resolved', preserveUnansweredGuestMessages: true,
      })
    }
    return await successfulOutcome(db, context)
  }
  if (deliveryError !== undefined) console.error({ event: 'guest_status_email_failed', organization_id: context.thread.organization_id, request_id: context.thread.id, error: deliveryError })
  const currentRecord = await getThreadOperationalRecord(db, context.thread.id)
  if (!currentRecord) return { ok: false, status: 404, reason: 'source_not_found' }
  return {
    ok: false, status: 502, reason: 'delivery_failed', code: 'DELIVERY_FAILED', field: 'delivery',
    message: `Booking is ${currentRecord.status}, but the guest email failed. Retry with the same idempotency key.`,
    mutation_applied: true, operation_completed: false, request_id: context.thread.id, record: currentRecord, retry_with_same_idempotency_key: true,
  }
}

/** A business's decision on a booking, for its analytics: recorded once per booking, on the first run and on any retry. */
async function recordBookingOutcome(db: DbClient, context: ThreadContext, input: ExecuteOperationInput, decidedAt: string) {
  if (!context.record || context.record.kind !== 'booking') return
  const booking = { organizationId: input.organizationId, bookingId: context.record.id, actorUserId: input.actorUserId ?? null }
  if (input.action === 'confirm') await recordBookingDecision(db, { ...booking, decision: 'confirmed', decidedAt })
  else if (input.action === 'reject') await recordBookingDecision(db, { ...booking, decision: 'declined', decidedAt })
  else if (input.action === 'cancel') await recordBookingCancelled(db, { ...booking, cancelledBy: 'business' })
}

async function executeSourceMutation(
  db: DbClient,
  context: ThreadContext,
  input: ExecuteOperationInput,
): Promise<OperationOutcome> {
  if (!context.record) return { ok: false, status: 404, reason: 'source_not_found' }
  const dedupeKey = operationDedupeKey(input)
  const eventName = `${context.thread.kind}.${input.action}`
  const existing = await findEntryByDedupeKey(db, dedupeKey)
  if (existing) {
    if (!entryMatchesRequest(existing, eventName)) return conflict()
    const delivery = await getDeliveryById(db, deliveryDedupeKey(input))
    if (!delivery) throw new Error('Status update delivery receipt was not created')
    const outcome = await sendStatusUpdate(db, context, input, existing, delivery)
    await recordBookingOutcome(db, context, input, existing.occurred_at)
    return outcome
  }

  const plan = sourceMutationPlan(context, input.action)
  if (!plan) return conflict(`"${input.action}" is not a valid action for the current state`)
  const summary = await requestSummary(db, context.thread)
  if (plan.requiresNotification && !summary.guestEmail) {
    return { ok: false, status: 400, reason: 'no_guest_email' }
  }

  const entryId = crypto.randomUUID()
  const deliveryId = deliveryDedupeKey(input)
  const now = new Date().toISOString()
  const email = plan.requiresNotification && summary.guestEmail
    ? await renderStatusUpdate(input.env, db, context, plan.action, summary.guestEmail, summary.locationTitle)
    : null
  // Declining or cancelling a paid booking returns the payment in the same batch, once the operator approved it.
  const refundPlan = (plan.action === 'reject' || plan.action === 'cancel') && context.record
    ? await visitRefundQueries(db,{action:plan.action,organizationId:context.thread.organization_id,actorUserId:input.actorUserId,subjectType:plan.kind,subjectId:context.record.id,authorizationId:input.financialAuthorizationId,financialWritesAllowed:input.financialWritesAllowed,note:input.body,committed:{query:'EXISTS(SELECT 1 FROM activity_entries WHERE id=?)',params:[entryId]},now}) : {queries:[],guard:null}
  const queries = [
    operationEntryQuery(context, plan, input, entryId, dedupeKey, now, email,refundPlan.guard),
    sourceUpdateQuery(context, plan, input, entryId, now),
    ...(plan.afterStatus === 'cancelled' ? [resolveThreadQuery(context.thread.id, entryId, now)] : []),
    ...refundPlan.queries,
  ]
  if (plan.afterStatus === 'cancelled') queries.push(revokeReviewRequestQuery(plan.kind, context.thread.id, entryId, now))
  if (plan.requiresNotification && summary.guestEmail) {
    queries.push(deliveryReceiptQuery(context, input, entryId, deliveryId, now))
  }

  await executeBatch(db, queries, { operation: `guest thread ${plan.kind}.${plan.action}` })
  const applied = await findEntryByDedupeKey(db, dedupeKey)
  if (!applied) return conflict(`"${input.action}" is not a valid action for the current state`)
  if (!entryMatchesRequest(applied, eventName)) return conflict()
  if (plan.requiresNotification) {
    const delivery = await getDeliveryById(db, deliveryId)
    if (!delivery) throw new Error('Status update delivery receipt was not created')
    const refreshed = await loadThreadContext(db, input.threadId, input.organizationId)
    if ('ok' in refreshed) return refreshed
    const outcome = await sendStatusUpdate(db, refreshed, input, applied, delivery)
    await recordBookingOutcome(db, context, input, applied.occurred_at)
    return outcome
  }
  const outcome = await successfulOutcome(db, context)
  await recordBookingOutcome(db, context, input, applied.occurred_at)
  return outcome
}

/** A member reply, or a scheduled message the workspace saved (no member actor). */
type ReplyInput = Omit<ExecuteOperationInput, 'actorUserId'> & { actorUserId: string | null }

async function executeReply(
  db: DbClient,
  context: ThreadContext,
  input: ReplyInput,
): Promise<ReplyOutcome> {
  const body = (input.body ?? '').trim()
  const photoInput = input.photos ?? []
  const photoCount = Array.isArray(photoInput) ? photoInput.length : photoInput.sourceIds.length
  if (!body && !photoCount) return { ok: false, status: 400, reason: 'empty_body' }
  const actorUserId = input.actorUserId
  if (actorUserId === null && photoCount) throw new HTTPError({ statusCode: 400, message: 'Scheduled messages carry text only', data: { code: 'SCHEDULED_MESSAGE_PHOTOS_UNSUPPORTED', field: 'photos' } })
  const eventName = actorUserId === null ? 'thread.scheduled_message' : 'thread.member_reply'
  const purpose = actorUserId === null ? 'scheduled_message' : 'member_reply'
  const photoIdentity = Array.isArray(photoInput)
    ? await Promise.all(photoInput.map(async photo => ({ filename: photo.filename, hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', photo.bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('') })))
    : photoInput.sourceIds
  const requestHash = await creationRequestHash({ body, photos: photoIdentity })
  const channel = await getChannelThreadMapping(db, context.thread.id, context.thread.organization_id)
  if (channel) {
    if (photoCount > 1 || (photoCount && body)) throw new HTTPError({ statusCode: 400, message: 'Send one Airbnb photo at a time, separately from text', data: { code: 'CHANNEL_PHOTO_MESSAGE_INVALID', field: 'photos' } })
    const sent = await replyThroughChannex(db, input.env, { mapping: channel, body, actorUserId, idempotencyKey: input.idempotencyKey!, requestHash,
      photoCount, resolvePhotos: async () => Array.isArray(photoInput) ? photoInput : await photoInput.resolve() }).catch((error: unknown) => {
      if (error instanceof MessagePhotoRejection) return error
      throw error
    })
    if (sent instanceof MessagePhotoRejection) return { ok: false, status: 400, reason: 'invalid_photo', message: sent.message }
    if (!sent.ok) return { ...sent, reason: 'delivery_failed' }
    return successfulOutcome(db, context)
  }
  if (context.thread.kind === 'stay' && await queryFirst(db, "SELECT id FROM stays WHERE organization_id = ? AND request_id = ? AND owner = 'channel'", [context.thread.organization_id, context.thread.id])) {
    throw new HTTPError({ statusCode: 409, message: 'This channel stay has no addressable provider conversation; import its conversation before replying', data: { code: 'CHANNEL_THREAD_UNADDRESSABLE', field: 'channel_thread' } })
  }
  const matchesReply = (entry: GuestThreadEntryRow): boolean => {
    if (!entryMatchesRequest(entry, eventName, body)) return false
    const payload = JSON.parse(entry.payload_json ?? '{}') as { request_hash?: string }
    return payload.request_hash === requestHash
  }

  const dedupeKey = operationDedupeKey(input)
  const deliveryKey = deliveryDedupeKey(input)
  let entry = await findEntryByDedupeKey(db, dedupeKey)
  if (entry && !matchesReply(entry)) return conflict()
  if (entry && entry.channel !== 'web') {
    const earlier = await getDeliveryById(db, deliveryKey)
    if (!earlier || earlier.entry_id !== entry.id) throw new Error('Reply delivery receipt does not match its ledger entry')
    if (isDeliverySent(earlier)) {
      await updateThreadProjectionIfLatestEntry(db, context.thread.id, entry.id, { conversationState: 'waiting_on_guest' })
      return successfulOutcome(db, context)
    }
  }

  const recipient = await replyRecipient(db, context)
  if (typeof recipient === 'object' && recipient !== null) return recipient
  const guestEmail = recipient

  if (!entry) {
    const entryId = crypto.randomUUID()
    const deliveryId = deliveryKey
    const now = new Date().toISOString()
    const organizationId = context.thread.organization_id
    const photos = Array.isArray(photoInput) ? photoInput : await photoInput.resolve()
    if (photos.length !== photoCount) throw new Error('Resolved reply photos do not match their declared sources')
    // The photos are stored first and placed by the same batch that writes the
    // message, so a reply exists with all of its photos or not at all.
    const assetIds = actorUserId === null ? [] : await uploadMessagePhotos(db, input.env, organizationId, photos, { source: 'uploaded', userId: actorUserId })
      .catch((error: unknown) => {
        if (error instanceof MessagePhotoRejection) return error
        throw error
      })
    if (assetIds instanceof MessagePhotoRejection) return { ok: false, status: 400, reason: 'invalid_photo', message: assetIds.message }
    try {
      await executeBatch(db, [
        {
          query: `
            INSERT INTO activity_entries
              (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, body, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
            SELECT ?, id, 'message', 'request', ?, ?, ?, ?, ?, ?, ?,
                   COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id = requests.id), 0) + 1,
                   ?, ?
            FROM requests
            WHERE id = ? AND organization_id = ?
            ON CONFLICT(dedupe_key) DO NOTHING
          `,
          params: [entryId, actorUserId === null ? 'system' : 'member', actorUserId, guestEmail ? 'email' : 'web', body || null, eventName, JSON.stringify({ request_hash: requestHash }), dedupeKey, now, now, context.thread.id, context.thread.organization_id],
        },
        ...guestEmail ? [{
          query: `
            INSERT INTO guest_thread_deliveries
              (id, entry_id, channel, provider, purpose, status, created_at, updated_at)
            SELECT ?, id, 'email', ?, ?, 'pending', ?, ?
            FROM activity_entries
            WHERE id = ? AND request_id = ?
            ON CONFLICT(id) DO NOTHING
          `,
          params: [deliveryId, emailProvider(input.env), purpose, now, now, entryId, context.thread.id],
        }] : [],
        ...messagePhotoPlacements(organizationId, 'activity_entry', entryId, assetIds, now),
      ], { operation: 'guest thread reply receipt' })
    } catch (error) {
      let concurrent: GuestThreadEntryRow | null
      try {
        concurrent = await findEntryByDedupeKey(db, dedupeKey)
      } catch (readError) {
        throw new AggregateError([error, readError], 'The reply commit could not be read; its photos have been retained', { cause: readError })
      }
      if (concurrent?.id !== entryId && actorUserId !== null) await discardMessagePhotos(db, input.env, organizationId, assetIds, actorUserId, error)
      if (!concurrent || !matchesReply(concurrent)) throw error
    }
    entry = await findEntryByDedupeKey(db, dedupeKey)
  }

  if (!entry) return { ok: false, status: 404, reason: 'thread_not_found' }
  if (!matchesReply(entry)) return conflict()
  if (entry.channel === 'web') {
    const fromName = await getOrganizationBrandName(db, context.thread.organization_id)
    await notifyBuyerThread(db, { threadId: context.thread.id, entryId: entry.id, title: replySubject(context.thread.kind, fromName), message: fromName, conversation: true })
    await updateThreadProjectionIfLatestEntry(db, context.thread.id, entry.id, { conversationState: 'waiting_on_guest' })
    return await successfulOutcome(db, context)
  }
  // A reply saved for email whose address has since been removed is not sent anywhere else.
  if (!guestEmail) return { ok: false, status: 409, reason: 'delivery_failed', code: 'GUEST_EMAIL_REQUIRED', field: 'guest.email', message: 'This reply was saved to be emailed, but the guest no longer has an email address.' }
  const delivery = await getDeliveryById(db, deliveryKey)
  if (!delivery || delivery.entry_id !== entry.id) throw new Error('Reply delivery receipt does not match its ledger entry')
  if (isDeliverySent(delivery)) {
    await updateThreadProjectionIfLatestEntry(db, context.thread.id, entry.id, { conversationState: 'waiting_on_guest' })
    return successfulOutcome(db, context)
  }

  const fromName = await getOrganizationBrandName(db, context.thread.organization_id)
  const outcome = await deliverGuestThreadEmail(db, {
    delivery,
    env: input.env,
    to: guestEmail,
    fromName,
    subject: replySubject(context.thread.kind, fromName),
    email: await renderMemberReply(input.env, db, context.thread.organization_id, fromName, entry, context.thread.payload.guest.locale),
    submissionType: context.thread.kind,
    submissionId: context.thread.id,
  })

  if (isDeliverySent(outcome)) {
    await updateThreadProjectionIfLatestEntry(db, context.thread.id, entry.id, { conversationState: 'waiting_on_guest' })
    return await successfulOutcome(db, context)
  }
  if (typeof outcome.error !== 'string' || !outcome.error.trim()) {
    throw new HTTPError({ statusCode: 502, statusMessage: 'Failed email delivery did not provide its error', data: { code: 'INVALID_DELIVERY_RESPONSE', field: 'error' } })
  }
  return { ok: false, status: 502, reason: 'delivery_failed', code: 'DELIVERY_FAILED', field: 'delivery', message: outcome.error }
}

/**
 * Where a reply goes besides the thread. A conversation with a guest email is
 * emailed there, a direct stay using its current contact. One without reaches
 * the guest's account inbox once the guest has joined it through an invite,
 * and is emailed too when that account has a verified email; null means the
 * account inbox alone. Without either there is nowhere to reply to.
 */
async function replyRecipient(db: DbClient, context: ThreadContext): Promise<string | null | NotFoundOutcome | Extract<OperationOutcome, { reason: 'guest_invite_required' }>> {
  let guestEmail = context.thread.payload.guest.email
  if (context.thread.kind === 'stay') {
    const stay = await queryFirst<{ guest_email: string | null }>(db, 'SELECT guest_email FROM stays WHERE organization_id = ? AND request_id = ?', [context.thread.organization_id, context.thread.id])
    if (!stay) return { ok: false, status: 404, reason: 'source_not_found' }
    guestEmail = stay.guest_email?.trim() || null
  }
  if (guestEmail) return guestEmail
  if (context.thread.user_id === null) {
    return { ok: false, status: 409, reason: 'guest_invite_required', code: 'GUEST_INVITE_REQUIRED', field: 'request_id', message: 'This guest has no email on file. Invite them to the conversation first.' }
  }
  const account = await queryFirst<{ email: string }>(db, 'SELECT email FROM user WHERE id = ? AND "emailVerified" = 1 AND COALESCE("isAnonymous", 0) = 0', [context.thread.user_id])
  return account?.email ?? null
}

const ENDED_OCCURRENCE_MESSAGE = 'This conversation is past because its booking has ended'

/**
 * File a conversation under Past, or bring a manually archived one back.
 *
 * Whether either is allowed is `resolveGuestThreadMailbox`'s answer, and the
 * batch carries the same condition so a thread that changed after this read
 * gets no entry and no write. A retried key finds its entry and changes
 * nothing: not the timestamp, not the actor, not the order of the inbox.
 */
async function executeMailboxTransition(
  db: DbClient,
  context: ThreadContext,
  input: ExecuteOperationInput,
  transition: 'archive' | 'unarchive',
): Promise<OperationOutcome> {
  const dedupeKey = operationDedupeKey(input)
  const eventName = transition === 'archive' ? 'thread.archived' : 'thread.unarchived'
  const existing = await findEntryByDedupeKey(db, dedupeKey)
  if (existing) {
    if (!entryMatchesRequest(existing, eventName) || existing.request_id !== context.thread.id) return conflict()
    return await successfulOutcome(db, context)
  }

  const now = new Date().toISOString()
  const state = resolveGuestThreadMailbox(context.thread, context.record, now)
  if (transition === 'archive' && !state.canArchive) {
    return conflict(state.occurrenceEnded ? ENDED_OCCURRENCE_MESSAGE : 'This conversation is already archived')
  }
  if (transition === 'unarchive' && !state.canUnarchive) {
    return conflict(state.occurrenceEnded ? ENDED_OCCURRENCE_MESSAGE : 'This conversation is not archived')
  }

  const [entry, update] = await executeBatch(db, mailboxTransitionQueries({
    transition,
    threadId: context.thread.id,
    organizationId: context.thread.organization_id,
    actorUserId: input.actorUserId,
    entryId: crypto.randomUUID(),
    dedupeKey,
    now,
  }), { operation: `guest thread ${eventName}` })
  const recorded = entry?.meta?.changes ?? 0
  const moved = update?.meta?.changes ?? 0
  if (recorded !== moved) throw new Error(`${eventName} recorded ${recorded} entries for ${moved} thread writes`)
  if (moved === 1) return await successfulOutcome(db, context)

  // Nothing landed: either the same key won a concurrent request, or the
  // thread moved between the read above and the batch.
  const applied = await findEntryByDedupeKey(db, dedupeKey)
  if (applied && entryMatchesRequest(applied, eventName) && applied.request_id === context.thread.id) {
    return await successfulOutcome(db, context)
  }
  const reread = await loadThreadContext(db, input.threadId, input.organizationId)
  if ('ok' in reread) return reread
  const after = resolveGuestThreadMailbox(reread.thread, reread.record, new Date().toISOString())
  return conflict(after.occurrenceEnded ? ENDED_OCCURRENCE_MESSAGE : 'This conversation changed; reload it and try again')
}

/**
 * Report the guest, or block and report them: the report and the block land
 * together, and KrabiClaw's operators are emailed before the member hears it
 * worked. The report's id comes from the key, so a retry files nothing new.
 */
async function executeReport(db: DbClient, context: ThreadContext, input: ExecuteOperationInput, block: boolean): Promise<OperationOutcome> {
  const reason = reportReason(input.reason)
  const id = contentReportId(input.actorUserId, input.idempotencyKey as string)
  await executeBatch(db, [
    contentReportInsert({
      id, organizationId: context.thread.organization_id, reporterUserId: input.actorUserId, subject: 'guest_thread',
      requestId: context.thread.id, teamMessageId: null, authorUserId: context.thread.user_id, reason,
      excerpt: await guestThreadExcerpt(db, context.thread.id), blocked: block,
    }),
    // Only the request that filed the report blocks: a retry of an earlier
    // block must not undo an unblock made since.
    ...(block ? [{
      query: 'UPDATE requests SET blocked_at = COALESCE(blocked_at, ?) WHERE organization_id = ? AND id = ? AND changes() = 1',
      params: [new Date().toISOString(), context.thread.organization_id, context.thread.id],
    }] : []),
  ], { operation: block ? 'Block and report a guest' : 'Report a guest conversation' })
  await assertSameReport(db, id, { subject: 'guest_thread', requestId: context.thread.id, teamMessageId: null, reason, blocked: block })
  await announceContentReport(input.env, db, id)
  return await successfulOutcome(db, context)
}

/** Bring a blocked guest's conversation back to the inbox; the report stays filed. */
async function executeUnblock(db: DbClient, context: ThreadContext): Promise<OperationOutcome> {
  const [update] = await executeBatch(db, [{
    query: 'UPDATE requests SET blocked_at = NULL WHERE organization_id = ? AND id = ? AND blocked_at IS NOT NULL',
    params: [context.thread.organization_id, context.thread.id],
  }], { operation: 'Unblock a guest' })
  if ((update?.meta?.changes ?? 0) === 0 && context.thread.blocked_at === null) return conflict('This guest is not blocked')
  return await successfulOutcome(db, context)
}

export async function executeGuestThreadOperation(db: DbClient, input: ExecuteOperationInput): Promise<OperationOutcome> {
  if (!input.idempotencyKey) return { ok: false, status: 400, reason: 'missing_idempotency_key' }
  const context = await loadThreadContext(db, input.threadId, input.organizationId)
  if ('ok' in context) return context

  if (input.action === 'reply') return await executeReply(db, context, input)
  if (input.action === 'archive' || input.action === 'unarchive') {
    return await executeMailboxTransition(db, context, input, input.action)
  }
  if (input.action === 'report' || input.action === 'block') return await executeReport(db, context, input, input.action === 'block')
  if (input.action === 'unblock') return await executeUnblock(db, context)
  if (input.action === 'no_show') return await executeNoShow(db, context, input)
  return await executeSourceMutation(db, context, input)
}

const NO_SHOW_TABLES = { reservation: 'reservations', booking: 'bookings', stay: 'stays' } as const

/**
 * Record that the guest did not come. The visit keeps its status; its review
 * invitation is never sent, and a link already sent stops working, in the
 * same batch as the ledger entry that says who recorded it.
 */
async function executeNoShow(db: DbClient, context: ThreadContext, input: ExecuteOperationInput): Promise<OperationOutcome> {
  const record = context.record
  if (!record) return { ok: false, status: 404, reason: 'source_not_found' }
  const dedupeKey = operationDedupeKey(input)
  const eventName = `${record.kind}.no_show`
  const existing = await findEntryByDedupeKey(db, dedupeKey)
  if (existing) return entryMatchesRequest(existing, eventName) ? await successfulOutcome(db, context) : conflict()
  const now = new Date().toISOString()
  if (!canMarkNoShow(record, now)) return conflict('Only a confirmed visit that has started and has no review can be marked as a no-show')
  const table = NO_SHOW_TABLES[record.kind]
  const entryId = crypto.randomUUID()
  await executeBatch(db, [
    {
      query: `
        INSERT INTO activity_entries
          (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, body, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
        SELECT ?, gt.id, 'operation', 'request', 'member', ?, NULL, 'Marked as a no-show', ?, ?, ?,
               COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id = gt.id), 0) + 1, ?, ?
        FROM requests gt
        WHERE gt.id = ? AND gt.organization_id = ? AND gt.review_id IS NULL
          AND EXISTS (SELECT 1 FROM ${table} src WHERE src.id = ? AND src.request_id = gt.id AND src.organization_id = gt.organization_id AND src.status = 'confirmed' AND src.no_show_at IS NULL)
        ON CONFLICT(dedupe_key) DO NOTHING
      `,
      params: [entryId, input.actorUserId, eventName, JSON.stringify({ action: 'no_show', operational_booking_id: record.id }), dedupeKey, now, now,
        context.thread.id, context.thread.organization_id, record.id],
    },
    {
      query: `UPDATE ${table} SET no_show_at = ?, updated_at = ?${table === 'stays' ? ', version = version + 1' : ''}
        WHERE id = ? AND no_show_at IS NULL AND EXISTS (SELECT 1 FROM activity_entries WHERE id = ?)`,
      params: [now, now, record.id, entryId],
    },
    revokeReviewRequestQuery(record.kind, context.thread.id, entryId, now),
  ], { operation: `guest thread ${eventName}` })
  const applied = await findEntryByDedupeKey(db, dedupeKey)
  if (!applied) return conflict('The visit changed before it could be marked as a no-show')
  if (!entryMatchesRequest(applied, eventName)) return conflict()
  return await successfulOutcome(db, context)
}

/**
 * Send a workspace's saved scheduled message through the conversation's own
 * address, with the same ledger entry and delivery receipt as a reply. It has
 * no member actor; the key makes a repeated run find its first attempt.
 */
/**
 * A reply nobody is sending right now: an automatic message (no author), or a
 * member's send-later message, sent as that member's own reply.
 */
export async function sendScheduledGuestReply(db: DbClient, input: { threadId: string; organizationId: string; body: string; idempotencyKey: string; actorUserId?: string; env: ExecuteOperationInput['env'] }): Promise<{ outcome: ReplyOutcome; entryId: string | null }> {
  const context = await loadThreadContext(db, input.threadId, input.organizationId)
  if ('ok' in context) return { outcome: context, entryId: null }
  const outcome = await executeReply(db, context, { ...input, action: 'reply', actorUserId: input.actorUserId ?? null })
  const entry = await findEntryByDedupeKey(db, operationDedupeKey(input))
  return { outcome, entryId: entry?.id ?? null }
}
