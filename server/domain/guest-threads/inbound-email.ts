import { HTTPError } from 'nitro'
import EmailReplyParser from 'email-reply-parser'
import { compile } from 'html-to-text'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { getGuestRequest, getThreadOperationalRecord, requestSummary } from '~/server/domain/requests'
import { MessageDedupeConflictError, MessageStateConflictError, appendMessage, findMessageByDedupeKey, getMessage, guestOwnsGuard, type MessageRow } from '~/server/domain/conversations'
import { attachGuestPhotos, sortGuestFiles, type MessagePhoto, assertMessagePhotos } from '~/server/domain/guest-threads/attachments'
import { conversationTaskQueries } from '~/server/domain/guest-threads/repository'
import type { CloudflareEnv } from '~/server/utils/auth'
import { notifyGuestThreadReply } from '~/server/utils/notifications'
import { findSubmissionByPhone, type SubmissionType } from '~/server/utils/submission-messages'
import { queryFirst } from '~/server/db'
import { REPLY_FAILED_ALERTED, replyToAlertEntry } from './member-reply'
import { InboundEmailRejection, verifyReplyToken } from '~/server/utils/reply-address'

export interface InboundGuestEmail {
  /** The message the email the guest replied to carried (its reply-to address names it). */
  entryId: string
  token: string
  body: string
  /** Every file the email carried, in order. */
  files: MessagePhoto[]
  /** Dedupe identity; a content hash is used when no RFC Message-ID was sent. */
  messageId: string
  /** The actual envelope sender and parsed RFC headers, without invented values. */
  headers: {
    from: string
    subject: string | null
    messageId: string | null
    inReplyTo: string | null
    references: string | null
  }
}

// A single-part HTML reply has no text/plain alternative. Quoted containers are
// skipped here; the reply parser below removes whatever quoting remains, so the
// HTML and plain-text paths share one quote parser.
const htmlToText = compile({
  wordwrap: false,
  selectors: [
    { selector: 'blockquote', format: 'skip' },
    { selector: '.gmail_quote', format: 'skip' },
    { selector: '.yahoo_quoted', format: 'skip' },
    { selector: 'img', format: 'skip' },
  ],
})

/**
 * The text the guest newly wrote in an inbound email: the mail client's quoted
 * copy of the thread and the guest's signature are removed. An empty result
 * means the email carried no new text.
 */
export function guestReplyText(mime: { text?: string, html?: string }): string {
  // A text/plain part holding only whitespace is not the message; the HTML part
  // is. A text part with any content stays the source, so a quote-only plain
  // part never falls through to HTML quoting the selectors above may not know.
  const text = mime.text?.trim() ? mime.text : (mime.html ? htmlToText(mime.html) : '')
  return new EmailReplyParser().read(text).getVisibleText().trim()
}

/** The conversation a signed reply address's message belongs to. */
async function addressedConversation(env: CloudflareEnv, entryId: string) {
  const message = await getMessage(env.DB, entryId)
  const thread = message ? await getGuestRequest(env.DB, message.conversation_id) : null
  if (!thread) throw new InboundEmailRejection('This conversation no longer exists.')
  return thread
}

export async function receiveGuestEmail(env: CloudflareEnv, email: InboundGuestEmail): Promise<void> {
  if (!await verifyReplyToken(env, email.entryId, { kind: 'guest' }, email.token)) throw new InboundEmailRejection('This reply address is not valid.')
  const thread = await addressedConversation(env, email.entryId)

  // A reply with nothing newly written (only the quoted thread or a signature)
  // is accepted and records nothing.
  const { photos, unshown } = sortGuestFiles(email.files)
  if (!email.body && !photos.length && !unshown.length) return

  await receiveGuestReply(env, {
    threadId:thread.id, organizationId:thread.organization_id,
    submissionType:thread.kind, body:email.body, photos, unshown,
    channel:'email', userId:null, dedupeKey:`email:${email.messageId}`, headers:email.headers,
  })
}

/**
 * A guest's WhatsApp message, matched to their open booking conversation by
 * phone (or, on Meta's redelivery, by the message already written for it). It
 * is the guest's message on the `whatsapp` channel, as email and web replies
 * are theirs; a message with no words or files records nothing.
 */
export async function receiveGuestWhatsApp(env: CloudflareEnv, input: { phone: string; messageId: string; body: string; files: MessagePhoto[]; organizationId?: string }): Promise<{ conversationId: string } | null> {
  const dedupeKey = `whatsapp:${input.messageId}`
  const existing = await findMessageByDedupeKey(env.DB, dedupeKey)
  const match = existing
    ? await getGuestRequest(env.DB, existing.conversation_id)
    : await findSubmissionByPhone(env.DB, input.phone, input.organizationId).then(found => found ? getGuestRequest(env.DB, found.submissionId, found.organizationId) : null)
  if (!match) return null
  const { photos, unshown } = sortGuestFiles(input.files)
  if (!input.body && !photos.length && !unshown.length) return { conversationId: match.id }
  await receiveGuestReply(env, {
    threadId: match.id, organizationId: match.organization_id, submissionType: match.kind,
    body: input.body, photos, unshown, channel: 'whatsapp', userId: null, dedupeKey,
  })
  return { conversationId: match.id }
}

export interface InboundMemberEmail {
  /** The conversation event the alert was about. */
  entryId: string
  token: string
  /** The envelope sender: the member's own account address. */
  from: string
  body: string
  files: MessagePhoto[]
  /** Dedupe identity; a content hash is used when no RFC Message-ID was sent. */
  messageId: string
}

