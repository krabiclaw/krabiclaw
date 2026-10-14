import { definePlugin } from 'nitro'

import { isPrivateSeoPath, resolveRuntimeSeoConfig } from '~/server/utils/seo-policy'
import type { TenantType } from '~/utils/tenant-routing'

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('site-config:init', ({ event, siteConfig }) => {
    const requestURL = event.url
    if (isPrivateSeoPath(requestURL.pathname)) return

    const organization = event.context.organization as { name?: string | null } | undefined

    siteConfig.push({
      _context: 'runtime-tenant',
      ...resolveRuntimeSeoConfig({
        tenantType: event.context.tenantType as TenantType | null | undefined,
        origin: requestURL.origin,
        hostname: requestURL.hostname,
        tenantName: organization?.name,
        organizationId: event.context.organizationId as string | undefined,
      }),
    })
  })
})
