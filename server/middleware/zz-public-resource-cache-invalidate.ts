// H3 middleware wraps dashboard editor handlers, so a cache purge failure changes
// the write's HTTP result before it can report success. The search index follows
// from the committed invalidation event.
import { onResponse } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { purgeOrganizationCaches } from '~/server/utils/public-resource-cache'
import { publishBusinessInvalidation } from '~/server/cloudflare/guest-inbox-events'

const EDITOR_ORGANIZATIONS_PREFIX = '/api/editor/organizations/'

export default onResponse(async (response, event) => {
  const request = event.req
  const path = new URL(request.url).pathname
  if (request.method === 'GET' || request.method === 'HEAD') return response
  if (!path.startsWith(EDITOR_ORGANIZATIONS_PREFIX)) return response
  if (response.status < 200 || response.status >= 300) return response

  const params = event.context.params
  const organizationId = params && typeof params.organization_id === 'string' ? params.organization_id : undefined
  if (!organizationId) throw new Error('Organization ID is required to invalidate a successful dashboard write')

  const env = cloudflareEnv(event)
  if (!env.ORGANIZATION_CACHE || !env.DB) throw new Error('ORGANIZATION_CACHE and DB bindings are required to purge site caches after a dashboard write')

  await purgeOrganizationCaches(env.DB, env.ORGANIZATION_CACHE, organizationId, env)
  await publishBusinessInvalidation(env, organizationId)
  return response
})
