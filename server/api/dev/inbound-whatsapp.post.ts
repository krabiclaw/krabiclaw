import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { assertDevRouteAllowed } from '~/server/utils/dev-route-auth'
import { parsePhoneOrThrow } from '~/utils/phone'
import { receiveGuestWhatsApp } from '~/server/domain/guest-threads/inbound-email'

/** A guest's WhatsApp message without Meta: the webhook's own guest path. */
export default defineHandler(async (event) => {
  assertDevRouteAllowed(event)
  const env = cloudflareEnv(event)
  const body = await readBody(event) as { from?: string; body?: string; messageId?: string; organizationId?: string }
  const from = body.from?.trim()
  const text = body.body?.trim()
  if (!from || !text) return jsonResponse({ error: 'from and body are required' }, { status: 400 })
  const messageId = body.messageId?.trim() || crypto.randomUUID()
  const received = await receiveGuestWhatsApp(env, { phone: parsePhoneOrThrow(from), messageId, body: text, files: [], organizationId: body.organizationId?.trim() || undefined })
  if (!received) return jsonResponse({ error: 'Submission not found for phone' }, { status: 404 })
  return jsonResponse({ received: true, conversationId: received.conversationId, messageId })
})
