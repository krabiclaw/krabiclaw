// Tenant resolution already admits only live or preview-authorized sites.
// Routing owns platform-only path refusal and a site's canonical host redirect.
import { HTTPError, defineHandler } from 'nitro'
import { redirect } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { isTenantOnlySeoPath } from '~/server/utils/seo-policy'
import { platformHostname } from '~/server/utils/domains'
import { TENANT_TYPES } from '~/utils/tenant-routing'

export default defineHandler((event) => {
  const { tenantType, canonicalDomain, tenantHost } = event.context
  const { pathname, search } = event.url
  if (tenantType === TENANT_TYPES.PLATFORM) {
    if (isTenantOnlySeoPath(pathname)) throw new HTTPError({ statusCode: 404, statusMessage: 'Page not found' })
    return
  }
  if (tenantType !== TENANT_TYPES.TENANT || event.context.previewAuthorized === true) return

  const freeDomain = platformHostname(cloudflareEnv(event))
  if (canonicalDomain && !String(canonicalDomain).endsWith(`.${freeDomain}`)
    && tenantHost !== canonicalDomain && !pathname.startsWith('/api/')) {
    return redirect(`https://${canonicalDomain}${pathname}${search}`, 301)
  }
})
