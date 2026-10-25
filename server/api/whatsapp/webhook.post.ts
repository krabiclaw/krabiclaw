import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { fetchWhatsAppMedia, sendWhatsAppText } from '~/server/utils/whatsapp'
import { attachGuestPhotos, messagePreview, sortGuestFiles, type MessagePhoto } from '~/server/domain/guest-threads/attachments'
import { advanceDeliveryStatus } from '~/server/domain/guest-threads/deliveries'
import { parseMetaMsisdn } from '~/utils/phone'
import {
  getWhatsAppWorkspaceState, patchWhatsAppWorkspaceState, type JsonSerializable, } from '~/server/utils/mcp-context'
import { execute, queryAll, queryFirst } from '~/server/db'
import { updateThreadProjectionIfLatestEntry } from '~/server/domain/guest-threads/repository'
import { getGuestRequest, requestSummary } from '~/server/domain/requests'
import { executeGuestThreadOperation } from '~/server/domain/guest-threads/operations'
import { appendEntry, findEntryByDedupeKey } from '~/server/domain/guest-threads/entries'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { notifyGuestThreadReply } from '~/server/utils/notifications'
import { findSubmissionByPhone } from '~/server/utils/submission-messages'
import { isAuthorizedWhatsAppRecipient, isOrganizationWideRole, resolveMemberId, resolveOrganizationMembership } from '~/server/utils/member-access'
import { findVerifiedAuthUserByPhone } from '~/server/utils/auth'
import {
  PROMPT_QUOTE_NOTIFICATION_MESSAGE, REPLY_SENT_CONFIRMATION, buildCollectReplyPrompt, buildConfirmSendPrompt, buildDisambiguationPrompt, buildReplyFailedMessage, decideWhatsAppReplyRouting, maskEmailForDisplay, type DisambiguationCandidate, type PendingWhatsAppReplyState, } from '~/server/utils/whatsapp-reply-routing'

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
  guestEmail: string
}

