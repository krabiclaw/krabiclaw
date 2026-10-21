import { HTTPError, defineHandler  } from 'nitro';

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import {
  buildNamedBlogJsonFeed, buildTenantBlogLinkEntries, buildPlatformBlogLinkEntries, listPublishedTenantBlogPostsForLlm, listPublishedPlatformBlogPostsForLlm, resolvePublicOrigin, } from '~/server/utils/platform-llm'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const origin = resolvePublicOrigin(event)
  const isTenant = event.context.tenantType === 'tenant'
  const organizationId = isTenant ? String(event.context.organizationId || '') : ''
  const organizationName = (event.context.organization as { name?: string | null } | undefined)?.name?.trim() || ''
  if (isTenant && organizationId && !organizationName) throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant brand name is not configured' })
  const posts = isTenant && organizationId
    ? await listPublishedTenantBlogPostsForLlm(db, organizationId, env)
    : await listPublishedPlatformBlogPostsForLlm(db, env)
  const entries = isTenant && organizationId
    ? buildTenantBlogLinkEntries(posts ?? [], origin)
    : buildPlatformBlogLinkEntries(posts ?? [], origin)
  return jsonResponse(buildNamedBlogJsonFeed(origin, entries, isTenant ? {
    title: `${organizationName} Blog`, description: `Published blog feed for ${organizationName}.`, } : {}))
})
