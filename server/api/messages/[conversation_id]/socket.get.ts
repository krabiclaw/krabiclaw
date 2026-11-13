import { HTTPError, defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { resolveConversationAccess } from '~/server/domain/conversations'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'

export default defineHandler(async (event) => {
  if (event.req.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HTTPError({ statusCode: 426, message: 'Expected WebSocket upgrade' })
  requireFinancialBrowserOrAppRequest(event)
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session?.user.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required' })
  const conversationId = getRouterParam(event, 'conversation_id') || ''
  const { conversation } = await resolveConversationAccess(env.DB, session.user.id, conversationId)
  const namespace = env.GUEST_INBOX_HUBS
  if (!namespace) throw new HTTPError({ statusCode: 503, message: 'Dashboard realtime binding is not configured', data: { code: 'REALTIME_CONFIGURATION_REQUIRED' } })
  const headers = new Headers(event.req.headers)
  headers.set('x-krabiclaw-organization-id', conversation.organization_id)
  headers.set('x-krabiclaw-conversation-id', conversationId)
  const response = await namespace.get(namespace.idFromName(conversation.organization_id)).fetch(event.req.url, { method: event.req.method, headers })
  return response.status === 101 ? response : new Response(response.body, response)
})
