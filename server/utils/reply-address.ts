export type ReplySubmissionType = 'contact' | 'reservation' | 'booking' | 'stay'

const TOKEN_BYTES = 12

const TYPE_TO_CODE: Record<ReplySubmissionType, 'c' | 'r' | 'e' | 's'> = {
  contact: 'c',
  reservation: 'r',
  booking: 'e',
  stay: 's',
}

const CODE_TO_TYPE: Record<'c' | 'r' | 'e' | 's', ReplySubmissionType> = {
  c: 'contact',
  r: 'reservation',
  e: 'booking',
  s: 'stay',
}

function compactUuid(value: string): string | null {
  const compact = value.toLowerCase().replace(/-/g, '')
  return /^[0-9a-f]{32}$/.test(compact) ? compact : null
}

function expandUuid(value: string): string {
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

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

export async function buildReplyToken(secret: string, submissionType: ReplySubmissionType, submissionId: string): Promise<string> {
  return hmacHex(secret, `${submissionType}:${submissionId.toLowerCase()}`, TOKEN_BYTES)
}

export async function verifyReplyTokenValue(secret: string, submissionType: string, submissionId: string, token: string): Promise<boolean> {
  const message = `${submissionType}:${submissionId.toLowerCase()}`
  const expected = await hmacHex(secret, message, TOKEN_BYTES)
  return timingSafeEqual(expected, token)
}

// Compact format keeps the local part under the 64-character SMTP limit:
// r<type><uuid-without-hyphens><24-char-hmac>@reply.<domain>
export function buildReplyLocalPart(submissionType: ReplySubmissionType, submissionId: string, token: string): string | null {
  const typeCode = TYPE_TO_CODE[submissionType]
  const compactId = compactUuid(submissionId)
  if (!compactId || !/^[0-9a-f]{24}$/i.test(token)) return null
  return `r${typeCode}${compactId}${token}`
}

export function parseReplyLocalPart(local: string): { submissionType: ReplySubmissionType; submissionId: string; token: string } | null {
  const compactMatch = /^r([cres])([0-9a-f]{32})([0-9a-f]{24})$/i.exec(local)
  if (compactMatch) {
    const code = compactMatch[1]!.toLowerCase() as 'c' | 'r' | 'e' | 's'
    return {
      submissionType: CODE_TO_TYPE[code],
      submissionId: expandUuid(compactMatch[2]!.toLowerCase()),
      token: compactMatch[3]!.toLowerCase(),
    }
  }

  return null
}
