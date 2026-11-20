import { parseHomesAdding } from '~/server/utils/billing'
import { stayAccessFor } from '~/server/domain/stays'
import { memberAccessPrincipal, roleAllows, assertRoleAllows } from '~/server/utils/member-access'
import { getDashboardContext, getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { readDashboardAgenda } from '~/server/utils/dashboard-agenda-reader'
import { readDashboardConnectionsDocument } from '~/server/utils/dashboard-connections'
import { readDashboardEarnings, readDashboardPayoutsDocument } from '~/server/utils/dashboard-earnings'
import { readDashboardStayHomes } from '~/server/utils/dashboard-stay-homes'
import { readCalendarSettingsDocument } from '~/server/utils/google-calendar'
import { defineHandler, HTTPError } from 'nitro'
import { setHeader } from 'nitro/h3'
import { readDashboardCatalogDocument } from '~/server/utils/dashboard-catalog'
import { dashboardBookingCalendar, readCalendarPlacePresence, readDashboardBookingDocument } from '~/server/utils/dashboard-bookings'
import { loadDashboardContext } from '~/server/utils/dashboard-context-service'
import { finalizeRequestMetrics, timeRequestPhase } from '~/server/utils/request-metrics'
import { readDashboardTodayDocument } from '~/server/utils/dashboard-today'
import { oncePerRequest } from '~/server/utils/request-scope'

export default defineHandler(event => {
  if (!event.url.pathname.startsWith('/dashboard/')) return
  event.context.dashboardDocumentProvider = {
    read: (orgSlug: string, resource: string, query: Record<string, unknown>) => {
      const key = JSON.stringify(Object.entries(query).sort(([left], [right]) => left.localeCompare(right)))
      return oncePerRequest(event, `dashboard-document:${orgSlug}:${resource}:${key}`, async () => {
        const website = event.context.dashboardWebsite as { settings: unknown; content: Map<string, unknown> } | undefined
        const homeId = /^\/api\/dashboard\/stay-homes\/([^/]+)$/.exec(resource)?.[1]
        if (homeId) {
          const { env, organization } = await getDashboardMemberContext(event, { organizationSlug: orgSlug })
          const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
          const home = event.context.dashboardStayHome as { organization_id: string; product_id: string; read: () => unknown } | undefined
          if (home?.organization_id !== organization.id || home.product_id !== decodeURIComponent(homeId)) throw new HTTPError({ statusCode: 404, message: 'Arrival guide was not read for this document' })
          return { home: home.read(), manage: access.manage }
        }

        switch (resource) {
          case '/api/dashboard/stay-homes/setup': {
            const { env, organization } = await getDashboardMemberContext(event, { organizationSlug: orgSlug })
            const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
            if (!access.manage) throw new HTTPError({ statusCode: 403, message: 'Only managers can add a home' })
            const setup = event.context.dashboardHomeSetup as { organization_id: string; read: () => unknown } | undefined
            if (setup?.organization_id !== organization.id) throw new HTTPError({ statusCode: 404, message: 'Home setup was not read for this document' })
            return setup.read()
          }
          case '/api/dashboard/agenda':
            return readDashboardAgenda(event, query, orgSlug)
          case '/api/dashboard/bookings/calendar':
            if (query.view === 'scope') return readCalendarPlacePresence(event, orgSlug)
            if (query.unit !== 'nights' && query.unit !== 'slot') throw new HTTPError({ statusCode: 400, message: 'Calendar unit is required' })
            return dashboardBookingCalendar(event, query, orgSlug)
          case '/api/dashboard/stay-homes':
            return readDashboardStayHomes(event, orgSlug, true)
          case '/api/dashboard/payments':
            if (query.view === 'payouts') return readDashboardPayoutsDocument(event, orgSlug, query.after)
            if (query.view !== 'performance') throw new HTTPError({ statusCode: 400, message: 'Earnings performance is required' })
            return readDashboardEarnings(event, query, orgSlug)
          case '/api/integrations/social-connections': {
            const { organization } = await getDashboardMemberContext(event, { organizationSlug: orgSlug })
            const scope = event.context.dashboardPostScope as { organization_id: string; location_id: string | null } | undefined
            if (query.locationId !== undefined && typeof query.locationId !== 'string') throw new HTTPError({ statusCode: 400, message: 'Invalid publishing scope' })
            const locationId = typeof query.locationId === 'string' && query.locationId ? query.locationId : null
            if (scope?.organization_id !== organization.id || scope.location_id !== locationId || query.organizationId !== undefined && query.organizationId !== organization.id) throw new HTTPError({ statusCode: 404, message: 'Publishing scope was not read for this document' })
            if (locationId === null) await getDashboardContext(event, { organizationSlug: orgSlug })
            if (!website?.content.has('post-connections')) throw new HTTPError({ statusCode: 404, message: 'Publishing destinations were not read for this document' })
            return website.content.get('post-connections')
          }
          case '/api/dashboard/locations': {
            const { organization } = await getDashboardMemberContext(event, { organizationSlug: orgSlug })
            if (query.view === 'editor') {
              const location = event.context.dashboardLocation as { organization_id: string; resource: { location: { location: { slug: string } } } } | undefined
              if (location?.organization_id !== organization.id || location.resource.location.location.slug !== query.location_slug) throw new HTTPError({ statusCode: 404, message: 'Location was not read for this document' })
              return location.resource
            }
            const index = event.context.dashboardLocations as { organization_id: string; include_inactive: boolean; resource: unknown } | undefined
            if (query.organization === 'true' && (query.status === 'all') === index?.include_inactive && index?.organization_id === organization.id) return index.resource
            const product = event.context.dashboardProduct as { organization_id: string; resource: { locations: unknown[] } } | undefined
            if (query.organization === 'true' && query.status === 'all' && product?.organization_id === organization.id) return { success: true, locations: product.resource.locations }
            const locations = query.organization === 'true' ? website?.content.get('post-locations') : null
            if (!locations) throw new HTTPError({ statusCode: 404, message: 'Locations were not read for this document' })
            return locations
          }
          case '/api/dashboard/settings':
            if (query.view === 'website') {
              await getDashboardContext(event, { organizationSlug: orgSlug })
              if (!website?.settings) throw new HTTPError({ statusCode: 500, message: 'Website settings were not read for this document' })
              return website.settings
            }
            return readDashboardConnectionsDocument(event, orgSlug)
          case '/api/dashboard/integrations/google-calendar':
            return readCalendarSettingsDocument(event, orgSlug)
          default:
            if (/^\/api\/organizations\/[^/]+\/billing\/homes$/.test(resource)) {
              const { organization } = await getDashboardContext(event, { organizationSlug: orgSlug })
              const quote = event.context.dashboardHomesQuote as { organization_id: string; adding: number; read: () => Promise<unknown> } | undefined
              if (resource !== `/api/organizations/${organization.id}/billing/homes` || quote?.organization_id !== organization.id || quote.adding !== parseHomesAdding(query.adding)) throw new HTTPError({ statusCode: 404, message: 'Home cost was not read for this document' })
              return await timeRequestPhase(event, 'stripe_quote', () => quote.read())
            }
            if (/^\/api\/organizations\/[^/]+\/domains$/.test(resource)) {
              const { organization } = await getDashboardContext(event, { organizationSlug: orgSlug })
              const domains = event.context.dashboardDomains as { organization_id: string; resource: unknown } | undefined
              if (resource !== `/api/organizations/${organization.id}/domains` || domains?.organization_id !== organization.id) throw new HTTPError({ statusCode: 404, message: 'Domains were not read for this document' })
              return domains.resource
            }
            if (resource.startsWith('/api/editor/') || /^\/api\/organizations\/[^/]+\/members\/scheduling$/.test(resource)
              || /^\/api\/messages\/listings\/[^/]+\/participants$/.test(resource)) {
              const { organization } = await getDashboardMemberContext(event, { organizationSlug: orgSlug })
              const prefix = `/api/editor/organizations/${organization.id}/`
              if (resource === `${prefix}locales` && query.view === 'progress') {
                await getDashboardContext(event, { organizationSlug: orgSlug })
                const locales = event.context.dashboardLocales as { organization_id: string; resource: unknown } | undefined
                if (locales?.organization_id !== organization.id) throw new HTTPError({ statusCode: 404, message: 'Languages were not read for this document' })
                return locales.resource
              }

              const location = event.context.dashboardLocation as { organization_id: string; resource: { location: { location: { id: string } }; gallery?: unknown } } | undefined
              if (resource === `${prefix}media` && location?.organization_id === organization.id && query.owner_type === 'business_location'
                && query.owner_id === location.resource.location.location.id && query.slot === 'gallery' && query.limit === '100' && location.resource.gallery) return location.resource.gallery

              const product = event.context.dashboardProduct as { organization_id: string; product_id: string; path: string; resource: { member_options?: unknown; listing_access?: unknown; schedule?: { location_id: string; rules: unknown } } } | undefined
              if (product?.organization_id === organization.id) {
                if (resource === `${prefix}${product.path}`) return product.resource
                if (resource === `/api/messages/listings/${encodeURIComponent(product.product_id)}/participants`
                  && query.organization_id === organization.id && product.resource.listing_access) return product.resource.listing_access
                if (resource === `/api/organizations/${organization.id}/members/scheduling` && query.view === 'assignment' && product.resource.member_options) return product.resource.member_options
                if (resource === `${prefix}products/${encodeURIComponent(product.product_id)}/availability`
                  && product.resource.schedule && product.resource.schedule.location_id === query.location_id) return { success: true, rules: product.resource.schedule.rules }
              }
              if (resource === `${prefix}products` && query.include === 'collections') {
                if (!await roleAllows({ ...organization, permissions: { products: ['read'] } })) await assertRoleAllows({ ...organization, permissions: { products: ['assigned'] } })
                const catalog = event.context.dashboardEditorCatalog as { organization_id: string; resources: Map<string, unknown> } | undefined
                const key = query.kind === 'dish' ? `dish:${typeof query.location_id === 'string' ? query.location_id : 'all'}` : 'all'
                const resource = catalog?.organization_id === organization.id ? catalog.resources.get(key) : undefined
                if (!resource) throw new HTTPError({ statusCode: 404, message: 'The editor catalog was not read for this document' })
                return resource
              }
              const content = resource.startsWith(prefix) ? website?.content.get(resource.slice(prefix.length)) : null
              if (!content) throw new HTTPError({ statusCode: 404, message: 'Website content was not read for this document' })
              return content
            }
            throw new HTTPError({ statusCode: 500, message: 'Dashboard document resource is unavailable' })
        }
      })
    },
    context: (orgSlug: string) => oncePerRequest(event, `dashboard-context:${orgSlug}`, async () => {
      setHeader(event, 'cache-control', 'private, no-store')
      return finalizeRequestMetrics(event, 'dashboard-context-ssr', await loadDashboardContext(event, { orgSlug }))
    }),
    catalog: (orgSlug: string) => oncePerRequest(event, `dashboard-catalog:${orgSlug}`, async () => {
      setHeader(event, 'cache-control', 'private, no-store')
      return finalizeRequestMetrics(event, 'dashboard-catalog-ssr', await readDashboardCatalogDocument(event, orgSlug))
    }),
    today: (orgSlug: string) => readDashboardTodayDocument(event, orgSlug),
    booking: (orgSlug: string, bookingId: string) => oncePerRequest(event, `dashboard-reservation:${orgSlug}:${bookingId}`, async () => {
      setHeader(event, 'cache-control', 'private, no-store')
      return finalizeRequestMetrics(event, 'dashboard-reservation-ssr', await readDashboardBookingDocument(event, { orgSlug, bookingId }))
    }),
  }
})
