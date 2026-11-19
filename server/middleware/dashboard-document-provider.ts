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
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { readDashboardTodayDocument } from '~/server/utils/dashboard-today'
import { oncePerRequest } from '~/server/utils/request-scope'

export default defineHandler(event => {
  if (!event.url.pathname.startsWith('/dashboard/')) return
  event.context.dashboardDocumentProvider = {
    read: (orgSlug: string, resource: string, query: Record<string, unknown>) => {
      const key = JSON.stringify(Object.entries(query).sort(([left], [right]) => left.localeCompare(right)))
      return oncePerRequest(event, `dashboard-document:${orgSlug}:${resource}:${key}`, async () => {
        const website = event.context.dashboardWebsite as { settings: unknown; content: Map<string, unknown> } | undefined
        switch (resource) {
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
          case '/api/integrations/social-connections':
            await getDashboardContext(event, { organizationSlug: orgSlug })
            if (!website?.content.has('post-connections')) throw new HTTPError({ statusCode: 404, message: 'Publishing destinations were not read for this document' })
            return website.content.get('post-connections')
          case '/api/dashboard/locations': {
            await getDashboardContext(event, { organizationSlug: orgSlug })
            const locations = query.organization === 'true' ? website?.content.get('post-locations') : null
            if (!locations) throw new HTTPError({ statusCode: 404, message: 'Locations were not read for this document' })
            return locations
          }
          case '/api/dashboard/settings':
            if (query.view === 'website') {
              await getDashboardContext(event, { organizationSlug: orgSlug })
              if (!website) throw new HTTPError({ statusCode: 500, message: 'Website settings were not read for this document' })
              return website.settings
            }
            return readDashboardConnectionsDocument(event, orgSlug)
          case '/api/dashboard/integrations/google-calendar':
            return readCalendarSettingsDocument(event, orgSlug)
          default:
            if (resource.startsWith('/api/editor/')) {
              const { organization } = await getDashboardMemberContext(event, { organizationSlug: orgSlug })
              const prefix = `/api/editor/organizations/${organization.id}/`
              const product = event.context.dashboardProduct as { organization_id: string; path: string; resource: unknown } | undefined
              if (product?.organization_id === organization.id && resource === `${prefix}${product.path}`) return product.resource
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
