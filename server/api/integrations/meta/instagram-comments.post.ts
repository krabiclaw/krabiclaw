import { defineHandler } from 'nitro'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { queryFirst } from '~/server/db'
import { instagramAccessToken } from '~/server/utils/instagram'
import { metaGraphRequest } from '~/server/utils/meta-graph'

interface InstagramCommentValue {
  id: string
  text?: string
  from?: { id?: string; username?: string }
  media?: { id?: string; media_product_type?: string }
}

interface InstagramWebhookEntry {
  id: string
  time?: number
  changes?: Array<{
    field: string
    value: InstagramCommentValue
  }>
}

interface InstagramWebhookPayload {
  object?: string
  entry?: InstagramWebhookEntry[]
}

export const COMMENT_TRIGGER_REGEX = /(^|\b)(yes|book|link|menu)($|\b)/i

export async function verifyInstagramWebhookSignature(
  rawBody: string,
  signature: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!appSecret || !signature) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const incomingHex = signature.startsWith('sha256=') ? signature.slice(7) : ''
  const pairs = incomingHex.match(/.{2}/g)
  const parsedPairs = pairs && pairs.length === 32 ? pairs.map(b => parseInt(b, 16)) : null
  const incomingBytes = parsedPairs && parsedPairs.every(n => !Number.isNaN(n))
    ? new Uint8Array(parsedPairs)
    : new Uint8Array(0)

  return incomingBytes.length === 32 && await crypto.subtle.verify(
    { name: 'HMAC', hash: 'SHA-256' },
    key,
    incomingBytes,
    new TextEncoder().encode(rawBody),
  )
}

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const rawBody = (await event.req.text()) ?? ''

  // Validate Meta webhook signature
  const appSecret = env.INSTAGRAM_APP_SECRET || env.WHATSAPP_APP_SECRET || ''
  if (!appSecret) {
    return jsonResponse({ error: 'Missing app secret configuration' }, { status: 500 })
  }

  const signature = event.req.headers.get('x-hub-signature-256')
  const isValid = await verifyInstagramWebhookSignature(rawBody, signature, appSecret)

  if (!isValid) {
    return jsonResponse({ error: 'Invalid signature' }, { status: 403 })
  }

  let payload: InstagramWebhookPayload
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    return jsonResponse({ error: 'Malformed JSON payload' }, { status: 400 })
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : []
  let repliesDispatched = 0
  const deliveryErrors: string[] = []

  for (const entry of entries) {
    const instagramAccountId = entry.id
    if (!instagramAccountId) continue

    const integration = await queryFirst<{ organization_id: string; account_id: string }>(
      env.DB,
      `SELECT organization_id, account_id FROM organization_integrations WHERE provider = 'instagram' AND target_id = ? LIMIT 1`,
      [instagramAccountId],
    )
    if (!integration) continue

    const domainRow = await queryFirst<{ domain: string }>(
      env.DB,
      `SELECT domain FROM organization_domains WHERE organization_id = ? AND role = 'canonical' AND status = 'active' LIMIT 1`,
      [integration.organization_id],
    )
    const host = domainRow?.domain || ''
    const bookingUrl = host ? `https://${host}/book` : ''

    const changes = Array.isArray(entry.changes) ? entry.changes : []
    for (const change of changes) {
      if (change.field !== 'comments') continue
      const comment = change.value
      if (!comment?.id || !comment.text || comment.from?.id === instagramAccountId) continue

      if (!COMMENT_TRIGGER_REGEX.test(comment.text)) continue

      try {
        const token = await instagramAccessToken(env, integration.account_id)
        const messageText = bookingUrl
          ? `Thanks for your comment! Here is the direct link to book with us: ${bookingUrl}`
          : 'Thanks for your comment! Visit our website to book.'

        await metaGraphRequest(`https://graph.instagram.com/v25.0/${instagramAccountId}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            recipient: { comment_id: comment.id },
            message: { text: messageText },
          }),
        })
        repliesDispatched++
      } catch (err) {
        deliveryErrors.push(`${comment.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (deliveryErrors.length) {
    return jsonResponse({ success: false, repliesDispatched, errors: deliveryErrors }, { status: 502 })
  }

  return jsonResponse({ success: true, repliesDispatched })
})
