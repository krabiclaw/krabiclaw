import { HTTPError, defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'

export default defineHandler((event) => {
  const env = cloudflareEnv(event)
  const query = getQuery(event)
  const mode = String(query['hub.mode'] ?? '')
  const token = String(query['hub.verify_token'] ?? '')
  const challenge = String(query['hub.challenge'] ?? '')

  const verifyToken = env.INSTAGRAM_VERIFY_TOKEN || env.WHATSAPP_VERIFY_TOKEN
  if (!verifyToken) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'Missing Meta verify token configuration' })
  }

  if (mode !== 'subscribe' || token !== verifyToken) {
    throw new HTTPError({ statusCode: 403, statusMessage: 'Webhook verification failed' })
  }

  if (!challenge.trim()) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Webhook challenge is required' })
  }

  return new Response(challenge, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
})
