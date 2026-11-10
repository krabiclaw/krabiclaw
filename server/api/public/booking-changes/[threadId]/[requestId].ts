import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { createDb } from '~/server/db'
import { respondToBookingChange } from '~/server/domain/guest-threads/booking-changes'
import { readBearerToken } from '~/server/utils/reservation-cancel-token'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'

export default defineHandler(async (event) => {
  const method = event.req.method
  if (method !== 'GET' && method !== 'POST') throw new HTTPError({ statusCode: 405, message: 'Method not allowed' })
  const threadId = getRouterParam(event, 'threadId')
  const requestId = getRouterParam(event, 'requestId')
  const token = readBearerToken(event.req.headers.get('authorization'))
  if (!threadId || !requestId || !token) throw new HTTPError({ statusCode: 400, message: 'Change request link is required' })
  const body = method === 'POST' ? await readBody<{ decision?: unknown }>(event) : null
  if (method === 'POST' && body?.decision !== 'accept' && body?.decision !== 'decline') throw new HTTPError({ statusCode: 400, message: 'Choose accept or decline' })
  const decision = body?.decision === 'accept' || body?.decision === 'decline' ? body.decision : undefined
  const env = cloudflareEnv(event)
  const db = createDb(env.DB)
  const result = await respondToBookingChange(db, env, { threadId, requestId, token, decision })
  if (decision) await publishConversationEvent(env, db, { conversationId: threadId, type: 'MESSAGE_CREATE' })
  return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
})
