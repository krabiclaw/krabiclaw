import { HTTPError, type H3Event } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { resolveConversationAccess } from '~/server/domain/conversations'
import { cloudflareEnv } from './api-response'
import { getAuthSession } from './auth'
import { requireOrganizationPrincipal } from './location-access'
import { queryAll, queryFirst } from '~/server/db'

export async function messageSession(event: H3Event) {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session) throw new HTTPError({ statusCode: 401, message: 'Sign in to use Messages', data: { code: 'UNAUTHORIZED', field: 'session' } })
  return { env, db: env.DB, user: session.user }
}

export async function conversationRequest(event: H3Event) {
  const request = await messageSession(event)
  const conversationId = getRouterParam(event, 'conversation_id')
  if (!conversationId) throw new HTTPError({ statusCode: 400, message: 'A conversation is required', data: { code: 'VALIDATION_ERROR', field: 'conversation_id' } })
  return { ...request, ...await resolveConversationAccess(request.db, request.user.id, conversationId) }
}

export async function listingMessagingContext(event: H3Event) {
  const organizationId = getQuery(event).organization_id
  const listingId = getRouterParam(event, 'listing_id')
  if (typeof organizationId !== 'string' || !organizationId || !listingId) {
    throw new HTTPError({ statusCode: 400, message: 'A listing and workspace are required', data: { code: 'INVALID_LISTING', field: 'listing_id' } })
  }
  const context = await requireOrganizationPrincipal(event, organizationId)
  if (!context.principal.role.split(',').includes('owner')) {
    throw new HTTPError({ statusCode: 403, message: 'Only a workspace owner can manage listing messaging access', data: { code: 'FORBIDDEN', field: 'listing_id' } })
  }
  if (!await queryFirst(context.db, 'SELECT 1 FROM product_stay_configs WHERE organization_id = ? AND product_id = ?', [organizationId, listingId])) {
    throw new HTTPError({ statusCode: 404, message: 'Listing not found', data: { code: 'LISTING_NOT_FOUND', field: 'listing_id' } })
  }
  const memberIds = async () => (await queryAll<{ member_id: string }>(context.db,
    'SELECT member_id FROM listing_message_members WHERE organization_id = ? AND listing_id = ? ORDER BY member_id', [organizationId, listingId])).map(row => row.member_id)
  return { ...context, listingId, memberIds }
}
