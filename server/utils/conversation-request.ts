import type { StoredListingAccess } from '~/utils/organization-access'
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
  return { ...request, ...await resolveConversationAccess(request.db, request.user.id, conversationIdParam(event)) }
}

export function conversationIdParam(event: H3Event): string {
  // h3 hands route params over still percent-encoded; an id such as "v27-stay-conversation:<uuid>" arrives as "%3A".
  const id = getRouterParam(event, 'conversation_id', { decode: true })
  if (!id) throw new HTTPError({ statusCode: 400, message: 'A conversation is required', data: { code: 'VALIDATION_ERROR', field: 'conversation_id' } })
  return id
}

export async function listingAccessContext(event: H3Event) {
  const organizationId = getQuery(event).organization_id
  const listingId = getRouterParam(event, 'listing_id', { decode: true })
  if (typeof organizationId !== 'string' || !organizationId || !listingId) {
    throw new HTTPError({ statusCode: 400, message: 'A listing and workspace are required', data: { code: 'INVALID_LISTING', field: 'listing_id' } })
  }
  const context = await requireOrganizationPrincipal(event, organizationId)
  if (!context.principal.role.split(',').includes('owner')) {
    throw new HTTPError({ statusCode: 403, message: 'Only a workspace owner can manage listing access', data: { code: 'FORBIDDEN', field: 'listing_id' } })
  }
  if (!await queryFirst(context.db, "SELECT 1 FROM products WHERE organization_id = ? AND id = ? AND kind IN ('stay', 'table', 'service', 'experience')", [organizationId, listingId])) {
    throw new HTTPError({ statusCode: 404, message: 'Listing not found', data: { code: 'LISTING_NOT_FOUND', field: 'listing_id' } })
  }
  const grants = () => queryAll<{ member_id: string; access: StoredListingAccess }>(context.db,
    'SELECT member_id, access FROM listing_message_members WHERE organization_id = ? AND listing_id = ? ORDER BY member_id', [organizationId, listingId])
  return { ...context, listingId, grants }
}