/**
 * A member replying to their alert about a guest or team conversation. The
 * sender's address names the member and the address's signature proves the alert
 * went to them about this entry; the reply is then the dashboard's own, as them. Anything
 * that stops it bounces with the reason.
 */
export async function receiveMemberEmail(env: CloudflareEnv, email: InboundMemberEmail, report: (error: unknown) => Promise<void>): Promise<void> {
  const user = await queryFirst<{ id: string }>(env.DB, 'SELECT id FROM user WHERE lower(email) = ? AND "emailVerified" = 1', [email.from.trim().toLowerCase()])
  if (!user || !await verifyReplyToken(env, email.entryId, { kind: 'member', userId: user.id }, email.token)) {
    throw new InboundEmailRejection('This reply address is not valid for the address you replied from. Reply from the address the alert was sent to, or answer from the dashboard.')
  }
  const outcome = await replyToAlertEntry(env, { entryId: email.entryId, userId: user.id, body: email.body, files: email.files, idempotencyKey: `email:${email.messageId}` })
  // A failure the member cannot act on fails the delivery. Any other failure is
  // reported while the member still reads the outcome: that the reply went, or
  // that it may have reached the guest, so they do not send it again.
  if (outcome.report !== null && outcome.notice === REPLY_FAILED_ALERTED) {
    throw outcome.report instanceof Error ? outcome.report : new Error(String(outcome.report), { cause: outcome.report })
  }
  if (outcome.report !== null) await report(outcome.report)
  if (!outcome.sent) throw new InboundEmailRejection(outcome.notice)
}

/** Authenticated web replies use the same immutable guest-message pipeline as email. */
export async function receiveGuestWebReply(env:CloudflareEnv,input:{threadId:string;userId:string;body:string;photos:MessagePhoto[];idempotencyKey:string}):Promise<void> {
  if(!/^[a-zA-Z0-9_-]{8,128}$/u.test(input.idempotencyKey))throw new HTTPError({statusCode:400,statusMessage:'A valid idempotency key is required'})
  const thread=await getGuestRequest(env.DB,input.threadId,undefined,undefined,input.userId)
  if(!thread||thread.user_id!==input.userId)throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
  const record=await getThreadOperationalRecord(env.DB,thread.id)
  if(record&&(record.user_id!==input.userId||record.organization_id!==thread.organization_id))throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
  const body=input.body.trim()
  if(!body&&!input.photos.length)throw new HTTPError({statusCode:400,statusMessage:'Write a message or add a photo'})
  // The upload's bytes and name are immutable input, so a reused key cannot
  // silently replace photos already attached to its original message.
  const photoManifest=await Promise.all(input.photos.map(async photo=>({filename:photo.filename,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',photo.bytes))).map(v=>v.toString(16).padStart(2,'0')).join('')})))
  try {
    await receiveGuestReply(env, {threadId:thread.id,organizationId:thread.organization_id,submissionType:thread.kind,body,photos:input.photos,unshown:[],channel:'web',userId:input.userId,dedupeKey:`guest-web-reply:${thread.id}:${input.idempotencyKey}`,photoManifest})
  } catch(error) {
    if(error instanceof MessageStateConflictError)throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
    if(error instanceof MessageDedupeConflictError)throw new HTTPError({statusCode:409,statusMessage:'This reply key belongs to a different message'})
    throw error
  }
}

async function receiveGuestReply(env:CloudflareEnv,input:{threadId:string;organizationId:string;submissionType:SubmissionType;body:string;photos:MessagePhoto[];unshown:string[];userId:string|null;dedupeKey:string;photoManifest?:Array<{filename:string;sha256:string}>}&({channel:'email';headers:InboundGuestEmail['headers']}|{channel:'web'|'whatsapp';headers?:never})):Promise<void> {
  const db=env.DB,thread=await getGuestRequest(db,input.threadId,input.organizationId,input.submissionType,input.userId??undefined)
  if(!thread)throw new Error('Conversation no longer exists')
  const {photos,unshown}=input
  // Photos are checked before the message is saved, so a rejected photo never leaves a message without it.
  assertMessagePhotos(photos)
  let entry: MessageRow
  try {
    // The guest is the conversation's guest account, whether they wrote on the web signed in or by email.
    entry = await appendMessage(db, {
      conversationId:thread.id,authorKind:'guest',authorUserId:input.userId??thread.user_id,
      channel:input.channel,body:input.body||null,
      payload:{...(unshown.length?{unshownFiles:unshown}:{}),...(input.photoManifest?{photos:input.photoManifest}:{}),...(input.channel==='email'?{email:input.headers}:{})},
      dedupeKey:input.dedupeKey,
      ...(input.userId?{guard:guestOwnsGuard(input.userId)}:{}),
    }, conversationTaskQueries(thread.id, new Date().toISOString()))
  } catch(error) {
    if(input.channel==='email'&&error instanceof MessageDedupeConflictError)throw new InboundEmailRejection('A different message with this Message-ID was already received.')
    throw error
  }
  await attachGuestPhotos(db,env,input.organizationId,entry.id,photos,input.userId?{source:'uploaded',userId:input.userId}:{source:'external',userId:null})
  // The guest's message is in the conversation before the owner is alerted, so an alert that fails cannot hide it.
  await publishConversationEvent(env,db,{conversationId:thread.id,type:'MESSAGE_CREATE'})
  const summary=await requestSummary(db,thread)
  await notifyGuestThreadReply(env,db,{
    organizationId:input.organizationId,locationId:summary.locationId,threadId:thread.id,messageId:entry.id,
    submissionType:input.submissionType,submissionId:input.threadId,
    participantLabel:summary.participantLabel,guestEmail:summary.guestEmail,guestPhone:summary.guestPhone,
    inboundChannel:input.channel,
  })
}