async function resolveQuotedDelivery(
  db: D1Database, env: ApiRecord, providerMessageId: string, phone: string, ): Promise<QuotedDeliveryMatch | null> {
  const thread = await queryFirst<{
    request_id: string
    organization_id: string
    location_id: string | null
    guest_email: string | null
  }>(db, `
    SELECT gt.id AS request_id, gt.organization_id, gt.location_id,
           json_extract(gt.payload_json, '$.guest.email') AS guest_email
    FROM guest_thread_deliveries d
    JOIN activity_entries e ON e.id = d.entry_id
    JOIN requests gt ON gt.id = e.request_id
    WHERE d.provider = 'meta' AND d.provider_message_id = ?
    LIMIT 1
  `, [providerMessageId])
  if (!thread?.guest_email) return null

  const authorized = await isAuthorizedWhatsAppRecipient(db, {
    env: env as CloudflareEnv,
    phone, organizationId: thread.organization_id })
  if (!authorized) return null

  return { threadId: thread.request_id, organizationId: thread.organization_id, locationId: thread.location_id, guestEmail: thread.guest_email }
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
    JOIN member m ON m.organizationId = gt.organization_id AND m.userId = ?
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
    // Only the roles WhatsApp replies are authorized for see a thread's guest.
    return membership && isOrganizationWideRole(membership.role) ? row : null
  }))).filter((row): row is NonNullable<typeof row> => Boolean(row)).slice(0, 5)
  return authorizedRows.map((r) => ({
    threadId: r.threadId, organizationId: r.organizationId, locationId: r.locationId, label: `${submissionTypeLabel(r.submissionType)} from ${r.guestName}`, }))
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

  async function resolveFreshDispatch(): Promise<{
    quotedDeliveryMatch: 'authorized_thread_found' | 'unmatched' | null
    quotedDelivery: QuotedDeliveryMatch | null
    recentDeliveryCount: number
    recentCandidates: DisambiguationCandidate[]
  }> {
    let quotedDelivery: QuotedDeliveryMatch | null = null
    let quotedDeliveryMatch: 'authorized_thread_found' | 'unmatched' | null = null
    if (hasQuotedContext) {
      quotedDelivery = await resolveQuotedDelivery(db, env, contextId!, opts.toPhone)
      quotedDeliveryMatch = quotedDelivery ? 'authorized_thread_found' : 'unmatched'
    }

    let recentCandidates: DisambiguationCandidate[] = []
    if (!quotedDelivery) {
      recentCandidates = await listRecentGuestDeliveryCandidates(db, env, opts.userId)
    }

    return {
      quotedDeliveryMatch,
      quotedDelivery,
      recentDeliveryCount: recentCandidates.length,
      recentCandidates,
    }
  }

  if (!pendingState) {
    const fresh = await resolveFreshDispatch()

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
          const guestEmailMasked = maskEmailForDisplay(match.guestEmail)
          await sendWhatsAppText(env, opts.toPhone, buildConfirmSendPrompt(guestEmailMasked))
          return
        }
        const match = fresh.quotedDelivery!
        const guestEmailMasked = maskEmailForDisplay(match.guestEmail)
        const newState: PendingWhatsAppReplyState = {
          kind: 'confirm_send',
          threadId: match.threadId,
          organizationId: match.organizationId,
          locationId: match.locationId,
          replyBody: trimmedText,
          guestEmailMasked,
        }
        const sendResult = await sendWhatsAppText(env, opts.toPhone, buildConfirmSendPrompt(guestEmailMasked))
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
        await clearPending()
        await sendWhatsAppText(env, opts.toPhone, 'Your WhatsApp access has been revoked. Please contact your organization administrator.')
        return
      }
      const actorMemberId = await resolveMemberId({
        organizationId: pendingState.organizationId,
        userId: opts.userId,
        env,
      })
      const result = actorMemberId
        ? await executeGuestThreadOperation(db, {
            threadId: pendingState.threadId,
            organizationId: pendingState.organizationId,
            action: 'reply',
            actorUserId: opts.userId,
            body: pendingState.replyBody,
            env,
            idempotencyKey: `whatsapp:${opts.messageId}:reply`,
          })
        : { ok: false as const, status: 404 as const, reason: 'thread_not_found' as const }
      await clearPending()
      if (result.ok) {
        await publishGuestInboxThreadEvent(env, db, { threadId: result.thread.id, type: 'thread.changed' })
        await sendWhatsAppText(env, opts.toPhone, REPLY_SENT_CONFIRMATION)
      } else {
        await sendWhatsAppText(env, opts.toPhone, buildReplyFailedMessage(result.reason))
      }
      return
    }
    // Non-affirmative reply: drop the pending confirmation without sending, then treat
    // this message as an independent fresh dispatch (issue #293: "clear the pending
    // state... let normal routing resume for that message").
    await clearPending()
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
        await clearPending()
        await sendWhatsAppText(env, opts.toPhone, 'Your WhatsApp access has been revoked. Please contact your organization administrator.')
        return
      }

      const chosenThread = await getGuestRequest(db, chosen.threadId, chosen.organizationId)
      const chosenGuestEmail = chosenThread?.payload.guest.email ?? null
      if (!chosenGuestEmail) {
        await clearPending()
        await sendWhatsAppText(env, opts.toPhone, 'That guest has no email on file, so a reply cannot be sent.')
        return
      }
      const guestEmailMasked = maskEmailForDisplay(chosenGuestEmail)
      const newState: PendingWhatsAppReplyState = {
        kind: 'collect_reply',
        threadId: chosen.threadId,
        organizationId: chosen.organizationId,
        locationId: chosen.locationId,
        guestEmailMasked,
      }
      const sendResult = await sendWhatsAppText(env, opts.toPhone, buildCollectReplyPrompt(guestEmailMasked))
      if (!sendResult.success) throw new Error(sendResult.error || 'Failed to send WhatsApp reply prompt')
      await patchWhatsAppWorkspaceState(db, {
        userId: opts.userId,
        pendingConfirmation: newState,
        lastInboundId: opts.messageId,
      })
      return
    }
    await clearPending()
  } else {
    // collect_reply: any non-empty text becomes the reply body, moving to confirm_send.
    const newState: PendingWhatsAppReplyState = {
      kind: 'confirm_send',
      threadId: pendingState.threadId,
      organizationId: pendingState.organizationId,
      locationId: pendingState.locationId,
      replyBody: rawText,
      guestEmailMasked: pendingState.guestEmailMasked,
    }
    const sendResult = await sendWhatsAppText(env, opts.toPhone, buildConfirmSendPrompt(pendingState.guestEmailMasked))
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
      const guestEmailMasked = maskEmailForDisplay(match.guestEmail)
      const newState: PendingWhatsAppReplyState = {
        kind: 'confirm_send',
        threadId: match.threadId,
        organizationId: match.organizationId,
        locationId: match.locationId,
        replyBody: rawText,
        guestEmailMasked,
      }
      await patchWhatsAppWorkspaceState(db, {
        userId: opts.userId,
        pendingConfirmation: newState,
        lastInboundId: opts.messageId,
      })
      await sendWhatsAppText(env, opts.toPhone, buildConfirmSendPrompt(guestEmailMasked))
      return
    }
    case 'start_disambiguation': {
      const newState: PendingWhatsAppReplyState = { kind: 'disambiguate', candidates: fresh.recentCandidates }
      await patchWhatsAppWorkspaceState(db, {
        userId: opts.userId,
        pendingConfirmation: newState as unknown as JsonSerializable,
        lastInboundId: opts.messageId,
      })
      await sendWhatsAppText(env, opts.toPhone, buildDisambiguationPrompt(fresh.recentCandidates))
      return
    }
    case 'prompt_quote_notification':
    default: {
      await sendWhatsAppText(env, opts.toPhone, PROMPT_QUOTE_NOTIFICATION_MESSAGE)
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
import { defineHandler } from 'nitro';
import {  readRawBody  } from 'nitro/h3';
