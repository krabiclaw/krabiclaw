import { HTTPError } from 'nitro'
import EmailReplyParser from 'email-reply-parser'
import { compile } from 'html-to-text'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { getGuestRequest, getThreadOperationalRecord, requestSummary } from '~/server/domain/requests'
import { appendEntry, GuestThreadEntryDedupeConflictError, GuestThreadEntryOwnershipError } from '~/server/domain/guest-threads/entries'
import { attachGuestPhotos, messagePreview, sortGuestFiles, type MessagePhoto, assertMessagePhotos } from '~/server/domain/guest-threads/attachments'
import { updateThreadProjectionIfLatestEntry } from '~/server/domain/guest-threads/repository'
import type { GuestThreadEntryRow } from '~/server/domain/guest-threads/types'
import type { CloudflareEnv } from '~/server/utils/auth'
import { notifyGuestThreadReply } from '~/server/utils/notifications'
import { getSubmissionOrganization, verifyReplyToken, type SubmissionType } from '~/server/utils/submission-messages'

/**
 * An inbound email that delivering again cannot make acceptable. The message is
 * the bounce the sender reads, so it names the problem and nothing internal.
 * Any other error from receiving an email is one a later delivery may not hit.
 */
export class InboundEmailRejection extends Error {}

export interface InboundGuestEmail {
  submissionType: SubmissionType
  submissionId: string
  token: string
  body: string
  /** Every file the email carried, in order. */
  files: MessagePhoto[]
  messageId: string
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

export async function receiveGuestEmail(env: CloudflareEnv, email: InboundGuestEmail): Promise<void> {
  const tokenIsValid = await verifyReplyToken(
    env,
    email.submissionType,
    email.submissionId,
    email.token,
  )
  if (!tokenIsValid) throw new InboundEmailRejection('This reply address is not valid.')

  const db = env.DB
  const organization = await getSubmissionOrganization(db, email.submissionType, email.submissionId)
  if (!organization) throw new InboundEmailRejection('This conversation no longer exists.')

  const thread = await getGuestRequest(db, email.submissionId, undefined, email.submissionType)
  if (!thread) throw new InboundEmailRejection('This conversation no longer exists.')

  // A reply with nothing newly written (only the quoted thread or a signature)
  // is accepted and records nothing.
  const { photos, unshown } = sortGuestFiles(email.files)
  if (!email.body && !photos.length && !unshown.length) return

  await receiveGuestReply(env, {
    threadId:thread.id, organizationId:organization.organizationId,
    submissionType:email.submissionType, body:email.body, photos, unshown,
    channel:'email', userId:null, dedupeKey:`email:${email.messageId}`,
  })
}

/** Authenticated web replies use the same immutable guest-message pipeline as email. */
export async function receiveGuestWebReply(env:CloudflareEnv,input:{threadId:string;userId:string;body:string;photos:MessagePhoto[];idempotencyKey:string}):Promise<void> {
  if(!/^[a-zA-Z0-9_-]{8,128}$/u.test(input.idempotencyKey))throw new HTTPError({statusCode:400,statusMessage:'A valid idempotency key is required'})
  const thread=await getGuestRequest(env.DB,input.threadId,undefined,undefined,input.userId)
  if(!thread||thread.user_id!==input.userId)throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
  const record=await getThreadOperationalRecord(env.DB,thread.id)
  if(record&&(record.user_id!==input.userId||record.organization_id!==thread.organization_id||record.kind!==thread.kind))throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
  const body=input.body.trim()
  if(!body&&!input.photos.length)throw new HTTPError({statusCode:400,statusMessage:'Write a message or add a photo'})
  // The upload's bytes and name are immutable input, so a reused key cannot
  // silently replace photos already attached to its original message.
  const photoManifest=await Promise.all(input.photos.map(async photo=>({filename:photo.filename,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',photo.bytes))).map(v=>v.toString(16).padStart(2,'0')).join('')})))
  try {
    await receiveGuestReply(env, {threadId:thread.id,organizationId:thread.organization_id,submissionType:thread.kind,body,photos:input.photos,unshown:[],channel:'web',userId:input.userId,dedupeKey:`guest-web-reply:${thread.id}:${input.idempotencyKey}`,photoManifest})
  } catch(error) {
    if(error instanceof GuestThreadEntryOwnershipError)throw new HTTPError({statusCode:404,statusMessage:'Conversation not found'})
    if(error instanceof GuestThreadEntryDedupeConflictError)throw new HTTPError({statusCode:409,statusMessage:'This reply key belongs to a different message'})
    throw error
  }
}

async function receiveGuestReply(env:CloudflareEnv,input:{threadId:string;organizationId:string;submissionType:SubmissionType;body:string;photos:MessagePhoto[];unshown:string[];channel:'email'|'web';userId:string|null;dedupeKey:string;photoManifest?:Array<{filename:string;sha256:string}>}):Promise<void> {
  const db=env.DB,thread=await getGuestRequest(db,input.threadId,input.organizationId,input.submissionType,input.userId??undefined)
  if(!thread)throw new Error('Conversation no longer exists')
  const {photos,unshown}=input
  // Photos are checked before the message is saved, so a rejected photo never leaves a message without it.
  assertMessagePhotos(photos)
  let entry: GuestThreadEntryRow
  try {
    entry = await appendEntry(db, {
      threadId:thread.id,kind:'message',actorKind:'guest',actorUserId:input.userId,...(input.userId?{buyerUserId:input.userId}:{}),
      channel:input.channel,body:input.body||null,
      payloadJson:{...(unshown.length?{unshownFiles:unshown}:{}),...(input.photoManifest?{photos:input.photoManifest}:{})},
      dedupeKey:input.dedupeKey,
    })
  } catch(error) {
    if(input.channel==='email'&&error instanceof GuestThreadEntryDedupeConflictError)throw new InboundEmailRejection('A different message with this Message-ID was already received.')
    throw error
  }
  await attachGuestPhotos(db,env,input.organizationId,entry.id,photos,input.userId?{source:'uploaded',userId:input.userId}:{source:'external',userId:null})
  await updateThreadProjectionIfLatestEntry(db,thread.id,entry.id,{conversationState:'needs_attention'})
  // The guest's message is in the thread before the owner is alerted, so an alert that fails cannot hide it.
  await publishGuestInboxThreadEvent(env,db,{threadId:thread.id,type:'entry.appended'})
  const summary=await requestSummary(db,thread)
  await notifyGuestThreadReply(env,db,{
    organizationId:input.organizationId,locationId:summary.locationId,threadId:thread.id,sourceEntryId:entry.id,
    submissionType:input.submissionType,submissionId:input.threadId,
    participantLabel:summary.participantLabel,guestEmail:summary.guestEmail,guestPhone:summary.guestPhone,
    inboundChannel:input.channel,messagePreview:messagePreview(input.body,photos.length),
  })
}
