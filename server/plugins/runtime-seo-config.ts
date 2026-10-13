import { definePlugin, HTTPError } from 'nitro'
import { getRouteRules } from 'nitro/app'
import { uneval } from 'devalue'

import { isPrivateSeoPath, resolveRuntimeSeoConfig } from '~/server/utils/seo-policy'
import type { TenantType } from '~/utils/tenant-routing'

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('render:html', (html, { event }) => {
    const rules = getRouteRules(event.req.method, event.url.pathname).routeRules
    // Nitro removes false matches; Nuxt renders a SPA when no ssr rule remains.
    if (rules?.ssr?.options || rules?.noScripts?.options) return
    const organization = event.context.organization
    if (!organization) throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant context unavailable' })

    // Nuxt's SPA renderer does not run Vue setup, where useState ordinarily
    // captures this request's public identity. Transport it as a custom payload
    // field so useState initializes Nuxt's reactive state normally on the client.
    // Append after Nuxt's own payload script with its serializer's HTML escaping.
    const tenantContext = uneval({
      organization,
      previewAuthorized: event.context.previewAuthorized === true,
    })
    html.bodyAppend.push(`<script>window.__NUXT__.tenantContext=${tenantContext}</script>`)
  })

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
