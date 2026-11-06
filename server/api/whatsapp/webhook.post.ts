import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { fetchWhatsAppMedia, sendWhatsAppText } from '~/server/utils/whatsapp'
import { attachGuestPhotos, messagePreview, sortGuestFiles, type MessagePhoto } from '~/server/domain/guest-threads/attachments'
import { advanceDeliveryStatus, isDeliverySent } from '~/server/domain/guest-threads/deliveries'
import type { GuestThreadDeliveryRow } from '~/server/domain/guest-threads/types'
import { parseMetaMsisdn } from '~/utils/phone'
import {
  getWhatsAppWorkspaceState, patchWhatsAppWorkspaceState, type JsonSerializable, } from '~/server/utils/mcp-context'
import { execute, queryAll, queryFirst } from '~/server/db'
import { updateThreadProjectionIfLatestEntry } from '~/server/domain/guest-threads/repository'
import { getGuestRequest, requestSummary } from '~/server/domain/requests'
import { executeGuestThreadOperation, guestReplyDestination, operationDedupeKey } from '~/server/domain/guest-threads/operations'
import { appendEntry, findEntryByDedupeKey } from '~/server/domain/guest-threads/entries'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { notifyGuestThreadReply } from '~/server/utils/notifications'
import { findSubmissionByPhone } from '~/server/utils/submission-messages'
import { isAuthorizedWhatsAppRecipient, isOrganizationWideRole, resolveMemberId, resolveOrganizationMembership } from '~/server/utils/member-access'
import { findVerifiedAuthUserByPhone } from '~/server/utils/auth'
import {
  PROMPT_QUOTE_NOTIFICATION_MESSAGE, REPLY_FAILED_ALERTED_MESSAGE, REPLY_SENT_CONFIRMATION, REPLY_UNCERTAIN_MESSAGE, buildCollectReplyPrompt, buildConfirmSendPrompt, buildDisambiguationPrompt, buildReplyFailedMessage, decideWhatsAppReplyRouting, maskEmailForDisplay, type DisambiguationCandidate, type PendingWhatsAppReplyState, } from '~/server/utils/whatsapp-reply-routing'

interface WhatsAppMessage {
  id: string
  message_id?: string
  from: string
  timestamp?: string
  type: 'text' | 'image' | 'document' | string
  text?: { body?: string }
  image?: { id?: string; mime_type?: string; caption?: string }
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string }
  // Present when the manager replied by quoting a prior outbound message.
  // The provider id correlates to a guest thread delivery receipt.
  context?: { id?: string; from?: string }
}

interface WhatsAppStatusError {
  code?: number
  title?: string
  message?: string
  error_data?: { details?: string }
}

interface WhatsAppStatus {
  id?: string
  status?: string
  timestamp?: string
  recipient_id?: string
  errors?: WhatsAppStatusError[]
}

interface WhatsAppPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppMessage[]
        statuses?: WhatsAppStatus[]
      }
    }>
  }>
}

interface UserRow {
  id: string
  phoneNumber: string
  phoneNumberVerified: boolean
}

function platformLoginUrl(env: ApiRecord): string {
  const raw = String(env.NUXT_PUBLIC_PLATFORM_DOMAIN || '').trim()
  if (!raw) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN is required')
  const origin = /^https?:\/\//i.test(raw) ? raw.replace(/\/$/, '') : `https://${raw.replace(/\/$/, '')}`
  return `${origin}/login`
}

