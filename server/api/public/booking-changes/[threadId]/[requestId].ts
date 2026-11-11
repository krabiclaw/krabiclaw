import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { createDb } from '~/server/db'
import { respondToBookingChange } from '~/server/domain/guest-threads/booking-changes'
import { readBearerToken } from '~/server/utils/reservation-cancel-token'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { getAuthSession } from '~/server/utils/auth'
import { requireFinancialBrowserOrigin } from '~/server/utils/financial-browser'

/**
 * The guest reads and answers a change the business proposed: from the email
 * link (its token) or signed in as the account that owns the booking, as on
 * Airbnb's reservation. One route for both.
 */
export default defineHandler(async (event) => {
  const method = event.req.method
  if (method !== 'GET' && method !== 'POST') throw new HTTPError({ statusCode: 405, message: 'Method not allowed' })
  const threadId = getRouterParam(event, 'threadId')
  const requestId = getRouterParam(event, 'requestId')
  if (!threadId || !requestId) throw new HTTPError({ statusCode: 400, message: 'Change request link is required' })
  const env = cloudflareEnv(event)
  const token = readBearerToken(event.req.headers.get('authorization'))
  let caller: { token: string } | { buyerUserId: string }
  if (token) caller = { token }
  else {
    const session = await getAuthSession(event, env)
    if (!session) throw new HTTPError({ statusCode: 401, message: 'Sign in or open the link you were emailed to answer this change' })
    requireFinancialBrowserOrigin(event)
    caller = { buyerUserId: session.user.id }
  }
  const body = method === 'POST' ? await readBody<{ decision?: unknown }>(event) : null
  if (method === 'POST' && body?.decision !== 'accept' && body?.decision !== 'decline') throw new HTTPError({ statusCode: 400, message: 'Choose accept or decline' })
  const decision = body?.decision === 'accept' || body?.decision === 'decline' ? body.decision : undefined
  const db = createDb(env.DB)
  const result = await respondToBookingChange(db, env, { threadId, requestId, decision, ...caller })
  if (decision) await publishConversationEvent(env, db, { conversationId: threadId, type: 'MESSAGE_CREATE' })
  return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
})
