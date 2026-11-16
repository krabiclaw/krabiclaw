// H3 middleware wraps dashboard editor handlers, so a cache purge failure changes
// the write's HTTP result before it can report success. The search index follows
// from the scheduled drain of the change the write recorded.
import { onResponse } from 'nitro/h3'
import type { DbClient } from '~/server/db'
import { purgeOrganizationCaches } from '~/server/utils/public-resource-cache'
import { publishBusinessInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'

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

  const runtimeEnv = request.runtime?.cloudflare?.env as GuestInboxPublicationEnv & {
    DB?: DbClient
    ORGANIZATION_CACHE?: KVNamespace
    NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN?: string
  } | undefined
  const kv = runtimeEnv?.ORGANIZATION_CACHE
  if (!kv || !runtimeEnv?.DB) throw new Error('ORGANIZATION_CACHE and DB bindings are required to purge site caches after a dashboard write')

  await purgeOrganizationCaches(runtimeEnv.DB, kv, organizationId, runtimeEnv.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)
  await publishBusinessInvalidation(runtimeEnv, organizationId)
  return response
})