function inboundMessages(payload: WhatsAppPayload): WhatsAppMessage[] {
  return (payload.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .flatMap((change) => change.value?.messages ?? [])
    .filter((message) => Boolean(message.id && message.from))
}

function inboundStatuses(payload: WhatsAppPayload): WhatsAppStatus[] {
  return (payload.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .flatMap((change) => change.value?.statuses ?? [])
    .filter((status) => Boolean(status.id && status.status))
}

function messageText(message: WhatsAppMessage): string {
  if (message.type === 'text') return message.text?.body?.trim() ?? ''
  if (message.type === 'image') return message.image?.caption?.trim() ?? ''
  if (message.type === 'document') return message.document?.caption?.trim() ?? ''
  return ''
}

/** The file a guest's WhatsApp message carries, downloaded from Meta. */
async function messageFiles(env: ApiRecord, message: WhatsAppMessage): Promise<MessagePhoto[]> {
  const media = message.type === 'image' ? message.image : message.type === 'document' ? message.document : undefined
  if (!media?.id) return []
  const downloaded = await fetchWhatsAppMedia(env, media.id)
  const filename = message.document?.filename || `whatsapp-${media.id}`
  return [{ bytes: new Uint8Array(downloaded.bytes), filename }]
}

async function reply(env: ApiRecord, toPhone: string, text: string) {
  return await sendWhatsAppText(env, toPhone, text)
}

async function resolveUser(env: ApiRecord, from: string): Promise<UserRow | null> {
  const normalized = parseMetaMsisdn(from)
  return await findVerifiedAuthUserByPhone(env as CloudflareEnv, normalized)
}

function parsePendingReplyState(raw: string | null | undefined): PendingWhatsAppReplyState | null {
  if (!raw) return null
  const parsed = JSON.parse(raw) as { kind?: unknown }
  // The same pending_confirmation column also carries an unrelated
  // `{ intent: 'pending_media' }` marker from the media-upload flow — only claim
  // objects that actually match one of our reply-routing state shapes. A shape
  // this router does not own is not an error; JSON that will not parse at all is
  // corruption, and reading it as "no pending state" dropped the guest's reply.
  if (parsed.kind === 'confirm_send' || parsed.kind === 'disambiguate' || parsed.kind === 'collect_reply') {
    return parsed as PendingWhatsAppReplyState
  }
  return null
}

function submissionTypeLabel(type: string): string {
  if (type === 'reservation') return 'Reservation'
  if (type === 'booking') return 'Booking'
  return 'Message'
}

interface QuotedDeliveryMatch {
  threadId: string
  organizationId: string
  locationId: string | null
  /** Where a reply goes, said for the manager. */
  destination: string
}

/**
 * Where a reply to this conversation goes, said for the manager, by the reply
 * operation's own rule (`guestReplyDestination`); otherwise why it cannot go.
 */
async function replyDestination(db: D1Database, threadId: string, organizationId: string): Promise<{ destination: string } | { refused: string }> {
  const thread = await getGuestRequest(db, threadId, organizationId)
  if (!thread) return { refused: 'This conversation no longer exists.' }
  const destination = await guestReplyDestination(db, thread)
  if (destination.channel === null) return { refused: destination.reason }
  if (destination.channel === 'airbnb') return { destination: 'through Airbnb' }
  return { destination: destination.channel === 'email' ? `by email to ${maskEmailForDisplay(destination.email)}` : 'to their KrabiClaw inbox' }
}

async function resolveQuotedDelivery(
  db: D1Database, env: ApiRecord, providerMessageId: string, phone: string, ): Promise<QuotedDeliveryMatch | { refused: string } | null> {
  const thread = await queryFirst<{
    request_id: string
    organization_id: string
    location_id: string | null
  }>(db, `
    SELECT gt.id AS request_id, gt.organization_id, gt.location_id
    FROM guest_thread_deliveries d
    JOIN activity_entries e ON e.id = d.entry_id
    JOIN requests gt ON gt.id = e.request_id
    WHERE d.provider = 'meta' AND d.provider_message_id = ?
    LIMIT 1
  `, [providerMessageId])
  if (!thread) return null

  const authorized = await isAuthorizedWhatsAppRecipient(db, {
    env: env as CloudflareEnv,
    phone, organizationId: thread.organization_id })
  if (!authorized) return null

  // The manager chose this conversation: one that cannot be replied to says why, never another in its place.
  const reply = await replyDestination(db, thread.request_id, thread.organization_id)
  if ('refused' in reply) return reply
  return { threadId: thread.request_id, organizationId: thread.organization_id, locationId: thread.location_id, destination: reply.destination }
}

async function listRecentGuestDeliveryCandidates(db: D1Database, env: ApiRecord, userId: string): Promise<DisambiguationCandidate[]> {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const rows = await queryAll<{
    threadId: string
    organizationId: string
    locationId: string | null
    guestName: string
    submissionType: string
  }>(db, `
    SELECT gt.id AS threadId, gt.organization_id AS organizationId,
           gt.location_id AS locationId, json_extract(gt.payload_json, '$.guest.name') AS guestName,
           gt.kind AS submissionType, MAX(d.created_at) AS createdAt
    FROM guest_thread_deliveries d
    JOIN activity_entries e ON e.id = d.entry_id
    JOIN requests gt ON gt.id = e.request_id
    JOIN member m ON m.organizationId = gt.organization_id AND m.userId = ? AND m.role IN ('owner', 'admin')
    WHERE d.channel = 'whatsapp' AND d.created_at > ?
    GROUP BY gt.id
    ORDER BY createdAt DESC
    LIMIT 25
  `, [userId, sinceIso])

  const authorizedRows = (await Promise.all((rows ?? []).map(async (row) => {
    const membership = await resolveOrganizationMembership(env as CloudflareEnv, {
      organizationId: row.organizationId,
      userId,
    })
    // Only the roles WhatsApp replies are authorized for see a thread's guest,
    // and only conversations the inbox lets them write to are offered.
    if (!membership || !isOrganizationWideRole(membership.role)) return null
    return 'destination' in await replyDestination(db, row.threadId, row.organizationId) ? row : null
  }))).filter((row): row is NonNullable<typeof row> => Boolean(row)).slice(0, 5)
  return authorizedRows.map((r) => ({
    threadId: r.threadId, organizationId: r.organizationId, locationId: r.locationId, label: `${submissionTypeLabel(r.submissionType)} from ${r.guestName}`, }))
}

type ReplyVerdict = { notice: string; report: unknown | null }

/**
 * What the manager reads about a reply the operation returned, and whether it is an error to
 * report. A refusal (4xx) is told in the operation's words, never a reason code; a reply that
 * may already be with the guest says so; any failure (5xx) is never shown raw.
 */
function returnedReplyVerdict(outcome: Awaited<ReturnType<typeof executeGuestThreadOperation>> | { ok: false; status: 404; reason: 'thread_not_found' }): ReplyVerdict {
  if (outcome.ok) return { notice: REPLY_SENT_CONFIRMATION, report: null }
  const failure = new Error(`WhatsApp reply ${outcome.reason}${'code' in outcome ? ` ${outcome.code}` : ''}: ${'message' in outcome ? outcome.message : outcome.status}`)
  if (outcome.reason === 'delivery_failed' && (outcome.code === 'CHANNEL_REPLY_UNCERTAIN' || outcome.code === 'CHANNEL_REPLY_REVIEW_REQUIRED')) {
    return { notice: REPLY_UNCERTAIN_MESSAGE, report: outcome.status >= 500 ? failure : null }
  }
  if (outcome.status >= 500) return { notice: REPLY_FAILED_ALERTED_MESSAGE, report: failure }
  switch (outcome.reason) {
    case 'thread_not_found': case 'source_not_found': return { notice: buildReplyFailedMessage('This conversation no longer exists.'), report: null }
    case 'empty_body': return { notice: buildReplyFailedMessage('Write a message before sending it.'), report: null }
    case 'missing_idempotency_key': return { notice: REPLY_FAILED_ALERTED_MESSAGE, report: failure }
    default: return { notice: buildReplyFailedMessage(outcome.message), report: null }
  }
}

/**
 * The same for an error the operation threw. A reply the provider already accepted under this key
 * may be with the guest whatever failed after; otherwise only a refusal the operation throws by
 * design (a 4xx with its code) is told as it is, and everything else is reported, not shown.
 */
async function thrownReplyVerdict(db: D1Database, error: unknown, threadId: string, idempotencyKey: string): Promise<ReplyVerdict> {
  const deliveries = await queryAll<GuestThreadDeliveryRow>(db, 'SELECT d.* FROM guest_thread_deliveries d JOIN activity_entries e ON e.id = d.entry_id WHERE e.dedupe_key = ?', [operationDedupeKey({ threadId, idempotencyKey })])
  if (deliveries.some(delivery => isDeliverySent(delivery) || delivery.provider_message_id !== null)) return { notice: REPLY_UNCERTAIN_MESSAGE, report: error }
  if (error instanceof HTTPError && error.status >= 400 && error.status < 500 && typeof (error.data as { code?: unknown } | undefined)?.code === 'string') {
    return { notice: buildReplyFailedMessage(error.message), report: null }
  }
  return { notice: REPLY_FAILED_ALERTED_MESSAGE, report: error }
}

// Issue #293 Section C direct-reply routing contract, applied only to messages from a
// resolveUser-verified platform user (managers). Handles all I/O (lookups,
// authorization, sends, channel-state persistence) around the pure decision function in
// server/utils/whatsapp-reply-routing.ts.
async function routeManagerWhatsAppMessage(
  db: D1Database,
  env: ApiRecord,
  opts: {
    message: WhatsAppMessage
    toPhone: string
    userId: string
    existingState: Awaited<ReturnType<typeof getWhatsAppWorkspaceState>>
    messageId: string
  },
): Promise<void> {
  const rawText = messageText(opts.message)
  const pendingState = parsePendingReplyState(opts.existingState?.pending_confirmation)
  const contextId = opts.message.context?.id ?? null
  const hasQuotedContext = Boolean(contextId)

  const clearPending = () =>
    patchWhatsAppWorkspaceState(db, {
      userId: opts.userId,
      pendingConfirmation: null,
      lastInboundId: opts.messageId,
    })
  // A message the manager must read that Meta refused fails the webhook, as every prompt here does.
  const sendOrThrow = async (text: string, failure: string) => {
    const sendResult = await sendWhatsAppText(env, opts.toPhone, text)
    if (!sendResult.success) throw new Error(sendResult.error || failure)
  }
  // The manager is told first, then the pending reply is cleared: a notice Meta refused leaves
  // this message unhandled, so Meta's redelivery runs it again.
  const tellAndClear = async (text: string, failure: string) => {
    await sendOrThrow(text, failure)
    await clearPending()
  }

  async function resolveFreshDispatch(): Promise<{
    quotedDeliveryMatch: 'authorized_thread_found' | 'unmatched' | null
    quotedDelivery: QuotedDeliveryMatch | null
    quotedRefusal: string | null
    recentDeliveryCount: number
    recentCandidates: DisambiguationCandidate[]
  }> {
    let quotedDelivery: QuotedDeliveryMatch | null = null
    let quotedRefusal: string | null = null
    let quotedDeliveryMatch: 'authorized_thread_found' | 'unmatched' | null = null
    if (hasQuotedContext) {
      const quoted = await resolveQuotedDelivery(db, env, contextId!, opts.toPhone)
      if (quoted && 'refused' in quoted) quotedRefusal = quoted.refused
      else quotedDelivery = quoted
      quotedDeliveryMatch = quotedDelivery ? 'authorized_thread_found' : 'unmatched'
    }

    let recentCandidates: DisambiguationCandidate[] = []
    if (!quotedDelivery && quotedRefusal === null) {
      recentCandidates = await listRecentGuestDeliveryCandidates(db, env, opts.userId)
    }

    return {
      quotedDeliveryMatch,
      quotedDelivery,
      quotedRefusal,
      recentDeliveryCount: recentCandidates.length,
      recentCandidates,
    }
  }

  if (!pendingState) {
    const fresh = await resolveFreshDispatch()
    if (fresh.quotedRefusal !== null) {
      await tellAndClear(buildReplyFailedMessage(fresh.quotedRefusal), 'Failed to send WhatsApp reply refusal')
      return
    }

    const decision = decideWhatsAppReplyRouting({
      hasQuotedContext,
      quotedDeliveryMatch: fresh.quotedDeliveryMatch,
      pendingState: null,
      recentDeliveryCount: fresh.recentDeliveryCount,
      text: rawText,
    })

    switch (decision.action) {
      case 'start_confirm_send': {
        const trimmedText = rawText.trim()
        if (!trimmedText) {
          // Captionless media or empty reply — resend the prompt without advancing
          const match = fresh.quotedDelivery!
          await sendOrThrow(buildConfirmSendPrompt(match.destination), 'Failed to send WhatsApp confirmation prompt')
          return
        }
        const match = fresh.quotedDelivery!
        const newState: PendingWhatsAppReplyState = {
          kind: 'confirm_send',
          threadId: match.threadId,
          organizationId: match.organizationId,
          locationId: match.locationId,
          replyBody: trimmedText,
        }
        const sendResult = await sendWhatsAppText(env, opts.toPhone, buildConfirmSendPrompt(match.destination))
        if (!sendResult.success) {
          throw new Error(sendResult.error || 'Failed to send WhatsApp confirmation prompt')
        }
        await patchWhatsAppWorkspaceState(db, {
          userId: opts.userId,
          pendingConfirmation: newState,
          lastInboundId: opts.messageId,
        })
        return
      }
      case 'start_disambiguation': {
        const newState: PendingWhatsAppReplyState = { kind: 'disambiguate', candidates: fresh.recentCandidates }
        const sendResult = await sendWhatsAppText(env, opts.toPhone, buildDisambiguationPrompt(fresh.recentCandidates))
        if (!sendResult.success) {
          throw new Error(sendResult.error || 'Failed to send WhatsApp disambiguation prompt')
        }
        await patchWhatsAppWorkspaceState(db, {
          userId: opts.userId,
          pendingConfirmation: newState as unknown as JsonSerializable,
          lastInboundId: opts.messageId,
        })
        return
      }
      case 'prompt_quote_notification':
      default: {
        const sendResult = await sendWhatsAppText(env, opts.toPhone, PROMPT_QUOTE_NOTIFICATION_MESSAGE)
        if (!sendResult.success) {
          throw new Error(sendResult.error || 'Failed to send WhatsApp routing prompt')
        }
        await patchWhatsAppWorkspaceState(db, {
          userId: opts.userId,
          pendingConfirmation: null,
          lastInboundId: opts.messageId,
        })
        return
      }
    }
  }

  // A pending confirm_send / disambiguate / collect_reply state exists — resume it.
  if (pendingState.kind === 'confirm_send') {
    const decision = decideWhatsAppReplyRouting({
      hasQuotedContext: false,
      quotedDeliveryMatch: null,
      pendingState,
      recentDeliveryCount: 0,
      text: rawText,
    })
    if (decision.action === 'confirm_send_execute') {
      // Reauthorize before executing the reply to ensure the member still has access
      const authorized = await isAuthorizedWhatsAppRecipient(db, {
        env: env as CloudflareEnv,
        phone: opts.toPhone,
        organizationId: pendingState.organizationId,
      })
      if (!authorized) {
        await tellAndClear('Your WhatsApp access has been revoked. Please contact your organization administrator.', 'Failed to send WhatsApp access notice')
        return
      }
      const actorMemberId = await resolveMemberId({
        organizationId: pendingState.organizationId,
        userId: opts.userId,
        env,
      })
      const idempotencyKey = `whatsapp:${opts.messageId}:reply`
      const attempt = actorMemberId
        ? await executeGuestThreadOperation(db, { threadId: pendingState.threadId, organizationId: pendingState.organizationId, action: 'reply', actorUserId: opts.userId, body: pendingState.replyBody, env, idempotencyKey })
          .then(outcome => ({ outcome }), (error: unknown) => ({ error }))
        : { outcome: { ok: false as const, status: 404 as const, reason: 'thread_not_found' as const } }
      const verdict = 'error' in attempt
        ? await thrownReplyVerdict(db, attempt.error, pendingState.threadId, idempotencyKey)
        : returnedReplyVerdict(attempt.outcome)
      if ('outcome' in attempt && attempt.outcome.ok) await publishGuestInboxThreadEvent(env, db, { threadId: attempt.outcome.thread.id, type: 'thread.changed' })
      // The manager is told, then the pending reply is cleared; an error to report fails the
      // webhook after both, with the reply's own error as the cause telemetry follows.
      const told = await sendWhatsAppText(env, opts.toPhone, verdict.notice).then(
        result => result.success ? null : new Error(result.error || 'Failed to send WhatsApp reply outcome'), (error: unknown) => error)
      const cleared = told ? null : await clearPending().then(() => null, (error: unknown) => error)
      if (verdict.report === null) {
        if (told) throw told
        if (cleared) throw cleared
        return
      }
      if (told) throw new AggregateError([verdict.report, told], 'The reply failed and the manager could not be told', { cause: verdict.report })
      if (cleared) throw new AggregateError([verdict.report, cleared], 'The reply failed; the manager was told, but the pending reply could not be cleared', { cause: verdict.report })
      throw verdict.report
    }
    // Non-affirmative reply: the pending confirmation is dropped and this message is
    // dispatched fresh (issue #293). The state is written with the redispatch's own
    // notice below, after it is sent, so a refused notice leaves the message to redeliver.
  } else if (pendingState.kind === 'disambiguate') {
    const decision = decideWhatsAppReplyRouting({
      hasQuotedContext: false,
      quotedDeliveryMatch: null,
      pendingState,
      recentDeliveryCount: 0,
      text: rawText,
    })
    if (decision.action === 'disambiguation_pick') {
      const chosen = pendingState.candidates[decision.index - 1]!

      // Reauthorize before disambiguation transition to ensure the member still has access
      const authorized = await isAuthorizedWhatsAppRecipient(db, {
        env: env as CloudflareEnv,
        phone: opts.toPhone,
        organizationId: chosen.organizationId,
      })
      if (!authorized) {
        await tellAndClear('Your WhatsApp access has been revoked. Please contact your organization administrator.', 'Failed to send WhatsApp access notice')
        return
      }

      // The conversation can have changed since it was offered; then the reply is refused as the inbox refuses it.
      const reply = await replyDestination(db, chosen.threadId, chosen.organizationId)
      if ('refused' in reply) {
        await tellAndClear(buildReplyFailedMessage(reply.refused), 'Failed to send WhatsApp reply refusal')
        return
      }
      const destination = reply.destination
      const newState: PendingWhatsAppReplyState = {
        kind: 'collect_reply',
        threadId: chosen.threadId,
        organizationId: chosen.organizationId,
        locationId: chosen.locationId,
      }
      const sendResult = await sendWhatsAppText(env, opts.toPhone, buildCollectReplyPrompt(destination))
      if (!sendResult.success) throw new Error(sendResult.error || 'Failed to send WhatsApp reply prompt')
      await patchWhatsAppWorkspaceState(db, {
        userId: opts.userId,
        pendingConfirmation: newState,
        lastInboundId: opts.messageId,
      })
      return
    }
    // Not a pick: dispatched fresh below, its state written after its notice is sent.
  } else {
    // collect_reply: any non-empty text becomes the reply body, moving to confirm_send.
    // Reauthorize before reading the conversation, as the pick and the send do.
    const authorized = await isAuthorizedWhatsAppRecipient(db, {
      env: env as CloudflareEnv,
      phone: opts.toPhone,
      organizationId: pendingState.organizationId,
    })
    if (!authorized) {
      await tellAndClear('Your WhatsApp access has been revoked. Please contact your organization administrator.', 'Failed to send WhatsApp access notice')
      return
    }
    const reply = await replyDestination(db, pendingState.threadId, pendingState.organizationId)
    if ('refused' in reply) {
      await tellAndClear(buildReplyFailedMessage(reply.refused), 'Failed to send WhatsApp reply refusal')
      return
    }
    const destination = reply.destination
    const newState: PendingWhatsAppReplyState = {
      kind: 'confirm_send',
      threadId: pendingState.threadId,
      organizationId: pendingState.organizationId,
      locationId: pendingState.locationId,
      replyBody: rawText,
    }
    const sendResult = await sendWhatsAppText(env, opts.toPhone, buildConfirmSendPrompt(destination))
    if (!sendResult.success) throw new Error(sendResult.error || 'Failed to send WhatsApp confirmation prompt')
    await patchWhatsAppWorkspaceState(db, {
      userId: opts.userId,
      pendingConfirmation: newState,
      lastInboundId: opts.messageId,
    })
    return
  }

  // Cancelled confirm_send/disambiguate above — redispatch this same message fresh.
  const fresh = await resolveFreshDispatch()
  if (fresh.quotedRefusal !== null) {
    await tellAndClear(buildReplyFailedMessage(fresh.quotedRefusal), 'Failed to send WhatsApp reply refusal')
    return
  }

  const decision = decideWhatsAppReplyRouting({
    hasQuotedContext,
    quotedDeliveryMatch: fresh.quotedDeliveryMatch,
    pendingState: null,
    recentDeliveryCount: fresh.recentDeliveryCount,
    text: rawText,
  })

  switch (decision.action) {
    case 'start_confirm_send': {
      const match = fresh.quotedDelivery!
      const newState: PendingWhatsAppReplyState = {
        kind: 'confirm_send',
        threadId: match.threadId,
        organizationId: match.organizationId,
        locationId: match.locationId,
        replyBody: rawText,
      }
      await sendOrThrow(buildConfirmSendPrompt(match.destination), 'Failed to send WhatsApp confirmation prompt')
      await patchWhatsAppWorkspaceState(db, {
        userId: opts.userId,
        pendingConfirmation: newState,
        lastInboundId: opts.messageId,
      })
      return
    }
    case 'start_disambiguation': {
      const newState: PendingWhatsAppReplyState = { kind: 'disambiguate', candidates: fresh.recentCandidates }
      await sendOrThrow(buildDisambiguationPrompt(fresh.recentCandidates), 'Failed to send WhatsApp disambiguation prompt')
      await patchWhatsAppWorkspaceState(db, {
        userId: opts.userId,
        pendingConfirmation: newState as unknown as JsonSerializable,
        lastInboundId: opts.messageId,
      })
      return
    }
    case 'prompt_quote_notification':
    default: {
      await tellAndClear(PROMPT_QUOTE_NOTIFICATION_MESSAGE, 'Failed to send WhatsApp routing prompt')
      return
    }
  }
}

async function handleMessage(db: D1Database, env: ApiRecord, message: WhatsAppMessage): Promise<void> {

  const toPhone = parseMetaMsisdn(message.from)
  const user = await resolveUser(env, message.from)
  if (!user) {
    // Not a verified owner/staff account — check whether this is a customer replying to an
    // open reservation/experience-booking thread rather than trying to talk to ChowBot.
    const existingEntry = await findEntryByDedupeKey(db, `whatsapp:${message.id}`)
    const existingThread = existingEntry
      ? await getGuestRequest(db, existingEntry.request_id)
      : null
    const match = existingThread
      ? {
          submissionType: existingThread.kind,
          submissionId: existingThread.id,
          organizationId: existingThread.organization_id,
        }
      : await findSubmissionByPhone(db, toPhone)
    if (match) {
      const text = messageText(message)
      const { photos, unshown } = sortGuestFiles(await messageFiles(env, message))
      if (text || photos.length || unshown.length) {
        const thread = await getGuestRequest(db, match.submissionId, undefined, match.submissionType)
        if (!thread) throw new Error(`WhatsApp guest reply matched conversation ${match.submissionId}, which no longer exists`)
        const entry = await appendEntry(db, {
          threadId: thread.id,
          kind: 'message',
          actorKind: 'guest',
          body: text || null,
          payloadJson: unshown.length ? { unshownFiles: unshown } : null,
          dedupeKey: `whatsapp:${message.id}`,
        })
        await attachGuestPhotos(db, env, match.organizationId, entry.id, photos)
        await updateThreadProjectionIfLatestEntry(db, thread.id, entry.id, { conversationState: 'needs_attention' })
        // The guest's message is in the thread before the owner is alerted, so an alert that fails cannot hide it.
        await publishGuestInboxThreadEvent(env, db, { threadId: thread.id, type: 'entry.appended' })

        const summary = await requestSummary(db, thread)
        await notifyGuestThreadReply(env, db, {
          organizationId: match.organizationId,
          locationId: summary.locationId,
          threadId: thread.id,
          sourceEntryId: entry.id,
          submissionType: match.submissionType,
          submissionId: match.submissionId,
          participantLabel: summary.participantLabel,
          guestEmail: summary.guestEmail,
          guestPhone: summary.guestPhone,
          inboundChannel: 'whatsapp',
          messagePreview: messagePreview(text, photos.length),
        })
      }
      return
    }
    await reply(env, toPhone, `To continue, open KrabiClaw: ${platformLoginUrl(env)}`)
    return
  }

  // Idempotency check: skip if this message was already processed. Checked before the
  // manager-routing tiers since those tiers also send replies and mutate channel state —
  // a webhook retry must not run them twice either.
  const messageId = message.id || message.message_id
  const existingState = await getWhatsAppWorkspaceState(db, user.id)
  if (existingState?.last_inbound_id === messageId) {
    console.log('[whatsapp] Skipping duplicate message:', messageId)
    return
  }

  await routeManagerWhatsAppMessage(db, env, {
    message,
    toPhone,
    userId: user.id,
    existingState,
    messageId: messageId ?? message.id,
  })
}

function formatStatusError(errors: WhatsAppStatusError[] | undefined): string | null {
  if (!errors?.length) return null
  try {
    return JSON.stringify(errors)
  } catch {
    return null
  }
}

async function handleStatus(db: D1Database, env: ApiRecord, status: WhatsAppStatus): Promise<void> {
  const providerMessageId = status.id
  const incomingStatus = status.status
  if (!providerMessageId || !incomingStatus) return
  if (incomingStatus !== 'sent' && incomingStatus !== 'delivered' && incomingStatus !== 'read' && incomingStatus !== 'failed') return

  const delivery = await queryFirst<{ id: string; request_id: string; status: string }>(db, `
    SELECT d.id, e.request_id, d.status
    FROM guest_thread_deliveries d
    JOIN activity_entries e ON e.id = d.entry_id
    WHERE d.provider = 'meta' AND d.provider_message_id = ?
    LIMIT 1
  `, [providerMessageId])
  if (!delivery) return

  const errorText = formatStatusError(status.errors)
  const advanced = await advanceDeliveryStatus(db, delivery, incomingStatus, errorText)

  // A `failed` event arrived after a later success stage was already
  // recorded (or a same/earlier-stage replay) — never regress
  // delivery status, but still persist the raw provider error so a
  // failure is never silently lost.
  if (!advanced && errorText) {
    await execute(db, `
      UPDATE guest_thread_deliveries
      SET error = ?, updated_at = ?
      WHERE id = ?
    `, [errorText, new Date().toISOString(), delivery.id])
  }

  await publishGuestInboxThreadEvent(env, db, {
    threadId: delivery.request_id,
    type: 'delivery.changed',
  })
}

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const rawBody = await readRawBody(event) ?? ''
  const appSecret = typeof env.WHATSAPP_APP_SECRET === 'string' ? env.WHATSAPP_APP_SECRET : ''
  // The signature is the only thing that makes this a message from Meta. Without
  // the secret nothing can be verified, so nothing is accepted.
  if (!appSecret) return jsonResponse({ error: 'Missing WHATSAPP_APP_SECRET configuration' }, { status: 500 })
  const signature = (event.req.headers.get('x-hub-signature-256')) ?? ''
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'], )
  const incomingHex = signature.startsWith('sha256=') ? signature.slice(7) : ''
  const pairs = incomingHex.match(/.{2}/g)
  const parsedPairs = pairs && pairs.length === 32 ? pairs.map((b) => parseInt(b, 16)) : null
  const incomingBytes = parsedPairs && parsedPairs.every((n) => !Number.isNaN(n))
    ? new Uint8Array(parsedPairs)
    : new Uint8Array(0)
  const isValid = incomingBytes.length === 32 && await crypto.subtle.verify(
    { name: 'HMAC', hash: 'SHA-256' }, key, incomingBytes, new TextEncoder().encode(rawBody), )
  if (!isValid) {
    return jsonResponse({ error: 'Invalid signature' }, { status: 403 })
  }

  let payload: WhatsAppPayload
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    return jsonResponse({ error: 'Malformed JSON payload' }, { status: 400 })
  }
  const messages = inboundMessages(payload)
  const statuses = inboundStatuses(payload)

  for (const message of messages) {
    await handleMessage(db, env, message)
  }
  for (const status of statuses) {
    await handleStatus(db, env, status)
  }

  return jsonResponse({ success: true })
})
import { defineHandler, HTTPError } from 'nitro';
import {  readRawBody  } from 'nitro/h3';
