import type { ForwardableEmailMessage } from '@cloudflare/workers-types'
import { definePlugin } from 'nitro'
import PostalMime from 'postal-mime'
import { guestReplyText, InboundEmailRejection, receiveGuestEmail } from '~/server/domain/guest-threads/inbound-email'
import type { CloudflareEnv } from '~/server/utils/auth'
import { parseReplyToAddress } from '~/server/utils/submission-messages'
import { isEmailMessageId } from '~/server/utils/email-delivery'

// Checks what receiving a reply reads: the D1 binding and the secret that signs
// reply addresses. Without the secret every signature would fail to verify and
// every guest would get a bounce for a configuration fault, so a missing secret
// fails the delivery instead. Nothing here reads the auth or Google secrets.
function isCloudflareEnvironment(value: unknown): value is CloudflareEnv {
  if (typeof value !== 'object' || value === null) return false

  const database = Reflect.get(value, 'DB')
  const replySecret = Reflect.get(value, 'EMAIL_REPLY_SECRET')
  return typeof database === 'object'
    && database !== null
    && typeof Reflect.get(database, 'prepare') === 'function'
    && typeof Reflect.get(database, 'batch') === 'function'
    && typeof replySecret === 'string'
    && replySecret.length > 0
}

async function readEmailBytes(stream: ForwardableEmailMessage['raw']): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    chunks.push(chunk.value)
    byteLength += chunk.value.byteLength
  }

  const email = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    email.set(chunk, offset)
    offset += chunk.byteLength
  }
  return email
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function processEmail(message: ForwardableEmailMessage, env: unknown): Promise<void> {
  if (!isCloudflareEnvironment(env)) throw new Error('Inbound email needs the DB binding and EMAIL_REPLY_SECRET')

  const reply = parseReplyToAddress(env, message.to)
  if (!reply) throw new InboundEmailRejection('This address does not accept email.')

  const rawEmail = await readEmailBytes(message.raw)
  const parsed = await PostalMime.parse(rawEmail, { attachmentEncoding: 'arraybuffer' })
  const rfcMessageId = parsed.messageId?.trim() ?? null
  if (rfcMessageId !== null && !isEmailMessageId(rfcMessageId)) throw new InboundEmailRejection('This email has an invalid Message-ID.')
  const messageId = rfcMessageId ?? `content-sha256:${await sha256Hex(rawEmail)}`

  await receiveGuestEmail(env, {
    submissionType: reply.submissionType,
    submissionId: reply.submissionId,
    token: reply.token,
    body: guestReplyText(parsed),
    files: parsed.attachments.map((attachment) => {
      if (!(attachment.content instanceof ArrayBuffer)) throw new Error('postal-mime returned an attachment that is not an ArrayBuffer')
      return { bytes: new Uint8Array(attachment.content), filename: attachment.filename || 'attachment' }
    }),
    messageId,
    headers: {
      from: message.from.trim().toLowerCase(),
      subject: parsed.subject ?? null,
      messageId: rfcMessageId,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ?? null,
    },
  })
}

export default definePlugin((nitroApp) => {
  // A rejection bounces the email to its sender. Any other failure rejects the
  // handler, so Email Routing records the delivery as failed rather than done;
  // the Message-ID dedupe keeps a redelivery from recording it twice.
  nitroApp.hooks.hook('cloudflare:email', async ({ message, env }) => {
    try {
      await processEmail(message, env)
    } catch (error) {
      const rejected = error instanceof InboundEmailRejection
      console.error(rejected ? 'email_inbound_rejected' : 'email_inbound_processing_failed', {
        messageId: message.headers.get('Message-ID') ?? null,
        error: error instanceof Error ? error.message : String(error),
      })
      if (!rejected) throw error
      message.setReject(error.message)
    }
  })
})
