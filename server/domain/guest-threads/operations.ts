import { HTTPError } from 'nitro'
import { bookingStatusQuery } from '~/server/domain/bookings'
import { visitRefundQueries } from '~/server/domain/payments/visit-refund'
import { recordBookingCancelled, recordBookingDecision } from '~/server/domain/booking-analytics'
import { execute, executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { shouldSendRealEmail } from '~/server/utils/email-delivery'
import type { ReplyEmailEnv } from '~/server/utils/submission-messages'
import { bookingDay, canMarkNoShow, getGuestRequest, getThreadOperationalRecord, noStayRequestPaymentInFlightSql, requestActions, requestSummary, stayRequestPayBySql, stayRequestRespondBySql, validateGuestRequest, type GuestRequest, type ThreadOperationalRecord } from '~/server/domain/requests'
import type { StayAccess } from '~/server/domain/stays'
import { revokeReviewRequestQuery } from '~/server/utils/review-requests'
import { deliverGuestThreadEmail, getDeliveryById, isDeliverySent } from './deliveries'
import { MEMBER_REPLY_EVENT, SCHEDULED_MESSAGE_EVENT, MessageDedupeConflictError, MessageStateConflictError, appendChatMessage, conversationMessageGuard, findMessageByDedupeKey, messageQueries, parseMessagePayload, type ConversationRow, type MessageRow } from '~/server/domain/conversations'
import { listMessagePhotos, MessagePhotoRejection, messagePhotoCount, messagePhotoHashes, type MessagePhotoInput } from './attachments'
import type { UploadResolvedMediaInput } from '~/server/utils/media-upload'
import { conversationReplyTaskQueries, conversationTaskQueries, reconcileConversationTasks } from './repository'
import { renderNotificationEmail } from '~/server/emails/render'
import { guestThreadReplyMessage, guestThreadStatusMessage } from '~/server/notifications/guest-events'
import { organizationLogo } from '~/server/notifications/hero'
import { getPlatformDomain, buildBuyerRequestActivityUrl } from '~/server/utils/dashboard-notification-links'
import { isBookingComplete, isChannelManagedStay, STAY_CHANNEL_LABELS } from '~/shared/bookings'
import { creationRequestHash } from '~/server/utils/organization-events'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { guestPresentation } from '~/server/utils/notifications'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import type { CloudflareEnv } from '~/server/utils/auth'
import { platformLocale } from '~/shared/platform-locales'
import { formatCalendarRange, formatTimestamp } from '~/utils/timezone'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'
import { guestThreadChannel, replyThroughChannex, type ChannelThreadMapping } from './channel-messages'
import type { ChannexEnv, ChannexError } from '~/server/integrations/channex/client'
import { announceContentReport, assertSameReport, contentReportId, contentReportInsert, guestThreadExcerpt, reportReason, type ContentReportEnv } from '~/server/domain/content-reports'
import type {
  GuestThreadDeliveryProvider,
  GuestThreadDeliveryRow,
  GuestThreadRow,
  GuestThreadSubmissionType,
} from './types'

// Whether the business owes a reply is its open guest_reply task
// (server/domain/tasks.ts): a reply, a cancellation, archiving or blocking
// closes it. There is no separate resolve or reopen. Archiving is each
// person's own (conversations.ts archiveQuery), not an operation here.
type SuccessfulOperationOutcome = { ok: true; status: 200; thread: GuestThreadRow; availableActions: string[] }

export type OperationFailure =
  | { ok: false; status: 404; reason: 'thread_not_found' }
  | { ok: false; status: 404; reason: 'source_not_found' }
  | { ok: false; status: 409; reason: 'invalid_transition'; message: string }
  | { ok: false; status: 400; reason: 'empty_body' }
  | { ok: false; status: 409; reason: 'guest_unreachable'; code: 'GUEST_UNREACHABLE'; field: 'conversation_id'; message: string }
  | { ok: false; status: 400; reason: 'missing_idempotency_key' }
  | { ok: false; status: 400; reason: 'invalid_photo'; message: string }
  | { ok: false; status: 409 | 502; reason: 'delivery_failed'; code: string; field: string; message: string; mutation_applied?: true; operation_completed?: false; conversation_id?: string; record?: ThreadOperationalRecord; retry_with_same_idempotency_key?: boolean; provider_error?: ChannexError['data'] }

export type OperationOutcome = SuccessfulOperationOutcome | OperationFailure
type ReplyOutcome = { ok: true; status: 200; message: MessageRow } | OperationFailure
type ModerationOutcome = { ok: true; status: 200 } | OperationFailure
type NotFoundOutcome = Extract<OperationOutcome, { status: 404 }>

export type ExecuteOperationInput = {
  conversation?: ConversationRow
  principal?: MemberAccessPrincipal
  threadId: string
  organizationId: string
  action: string
  body?: string
  /** Why a member reports or blocks the guest. */
  reason?: string
  env: ReplyEmailEnv & UploadResolvedMediaInput['env'] & ChannexEnv & ContentReportEnv & CloudflareEnv
  idempotencyKey?: string
  actorUserId: string
  financialAuthorizationId?: string
  financialWritesAllowed?: boolean
  version?: number
}

interface ThreadContext {
  thread: GuestThreadRow
  /**
   * The booking this thread refers to, loaded once.
   *
   * Operational status lives there, not on the thread, so every transition
   * below reads and writes that record. A contact thread has none.
   */
  record: ThreadOperationalRecord | null
}

interface SourceMutationPlan {
  kind: 'booking'
  action: 'confirm' | 'reject' | 'cancel'
  beforeStatus: string
  afterStatus: 'confirmed' | 'cancelled' | 'pending'
  payBy?: string
  requiresNotification: boolean
}

async function loadThreadContext(
  db: DbClient,
  threadId: string,
  organizationId: string,
  conversation?: ConversationRow,
): Promise<ThreadContext | NotFoundOutcome> {
  if (conversation && (conversation.id !== threadId || conversation.organization_id !== organizationId || conversation.kind === 'team')) {
    throw new Error('The authorized conversation does not match the operation')
  }
  const [thread, record] = await Promise.all([
    conversation ? validateGuestRequest(db, conversation) : getGuestRequest(db, threadId, organizationId),
    getThreadOperationalRecord(db, threadId, conversation),
  ])
  if (!thread) return { ok: false, status: 404, reason: 'thread_not_found' }
  return { thread, record }
}

export function operationDedupeKey(input: Pick<ExecuteOperationInput, 'threadId' | 'idempotencyKey'>): string {
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

function entryMatchesRequest(entry: MessageRow, eventName: string, body?: string): boolean {
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

async function sourceMutationPlan(context: ThreadContext, action: string, now: string): Promise<SourceMutationPlan | null> {
  if (context.thread.kind === 'contact' || !context.record) return null
  const kind = 'booking' as const
  const { status: beforeStatus, respond_by, pay_by, unit } = context.record
  if (unit === 'nights') {
    if (beforeStatus !== 'pending' || !respond_by || (action !== 'cancel' && (pay_by || respond_by <= now))) return null
    if (action === 'cancel' && context.record.payment_processing) return null
    if (action === 'reject' || action === 'cancel') return { kind, action, beforeStatus, afterStatus: 'cancelled', requiresNotification: true }
    if (action !== 'confirm') return null
    const { stayRequestDeadline } = await import('~/server/domain/stays')
    const payBy = stayRequestDeadline(now, context.record.starts_at, context.record.timezone)
    return payBy > now ? { kind, action, beforeStatus, afterStatus: 'pending', payBy, requiresNotification: true } : null
  }
  // Pending review and confirmed appointments share the same temporal guard.
  if (context.record.ends_at <= now || isBookingComplete(context.record, now)) return null
  if (beforeStatus === 'pending' && (action === 'confirm' || action === 'reject')) {
    return { kind, action, beforeStatus, afterStatus: action === 'confirm' ? 'confirmed' : 'cancelled', requiresNotification: true }
  }
  if ((beforeStatus === 'confirmed' || beforeStatus === 'pending') && action === 'cancel') {
    return { kind, action, beforeStatus, afterStatus: 'cancelled', requiresNotification: true }
  }
  return null
}


async function operationEntryQueries(
  db: DbClient,
  context: ThreadContext,
  plan: SourceMutationPlan,
  input: ExecuteOperationInput,
  entryId: string,
  dedupeKey: string,
  now: string,
  email: Awaited<ReturnType<typeof renderStatusUpdate>> | null,
  financialGuard: BatchQuery | null = null,
): Promise<BatchQuery[]> {
  const record = context.record!
  const stay = record.unit === 'nights' ? await import('~/server/domain/stays') : null
  const channel = stay && plan.payBy ? await stay.stayChannelAvailability(db, {
    organizationId: record.organization_id, productId: record.product_id,
    checkIn: bookingDay(record.starts_at, record.timezone), checkOut: bookingDay(record.ends_at, record.timezone),
  }) : null
  const sourceGuard = stay
    ? `src.product_session_id IS NULL AND src.owner='app' AND src.channel='direct' AND ${stayRequestRespondBySql('src')} IS NOT NULL
      AND ${noStayRequestPaymentInFlightSql('c.id')}
      ${plan.action !== 'cancel' ? `AND ${stayRequestRespondBySql('src')} > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${stayRequestPayBySql('c.id')} IS NULL` : ''}
      ${channel ? `AND ${channel.query}` : ''}`
    : `src.product_session_id IS NOT NULL AND src.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  return messageQueries({
    id: entryId, conversationId: context.thread.id, authorKind: 'krabiclaw', authorUserId: input.actorUserId,
    body: email?.body ?? null, eventName: `${plan.kind}.${plan.action}`, dedupeKey, occurredAt: now,
    payload: {
      action: plan.action, beforeStatus: plan.beforeStatus, afterStatus: plan.afterStatus,
      ...(plan.payBy ? { pay_by: plan.payBy } : {}),
      booking_id: record.id,
      subject: email?.subject ?? null,
      email: email ? { to: email.to, fromName: email.fromName, locale: email.locale, ...email.email } : null,
      booking: {
        starts_at: record.starts_at, ends_at: record.ends_at,
        timezone: record.timezone, party_size: record.party_size,
        party_size_is_minimum: record.party_size_is_minimum,
        location_id: record.location_id, product_id: record.product_id,
      },
    },
    // Guarded on the state of the record that holds the seats, because the
    // conversation has no status of its own: two dashboards acting at once must
    // not both write a message for the same transition. The booking has not
    // finished yet, and is still the one the caller read.
    guard: {
      sql: `c.organization_id = ? AND c.kind = ? AND c.last_message_at = ?
        AND EXISTS (SELECT 1 FROM bookings src
                     WHERE src.id = c.booking_id AND src.organization_id = c.organization_id AND src.status = ? AND ${sourceGuard}
                       AND src.version = ?
                       AND json_array(src.id,src.party_size,src.product_id,src.starts_at,src.ends_at,src.timezone,src.location_id,src.party_size_is_minimum)=json_array(?,CAST(? AS INTEGER),?,?,?,?,?,CAST(? AS INTEGER)))
        AND (${financialGuard?.query ?? '1=1'})`,
      params: [context.thread.organization_id, plan.kind, context.thread.last_message_at, plan.beforeStatus, ...(stay ? [now] : []), ...(channel?.params ?? []), record.version,
        record.id, record.party_size, record.product_id, record.starts_at, record.ends_at, record.timezone, record.location_id, Number(record.party_size_is_minimum),
        ...(financialGuard?.params ?? [])],
    },
  }).queries
}

/**
 * Move the operational record, not the thread.
 *
 * Cancelling here is what releases the seats, because availability is always
 * the sum over live bookings — there is no counter to keep in step. The
 * transition is guarded on the status the caller read, so two dashboards
 * confirming at once cannot both win.
 */
function sourceUpdateQuery(context: ThreadContext, plan: SourceMutationPlan, entryId: string, now: string): BatchQuery {
  // The first ledger insert already checked the live source and end time.
  // This statement follows it in the same atomic batch, without a second clock gate.
  return bookingStatusQuery({
    organizationId: context.thread.organization_id, bookingId: context.record!.id, now,
    guard: { query: 'status = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)', params: [plan.beforeStatus, entryId] },
    ...(plan.afterStatus === 'cancelled' ? { status: 'cancelled', reason: plan.action === 'reject' ? 'host_rejected' : 'host_cancelled' } : { status: plan.afterStatus }),
  })
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
        (id, message_id, channel, provider, purpose, status, created_at, updated_at)
      SELECT ?, id, 'email', ?, 'status_update', 'pending', ?, ?
      FROM messages
      WHERE id = ? AND conversation_id = ?
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
  return `Re: your booking at ${fromName}`
}

/**
 * Guest-facing inbox mail renders through the shared shell like every other
 * outbound message. A member's reply leads with their own words; a status
 * update leads with what changed.
 */
async function renderMemberReply(env: ReplyEmailEnv, db: DbClient, organizationId: string, organizationName: string, entry: MessageRow, locale: string | undefined, photoCount: number) {
  const [guest, organizationLogoUrl, photoRows, manageUrl] = await Promise.all([
    guestPresentation(db, { organizationId, organizationName, locale }),
    organizationLogo(db, organizationId),
    photoCount ? listMessagePhotos(db, 'message', [entry.id]) : null,
    buildBuyerRequestActivityUrl(env, db, { organizationId, threadId: entry.conversation_id }),
  ])
  const photos = photoRows?.get(entry.id) ?? []
  return renderNotificationEmail(guestThreadReplyMessage({
    locale: guest.locale,
    organizationName: guest.organizationName,
    organizationLogoUrl,
    body: entry.body ?? '',
    manageUrl,
    photos: photos.map(photo => ({ imageUrl: photo.url, alt: photo.alt ?? `Photo from ${organizationName}` })),
  }), { platformDomain: getPlatformDomain(env) })
}

async function renderStatusUpdate(env: ReplyEmailEnv, db: DbClient, context: ThreadContext, plan: SourceMutationPlan, to: string, locationName: string | null) {
  if (!context.record) throw new Error('This thread has no booking')
  const { action, payBy } = plan
  const fromName = await getOrganizationBrandName(db, context.thread.organization_id)
  const guest = await guestPresentation(db, {
    organizationId: context.thread.organization_id, organizationName: fromName,
    locale: context.thread.payload.guest.locale,
    productId: context.record.product_id, productTitle: context.record.product_name,
    locationId: context.record.location_id, locationName,
  })
  const labels = platformLocale(guest.locale)!.messages
  const table = context.record.product_kind === 'table'
  const titleKey = action === 'reject' ? 'booking.request_declined'
    : action === 'confirm' ? table ? 'reservations.confirmed' : 'booking.confirmed'
      : table ? 'site.reservation_cancel.cancelled_title' : 'site.experience_cancel.cancelled_title'
  const subject = `${payBy ? labels['booking.stay_request_approved'] : labels[titleKey]} — ${guest.productTitle ?? guest.organizationName}`
  const org = await queryFirst<{ vertical: string | null }>(db, 'SELECT vertical FROM organization WHERE id = ?', [context.thread.organization_id])
  const presentation = resolveBookingPresentation(context.record.product_kind, org?.vertical)
  const countStr = `${context.record.party_size}${context.record.party_size_is_minimum ? '+' : ''}`
  const guests = presentation.formatCount(countStr)
  const dates = context.record.unit === 'nights'
    ? formatCalendarRange(bookingDay(context.record.starts_at, context.record.timezone), bookingDay(context.record.ends_at, context.record.timezone), guest.locale)
    : formatTimestamp(context.record.starts_at, guest.locale, context.record.timezone, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  const deadline = payBy ? labels['booking.stay_request_pay_by']!.replace('{deadline}', formatTimestamp(payBy, guest.locale, context.record.timezone, { dateStyle: 'medium', timeStyle: 'short' })) : null
  const body = [[guest.locationName, dates, guests].filter(Boolean).join(' · '), deadline].filter(Boolean).join('\n')
  const organizationLogoUrl = await organizationLogo(db, context.thread.organization_id)
  const manageUrl = await buildBuyerRequestActivityUrl(env, db, { organizationId: context.thread.organization_id, threadId: context.thread.id })
  if (payBy && !manageUrl) throw new Error('A stay request has no guest activity link')
  const email = await renderNotificationEmail(guestThreadStatusMessage({ locale: guest.locale, organizationName: guest.organizationName, organizationLogoUrl, heading: subject, body,
    ...(payBy ? { actionUrl: manageUrl, actionLabel: labels['booking.stay_request_pay'] } : { manageUrl }),
  }), { platformDomain: getPlatformDomain(env) })
  return { to, fromName, locale: guest.locale, subject, body, email }
}

async function sendStatusUpdate(
  db: DbClient,
  context: ThreadContext,
  input: ExecuteOperationInput,
  entry: MessageRow,
  delivery: GuestThreadDeliveryRow,
): Promise<OperationOutcome> {
  if (!context.record) return { ok: false, status: 404, reason: 'source_not_found' }
  let outcome = delivery
  let deliveryError: string | undefined
  try {
    if (!isDeliverySent(delivery)) {
      const payload = parseMessagePayload(entry)
      const subject = payload.subject
      const envelope = payload.email
      if (!entry.body || typeof subject !== 'string' || !subject.trim() || typeof envelope !== 'object' || envelope === null) return conflict('Status update has no recorded email content')
      const to = Reflect.get(envelope, 'to')
      const fromName = Reflect.get(envelope, 'fromName')
      const locale = Reflect.get(envelope, 'locale')
      const html = Reflect.get(envelope, 'html')
      const text = Reflect.get(envelope, 'text')
      if (typeof to !== 'string' || !to.trim() || typeof fromName !== 'string' || !fromName.trim()
        || typeof locale !== 'string' || !platformLocale(locale)
        || typeof html !== 'string' || !html || typeof text !== 'string' || !text) return conflict('Status update has no recorded email content')
      if (typeof payload.action !== 'string' || !['confirm', 'reject', 'cancel'].includes(payload.action)) return conflict('Status update has no recorded action')
      const booking = payload.booking
      if (typeof booking !== 'object' || booking === null) return conflict('Status update has no recorded booking facts')
      if (payload.afterStatus !== context.record.status || payload.booking_id !== context.record.id
        || Reflect.get(booking, 'starts_at') !== context.record.starts_at || Reflect.get(booking, 'ends_at') !== context.record.ends_at
        || Reflect.get(booking, 'timezone') !== context.record.timezone || Reflect.get(booking, 'party_size') !== context.record.party_size
        || Reflect.get(booking, 'party_size_is_minimum') !== context.record.party_size_is_minimum
        || Reflect.get(booking, 'location_id') !== context.record.location_id || Reflect.get(booking, 'product_id') !== context.record.product_id) return conflict('Status update was superseded by a booking change')
      outcome = await deliverGuestThreadEmail(db, {
        delivery,
        env: input.env,
        to,
        fromName,
        subject,
        email: { html, text },
        conversationId: context.thread.id,
      })
    }
  } catch (error) {
    deliveryError = describeErrorForTelemetry(error)
  }
  if (deliveryError === undefined && isDeliverySent(outcome)) {
    if (input.action === 'confirm') {
      // Confirming answers the booking request, not a separate guest message.
      await reconcileConversationTasks(db, context.thread.id)
    }
    return await successfulOutcome(db, context)
  }
  if (deliveryError !== undefined) console.error({ event: 'guest_status_email_failed', organization_id: context.thread.organization_id, conversation_id: context.thread.id, error: deliveryError })
  const currentRecord = await getThreadOperationalRecord(db, context.thread.id)
  if (!currentRecord) return { ok: false, status: 404, reason: 'source_not_found' }
  return {
    ok: false, status: 502, reason: 'delivery_failed', code: 'DELIVERY_FAILED', field: 'delivery',
    message: `Booking is ${currentRecord.status}, but the guest email failed. Retry with the same idempotency key.`,
    mutation_applied: true, operation_completed: false, conversation_id: context.thread.id, record: currentRecord, retry_with_same_idempotency_key: true,
  }
}

/** A business's decision on a booking, for its analytics: recorded once per booking, on the first run and on any retry. */
async function recordBookingOutcome(db: DbClient, context: ThreadContext, input: ExecuteOperationInput, decidedAt: string) {
  if (!context.record || context.record.unit !== 'slot') return
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
  const nightly = context.record.unit === 'nights'
  const eventName = `${context.thread.kind}.${input.action}`
  const existing = await findMessageByDedupeKey(db, dedupeKey)
  if (existing) {
    if (!entryMatchesRequest(existing, eventName)) return conflict()
    if (nightly) await (await import('~/server/domain/stays')).publishStayRequest(db, input.env, input.organizationId, context.record.id)
    else await (await import('~/server/domain/scheduled-guest-messages')).planSourceMessages(db, context.thread.organization_id, context.record.id)
    const delivery = await getDeliveryById(db, deliveryDedupeKey(input))
    if (!delivery) throw new Error('Status update delivery receipt was not created')
    const outcome = await sendStatusUpdate(db, context, input, existing, delivery)
    await recordBookingOutcome(db, context, input, existing.occurred_at)
    return outcome
  }

  const now = new Date().toISOString()
  const plan = await sourceMutationPlan(context, input.action, now)
  if (!plan) return conflict(`"${input.action}" is not a valid action for the current state`)
  if (input.version !== undefined && context.record.version !== input.version) return conflict('This booking changed since you opened it. Reload and try again.')
  const summary = await requestSummary(db, context.thread)

  const entryId = crypto.randomUUID()
  const deliveryId = deliveryDedupeKey(input)
  // A booking always has its guest's email (requests.ts `guest`); one without is broken data.
  if (plan.requiresNotification && !summary.guestEmail) throw new Error(`${plan.kind} conversation ${context.thread.id} has no guest email`)
  const email = plan.requiresNotification && summary.guestEmail
    ? await renderStatusUpdate(input.env, db, context, plan, summary.guestEmail, summary.locationTitle)
    : null
  // Declining or cancelling a paid booking returns the payment in the same batch, once the operator approved it.
  const refundPlan = (plan.action === 'reject' || plan.action === 'cancel') && context.record
    ? await visitRefundQueries(db,{action:plan.action,organizationId:context.thread.organization_id,actorUserId:input.actorUserId,bookingId:context.record.id,authorizationId:input.financialAuthorizationId,financialWritesAllowed:input.financialWritesAllowed,note:input.body,committed:{query:'EXISTS(SELECT 1 FROM messages WHERE id=?)',params:[entryId]},now}) : {queries:[],guard:null}
  const stay = nightly ? await import('~/server/domain/stays') : null
  const nightRelease = stay && plan.afterStatus === 'cancelled'
    ? stay.stayRequestReleaseQueries({ ...context.record, check_in_date: bookingDay(context.record.starts_at, context.record.timezone),
      check_out_date: bookingDay(context.record.ends_at, context.record.timezone) }, input.organizationId, now)
    : []
  const queries = [
    ...await operationEntryQueries(db, context, plan, input, entryId, dedupeKey, now, email, refundPlan.guard),
    sourceUpdateQuery(context, plan, entryId, now),
    ...nightRelease,
    ...refundPlan.queries,
    // An approval closes the booking's review; a cancellation also answers what the guest asked before it.
    ...conversationTaskQueries(context.thread.id, now),
  ]
  if (plan.afterStatus === 'cancelled') queries.push(revokeReviewRequestQuery(context.record.id, entryId, now))
  if (plan.requiresNotification) {
    queries.push(deliveryReceiptQuery(context, input, entryId, deliveryId, now))
  }

  await executeBatch(db, queries, { operation: `guest thread ${plan.kind}.${plan.action}` })
  const applied = await findMessageByDedupeKey(db, dedupeKey)
  if (!applied) return conflict(`"${input.action}" is not a valid action for the current state`)
  if (!entryMatchesRequest(applied, eventName)) return conflict()
  // A confirmed, declined or cancelled visit's automatic messages follow it.
  if (stay) await stay.publishStayRequest(db, input.env, input.organizationId, context.record.id)
  else await (await import('~/server/domain/scheduled-guest-messages')).planSourceMessages(db, context.thread.organization_id, context.record.id)
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
type ReplyInput = Pick<ExecuteOperationInput, 'conversation' | 'threadId' | 'organizationId' | 'env' | 'idempotencyKey'> & {
  actorUserId: string | null
  body: string
  photos?: MessagePhotoInput
  retryMessageId?: string
}

/** The outbound provider prepares one canonical write and decides when dispatch may commit it. */
export async function deliverGuestReply(db: DbClient, input: ReplyInput, append: typeof appendChatMessage): Promise<ReplyOutcome> {
  const { threadId, organizationId, conversation, actorUserId, idempotencyKey } = input
  if (!idempotencyKey) return { ok: false, status: 400, reason: 'missing_idempotency_key' }
  const body = input.body.trim()
  const photoInput = input.photos ?? []
  const photoCount = messagePhotoCount(photoInput)
  if (!body && !photoCount) return { ok: false, status: 400, reason: 'empty_body' }
  if (actorUserId === null && photoCount) throw new HTTPError({ statusCode: 400, message: 'Scheduled messages carry text only', data: { code: 'SCHEDULED_MESSAGE_PHOTOS_UNSUPPORTED', field: 'photos' } })
  const eventName = actorUserId === null ? SCHEDULED_MESSAGE_EVENT : MEMBER_REPLY_EVENT
  const purpose = actorUserId === null ? 'scheduled_message' : 'member_reply'
  const photoIdentity = Array.isArray(photoInput)
    ? (await messagePhotoHashes(photoInput)).map((hash, index) => ({ filename: photoInput[index]!.filename, hash }))
    : photoInput.sourceIds
  const dedupeKey = operationDedupeKey(input)
  const scheduledId = actorUserId !== null && idempotencyKey.startsWith('send-later:') ? idempotencyKey.slice('send-later:'.length) : null
  const [thread, requestHash, recorded, channelFacts, scheduled] = await Promise.all([
    conversation ? validateGuestRequest(db, conversation) : getGuestRequest(db, threadId, organizationId),
    creationRequestHash({ body, photos: photoIdentity }),
    findMessageByDedupeKey(db, dedupeKey),
    guestThreadChannel(db, threadId, organizationId),
    scheduledId === null ? null : queryFirst<{ id: string; status: string; message_id: string | null; author_user_id: string; body: string }>(db, `
      SELECT id, status, message_id, author_user_id, body FROM scheduled_guest_messages
        WHERE id = ? AND organization_id = ? AND conversation_id = ? AND author_user_id IS NOT NULL`, [scheduledId, organizationId, threadId]),
  ])
  if (!thread) return { ok: false, status: 404, reason: 'thread_not_found' }
  if (thread.id !== threadId || thread.organization_id !== organizationId) throw new Error('The authorized conversation does not match the reply')
  const guard = conversationMessageGuard(thread, actorUserId, 'member')
  if (scheduledId !== null && (!scheduled || !['sending', 'failed', 'needs_review', 'sent'].includes(scheduled.status)
    || scheduled.body !== body || scheduled.author_user_id !== (recorded?.author_user_id ?? actorUserId)
    || (recorded && (recorded.conversation_id !== threadId || recorded.event_name !== MEMBER_REPLY_EVENT))
    || (scheduled.message_id !== null && scheduled.message_id !== recorded?.id))) {
    throw new Error('Reply does not match an already-started scheduled message')
  }
  const retryMessageId = input.retryMessageId ?? (scheduled ? recorded?.id : undefined)
  if (retryMessageId && recorded?.id !== retryMessageId) return { ok: false, status: 404, reason: 'thread_not_found' }
  const recordedAuthor = retryMessageId && recorded ? recorded.author_user_id : actorUserId
  const destination = await guestReplyDestination(db, thread, channelFacts)
  const mapped = recorded?.channel === 'airbnb' ? channelFacts?.mapping ?? null : null
  if (recorded?.channel === 'airbnb' && !mapped) throw new Error(`Reply ${recorded.id} was recorded on Airbnb but its conversation has no channel mapping`)
  const channel = recorded ? mapped : destination.channel === 'airbnb' ? destination.mapping : null
  if (channel && (photoCount > 1 || (photoCount && body))) throw new HTTPError({ statusCode: 400, message: 'Send one Airbnb photo at a time, separately from text', data: { code: 'CHANNEL_PHOTO_MESSAGE_INVALID', field: 'photos' } })
  if (recorded?.channel === 'airbnb' && typeof parseMessagePayload(recorded).request_hash !== 'string') {
    throw new HTTPError({ statusCode: 500, message: 'The channel reply intent has no recorded request hash', data: { code: 'CHANNEL_REPLY_INTENT_INVALID', field: 'payload.request_hash' } })
  }
  if (recorded && (recorded.author_user_id !== recordedAuthor || !entryMatchesRequest(recorded, eventName, body) || parseMessagePayload(recorded).request_hash !== requestHash)) {
    if (recorded.channel === 'airbnb') throw new HTTPError({ statusCode: 409, message: 'The reply key was already used for a different message', data: { code: 'IDEMPOTENCY_CONFLICT', field: 'idempotencyKey' } })
    return conflict()
  }
  const deliveryId = channel ? `guest-thread-channex:${threadId}:${idempotencyKey}` : deliveryDedupeKey(input)
  const delivered = recorded && recorded.channel !== 'web' ? await getDeliveryById(db, deliveryId) : null
  if (destination.channel === null && !(delivered && isDeliverySent(delivered))) return { ok: false, status: 409, reason: 'guest_unreachable', code: 'GUEST_UNREACHABLE', field: 'conversation_id', message: destination.reason }
  if (recorded && recorded.channel !== 'web' && (!delivered || delivered.message_id !== recorded.id)) {
    throw new Error('Reply delivery receipt does not match its message')
  }
  const guestEmail = destination.channel === 'email' || destination.channel === 'account' ? destination.email : null
  const messageChannel = recorded?.channel ?? (channel ? 'airbnb' : guestEmail ? 'email' : 'web')
  const commit = () => append(db, {
    conversation: thread, role: 'member', authorKind: actorUserId === null ? 'krabiclaw' : 'member', authorUserId: recordedAuthor,
    channel: messageChannel, body: messageChannel === 'airbnb' ? body : body || null, eventName, payload: { request_hash: requestHash }, dedupeKey,
  }, {
    env: input.env, photos: photoInput, uploaderUserId: actorUserId, recorded, retryMessageId,
    receipt: messageChannel === 'web' ? undefined : {
      id: deliveryId, channel: messageChannel === 'airbnb' ? 'airbnb' : 'email', provider: messageChannel === 'airbnb' ? 'channex' : emailProvider(input.env), purpose,
    },
  })
  const sentReply = async (message: MessageRow): Promise<ReplyOutcome> => {
    if (scheduled) {
      if (message.author_user_id !== scheduled.author_user_id || message.body !== scheduled.body) throw new Error('Sent scheduled reply does not match its conversation message')
      if (scheduled.status !== 'sent') {
        const now = new Date().toISOString()
        const saved = await execute(db, `UPDATE scheduled_guest_messages SET status = 'sent', reason = NULL, error_code = NULL, error_field = NULL,
          message_id = ?, sent_at = ?, updated_at = ? WHERE id = ? AND status = ? AND (message_id IS NULL OR message_id = ?)`,
        [message.id, now, now, scheduled.id, scheduled.status, message.id])
        if (saved.meta.changes !== 1) {
          const current = await queryFirst<{ status: string; message_id: string | null }>(db, 'SELECT status, message_id FROM scheduled_guest_messages WHERE id = ?', [scheduled.id])
          if (current?.status !== 'sent' || current.message_id !== message.id) throw new Error('Scheduled reply changed before its sent outcome was recorded')
        }
      }
      await publishConversationEvent(input.env, db, { conversationId: threadId, type: 'MESSAGE_CREATE', scheduledAuthorId: scheduled.author_user_id })
    }
    return { ok: true, status: 200, message }
  }
  let entry: MessageRow
  try {
    if (channel) {
      const sent = await replyThroughChannex(db, input.env, { mapping: channel, body, guard, receipt: delivered, deliveryId, photoCount, commit })
      return sent.ok ? sentReply(sent.message) : { ...sent, reason: 'delivery_failed' }
    }
    if (recorded && delivered && isDeliverySent(delivered) && !delivered.error) {
      entry = await commit()
      return sentReply(entry)
    }
    if (destination.channel === null || destination.channel === 'airbnb') return { ok: false, status: 409, reason: 'guest_unreachable', code: 'GUEST_UNREACHABLE', field: 'conversation_id', message: destination.channel === null ? destination.reason : GUEST_UNREACHABLE_MESSAGE }
    entry = await commit()
  } catch (error) {
    if (error instanceof MessagePhotoRejection) return { ok: false, status: 400, reason: 'invalid_photo', message: error.message }
    if (error instanceof MessageStateConflictError) return { ok: false, status: 404, reason: 'thread_not_found' }
    if (error instanceof MessageDedupeConflictError) {
      if (channel) throw new HTTPError({ statusCode: 409, message: 'The reply key was already used for a different message', data: { code: 'IDEMPOTENCY_CONFLICT', field: 'idempotencyKey' } })
      return conflict()
    }
    throw error
  }
  if (entry.channel === 'web') {
    // The guest reads it in their own inbox, where it is unread until they open it.
    return sentReply(entry)
  }
  // A reply saved for email whose address has since been removed is not sent anywhere else.
  if (!guestEmail) return { ok: false, status: 409, reason: 'delivery_failed', code: 'GUEST_EMAIL_REQUIRED', field: 'guest.email', message: 'This reply was saved to be emailed, but the guest no longer has an email address.' }
  const delivery = delivered ?? await getDeliveryById(db, deliveryId)
  if (!delivery || delivery.message_id !== entry.id) throw new Error('Reply delivery receipt does not match its message')
  if (isDeliverySent(delivery) && !delivery.error) {
    return sentReply(entry)
  }

  const fromName = await getOrganizationBrandName(db, organizationId)
  const email = await renderMemberReply(input.env, db, organizationId, fromName, entry, thread.payload.guest.locale, photoCount)
  const outcome = await deliverGuestThreadEmail(db, {
    delivery,
    env: input.env,
    to: guestEmail,
    fromName,
    subject: replySubject(thread.kind, fromName),
    email,
    conversationId: threadId,
    guard,
  }).catch((error: unknown) => {
    if (error instanceof MessageStateConflictError) return null
    throw error
  })

  if (outcome === null) return { ok: false, status: 404, reason: 'thread_not_found' }
  if (isDeliverySent(outcome)) {
    return sentReply(entry)
  }
  if (typeof outcome.error !== 'string' || !outcome.error.trim()) {
    throw new HTTPError({ statusCode: 502, statusMessage: 'Failed email delivery did not provide its error', data: { code: 'INVALID_DELIVERY_RESPONSE', field: 'error' } })
  }
  return { ok: false, status: 502, reason: 'delivery_failed', code: 'DELIVERY_FAILED', field: 'delivery', message: outcome.error }
}

/** Retry and scheduler use the same writer as the interactive command. */
export function sendGuestThreadReply(db: DbClient, input: ReplyInput): Promise<ReplyOutcome> {
  return deliverGuestReply(db, input, appendChatMessage)
}

/** Why a reply to a guest with no email, no Airbnb thread and no KrabiClaw account is refused. */
export const GUEST_UNREACHABLE_MESSAGE = 'This guest has no email or KrabiClaw account to reply to.'
/** Why a reply to an Airbnb conversation whose home was disconnected from Channex is refused. */
const GUEST_DISCONNECTED_MESSAGE = 'This home is disconnected from Airbnb, so its guest cannot be replied to here.'

/** Where a member's reply to the guest goes, or why it cannot go anywhere. */
export type GuestReplyDestination =
  | { channel: 'airbnb'; mapping: ChannelThreadMapping }
  | { channel: 'email'; email: string }
  | { channel: 'account'; email: string | null }
  | { channel: null; reason: string }

export type GuestReplyAccount = { email: string | null; readable: number }
export const guestReplyAccountQuery = (userId: string): BatchQuery => ({
  query: `SELECT CASE WHEN "emailVerified" = 1 AND COALESCE("isAnonymous", 0) = 0 THEN email END AS email,
      COALESCE("isAnonymous", 0) = 0 OR EXISTS (SELECT 1 FROM session WHERE session."userId" = user.id) AS readable FROM user WHERE id = ?`,
  params: [userId],
})

/**
 * The one rule for whether, and where, a member can reply to a guest. The reply
 * operation sends by it and refuses before any send when it says nowhere; the
 * inbox composer, WhatsApp, MCP and send-later read it too.
 *
 * Airbnb's conversation, while its home is still connected to Channex; a channel
 * stay with no addressable conversation is nowhere. Otherwise the guest's email
 * (a direct stay's current contact), or their KrabiClaw account inbox, also
 * emailed when that account has a verified email.
 */
export async function guestReplyDestination(
  db: DbClient,
  thread: Pick<GuestRequest, 'id' | 'organization_id' | 'user_id' | 'payload'>,
  channelFacts?: Awaited<ReturnType<typeof guestThreadChannel>>,
  accountFacts?: GuestReplyAccount | null,
): Promise<GuestReplyDestination> {
  const facts = channelFacts === undefined ? await guestThreadChannel(db, thread.id, thread.organization_id) : channelFacts
  if (!facts) throw new Error(`Conversation ${thread.id} has no channel facts`)
  if (facts.mapping) return facts.connected ? { channel: 'airbnb', mapping: facts.mapping } : { channel: null, reason: GUEST_DISCONNECTED_MESSAGE }
  // A channel's reservation is answered on its channel: until that conversation exists there is nowhere to reply.
  if (facts.booking && isChannelManagedStay(facts.booking)) return { channel: null, reason: `This ${STAY_CHANNEL_LABELS[facts.booking.channel]} stay has no conversation to reply in yet.` }
  const email = thread.payload.guest.email?.trim() || null
  if (email) return { channel: 'email', email }
  if (thread.user_id === null) return { channel: null, reason: GUEST_UNREACHABLE_MESSAGE }
  // An account inbox is read by whoever signs in to it: a named account, or an anonymous guest's browser while it is signed in.
  // The anonymous user a host or a channel gave a guest has never been signed in to, so nobody reads it.
  const { query, params } = guestReplyAccountQuery(thread.user_id)
  const account = accountFacts === undefined ? await queryFirst<GuestReplyAccount>(db, query, params) : accountFacts
  if (!account?.readable) return { channel: null, reason: GUEST_UNREACHABLE_MESSAGE }
  return { channel: 'account', email: account.email }
}

/**
 * Report the guest, or block and report them: the report and the block land
 * together, and KrabiClaw's operators are emailed before the member hears it
 * worked. The report's id comes from the key, so a retry files nothing new.
 */
export async function moderateGuestThread(db: DbClient, input: {
  conversation: ConversationRow; action: 'report' | 'block' | 'unblock'; actorUserId: string;
  idempotencyKey: string; reason?: string; env: ContentReportEnv
}): Promise<ModerationOutcome> {
  const thread = await validateGuestRequest(db, input.conversation)
  const now = new Date().toISOString()
  if (input.action === 'unblock') {
    const [update] = await executeBatch(db, [{
      query: 'UPDATE conversations SET blocked_at = NULL WHERE organization_id = ? AND id = ? AND blocked_at IS NOT NULL',
      params: [thread.organization_id, thread.id],
    }, ...conversationReplyTaskQueries(thread.id, now)], { operation: 'Unblock a guest' })
    if ((update?.meta?.changes ?? 0) === 0 && thread.blocked_at === null) return conflict('This guest is not blocked')
    return { ok: true, status: 200 }
  }
  const block = input.action === 'block'
  const reason = reportReason(input.reason)
  const id = contentReportId(input.actorUserId, input.idempotencyKey)
  await executeBatch(db, [
    contentReportInsert({
      id, organizationId: thread.organization_id, reporterUserId: input.actorUserId, subject: 'conversation',
      conversationId: thread.id, messageId: null, authorUserId: thread.user_id, reason,
      excerpt: await guestThreadExcerpt(db, thread.id), blocked: block,
    }),
    // Only the request that filed the report blocks: a retry of an earlier
    // block must not undo an unblock made since.
    ...(block ? [{
      query: 'UPDATE conversations SET blocked_at = COALESCE(blocked_at, ?) WHERE organization_id = ? AND id = ? AND changes() = 1',
      params: [now, thread.organization_id, thread.id],
    }, ...conversationReplyTaskQueries(thread.id, now)] : []),
  ], { operation: block ? 'Block and report a guest' : 'Report a guest conversation' })
  await assertSameReport(db, id, { subject: 'conversation', conversationId: thread.id, messageId: null, reason, blocked: block })
  await announceContentReport(input.env, db, id)
  return { ok: true, status: 200 }
}

export async function executeBookingStatus(db: DbClient, input: Omit<ExecuteOperationInput, 'threadId'> & {
  action: 'confirm' | 'reject' | 'cancel' | 'no_show'
  bookingId: string
  threadId?: string | null
  version: number
  stayAccess?: StayAccess
}) {
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new HTTPError({ statusCode: 400, message: 'Booking version is required' })
  const record = await queryFirst<{ unit: 'slot' | 'nights'; conversation_id: string | null; status: string; respond_by: string | null }>(db, `SELECT CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS unit,
    b.status, ${stayRequestRespondBySql('b')} AS respond_by,
    (SELECT c.id FROM conversations c WHERE c.booking_id=b.id AND c.organization_id=b.organization_id AND c.kind='booking') AS conversation_id
    FROM bookings b WHERE b.id=? AND b.organization_id=?`, [input.bookingId, input.organizationId])
  if (!record) throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  if (input.threadId && input.threadId !== record.conversation_id) throw new HTTPError({ statusCode: 404, message: 'Booking conversation not found' })
  if (record.unit === 'nights' && input.action !== 'no_show'
    && (!input.stayAccess?.manage || input.stayAccess.organizationId !== input.organizationId || input.stayAccess.actorId !== input.actorUserId)) {
    throw new HTTPError({ statusCode: 403, message: 'Organization access required' })
  }
  if (record.unit === 'nights' && input.action === 'cancel' && (!record.respond_by || record.status === 'confirmed')) {
    const { cancelStay } = await import('~/server/domain/stays')
    const stay = await cancelStay(db, input.env, input.stayAccess!, input.bookingId, {
      version: input.version, reason: input.reason ?? input.body, authorization_id: input.financialAuthorizationId, financial_writes_allowed: input.financialWritesAllowed,
    })
    return { kind: 'stay' as const, stay }
  }
  if (!record.conversation_id) throw new HTTPError({ statusCode: 409, message: 'The booking conversation is missing' })
  return { kind: 'booking' as const, outcome: await executeGuestThreadOperation(db, { ...input, threadId: record.conversation_id }, input.bookingId) }
}

export async function executeGuestThreadOperation(db: DbClient, input: ExecuteOperationInput, bookingId?: string): Promise<OperationOutcome> {
  if (!input.idempotencyKey) return { ok: false, status: 400, reason: 'missing_idempotency_key' }
  const context = await loadThreadContext(db, input.threadId, input.organizationId, input.conversation)
  if ('ok' in context) return context
  if (bookingId && context.record?.id !== bookingId) return { ok: false, status: 404, reason: 'source_not_found' }

  if (input.action === 'no_show') return await executeNoShow(db, context, input)
  return await executeSourceMutation(db, context, input)
}

/**
 * Record that the guest did not come. The visit keeps its status; its review
 * invitation is never sent, and a link already sent stops working, in the
 * same batch as the ledger entry that says who recorded it.
 */
async function executeNoShow(db: DbClient, context: ThreadContext, input: ExecuteOperationInput): Promise<OperationOutcome> {
  const record = context.record
  if (!record) return { ok: false, status: 404, reason: 'source_not_found' }
  const dedupeKey = operationDedupeKey(input)
  const eventName = `${record.unit === 'nights' ? 'stay' : 'booking'}.no_show`
  const existing = await findMessageByDedupeKey(db, dedupeKey)
  if (existing) return entryMatchesRequest(existing, eventName) ? await successfulOutcome(db, context) : conflict()
  const now = new Date().toISOString()
  if (input.version !== undefined && record.version !== input.version) return conflict('This booking changed since you opened it. Reload and try again.')
  if (!canMarkNoShow(record, now)) return conflict('Only a confirmed visit that has started and has no review can be marked as a no-show')
  const entryId = crypto.randomUUID()
  await executeBatch(db, [
    ...messageQueries({ id: entryId, conversationId: context.thread.id, authorKind: 'krabiclaw', authorUserId: input.actorUserId, body: 'Marked as a no-show',
      eventName, payload: { action: 'no_show', booking_id: record.id }, dedupeKey, occurredAt: now,
      guard: { sql: `c.organization_id = ? AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.organization_id = c.organization_id AND rv.booking_id = c.booking_id)
        AND EXISTS (SELECT 1 FROM bookings src WHERE src.id = ? AND src.id = c.booking_id AND src.organization_id = c.organization_id AND src.status = 'confirmed' AND src.no_show_at IS NULL AND src.version = ?)`,
      params: [context.thread.organization_id, record.id, record.version] } }).queries,
    {
      query: `UPDATE bookings SET no_show_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND no_show_at IS NULL AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
      params: [now, now, record.id, entryId],
    },
    revokeReviewRequestQuery(record.id, entryId, now),
  ], { operation: `guest thread ${eventName}` })
  const applied = await findMessageByDedupeKey(db, dedupeKey)
  if (!applied) return conflict('The visit changed before it could be marked as a no-show')
  if (!entryMatchesRequest(applied, eventName)) return conflict()
  return await successfulOutcome(db, context)
}

/**
 * A reply nobody is sending right now: an automatic message (no author), or a
 * member's send-later message, sent as that member's own reply.
 */
export async function sendScheduledGuestReply(db: DbClient, input: { threadId: string; organizationId: string; body: string; idempotencyKey: string; actorUserId?: string; env: ExecuteOperationInput['env'] }): Promise<{ outcome: ReplyOutcome; messageId: string | null }> {
  const outcome = await sendGuestThreadReply(db, { ...input, actorUserId: input.actorUserId ?? null })
  if (outcome.ok) return { outcome, messageId: outcome.message.id }
  const entry = await findMessageByDedupeKey(db, operationDedupeKey(input))
  return { outcome, messageId: entry?.id ?? null }
}
