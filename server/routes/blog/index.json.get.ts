import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import {
  buildBlogIndexJson, buildTenantBlogLinkEntries, buildPlatformBlogLinkEntries, listPublishedTenantBlogPostsForLlm, listPublishedPlatformBlogPostsForLlm, resolvePublicOrigin, } from '~/server/utils/platform-llm'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const origin = resolvePublicOrigin(event)
  const isTenant = event.context.tenantType === 'tenant'
  const organizationId = isTenant ? String(event.context.organizationId || '') : ''
  const posts = isTenant && organizationId
    ? await listPublishedTenantBlogPostsForLlm(db, organizationId, env)
    : await listPublishedPlatformBlogPostsForLlm(db, env)
  const entries = isTenant && organizationId
    ? buildTenantBlogLinkEntries(posts ?? [], origin)
    : buildPlatformBlogLinkEntries(posts ?? [], origin)
  return jsonResponse(buildBlogIndexJson(entries))
})
import { defineHandler } from 'nitro';
