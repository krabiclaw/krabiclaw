import { getReplyDomain } from '~/server/utils/reply-domain'

/**
 * An inbound email that delivering again cannot make acceptable. The message is
 * the bounce the sender reads, so it names the problem and nothing internal.
 */
export class InboundEmailRejection extends Error {}

interface ReplyAddressEnv {
  EMAIL_REPLY_SECRET?: string
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
}

const TOKEN_BYTES = 12

/**
 * Who a reply to an email speaks as: the guest the email went to, or the member
 * whose alert it was. The member's user id is signed but not written in the
 * address; the sender's address names them.
 */
export type ReplyAs = { kind: 'guest' } | { kind: 'member'; userId: string }

/** What a reply address carries: who replies, and the message (messages.id) the email was about. */
export interface ReplyAddress {
  kind: ReplyAs['kind']
  messageId: string
  token: string
}

const KIND_CODE = { guest: 'g', member: 'm' } as const

export async function hmacHex(secret: string, message: string, bytes: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(signature))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, bytes * 2)
}

export function timingSafeEqual(leftValue: string, rightValue: string): boolean {
  const textEncoder = new TextEncoder()
  const left = textEncoder.encode(leftValue)
  const right = textEncoder.encode(rightValue)
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return diff === 0
}

function replySecret(env: ReplyAddressEnv): string {
  if (!env.EMAIL_REPLY_SECRET) throw new Error('EMAIL_REPLY_SECRET is required to sign and verify reply addresses')
  return env.EMAIL_REPLY_SECRET
}

// The signed text keeps the shape mail already sent was signed with.
function signedFact(messageId: string, as: ReplyAs): string {
  return as.kind === 'guest' ? `guest:${messageId.toLowerCase()}` : `member:${messageId.toLowerCase()}:${as.userId}`
}

export async function buildReplyToken(secret: string, messageId: string, as: ReplyAs): Promise<string> {
  return hmacHex(secret, signedFact(messageId, as), TOKEN_BYTES)
}

/**
 * The reply-to of an email about a message:
 * r<g|m><message uuid without hyphens><24-hex-hmac>@reply.<domain>, 58
 * characters before the @. The message, not the conversation, is addressed
 * because a booking's conversation id is a 64-character hash, which does not
 * fit SMTP's 64-character local part. Message ids are UUIDs, and a message
 * keeps its id when it moves, so mail already sent still threads.
 */
export async function buildReplyToAddress(env: ReplyAddressEnv, messageId: string, as: ReplyAs): Promise<string> {
  const compact = messageId.toLowerCase().replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new Error(`Message ${messageId} is not a UUID a reply address can carry`)
  return `r${KIND_CODE[as.kind]}${compact}${await buildReplyToken(replySecret(env), messageId, as)}@${getReplyDomain(env)}`
}

/** The identity of a reply address; an address on another domain, or one KrabiClaw never issued, is refused. */
export function parseReplyToAddress(env: ReplyAddressEnv, address: string): ReplyAddress {
  const parts = address.split('@')
  const match = parts.length === 2 && parts[1]!.toLowerCase() === getReplyDomain(env).toLowerCase()
    ? /^r([gm])([0-9a-f]{32})([0-9a-f]{24})$/i.exec(parts[0]!) : null
  if (!match) throw new InboundEmailRejection('This address does not accept email.')
  const id = match[2]!.toLowerCase()
  return {
    kind: match[1]!.toLowerCase() === 'g' ? 'guest' : 'member',
    messageId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
    token: match[3]!.toLowerCase(),
  }
}

/** Whether `token` signs this message for this guest or member. */
export async function verifyReplyToken(env: ReplyAddressEnv, messageId: string, as: ReplyAs, token: string): Promise<boolean> {
  return timingSafeEqual(await buildReplyToken(replySecret(env), messageId, as), token)
}
