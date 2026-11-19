import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { readDashboardAgenda } from '~/server/utils/dashboard-agenda-reader'
import { readDashboardConnections } from '~/server/utils/dashboard-connections'
import { readDashboardEarnings } from '~/server/utils/dashboard-earnings'
import { readDashboardStayHomes } from '~/server/utils/dashboard-stay-homes'
import { readGoogleCalendarSettings } from '~/server/utils/google-calendar'
import { defineHandler, HTTPError } from 'nitro'
import { setHeader } from 'nitro/h3'
import { loadDashboardCatalog } from '~/server/utils/dashboard-catalog'
import { dashboardBookingCalendar, dashboardBookingDetails } from '~/server/utils/dashboard-bookings'
import { loadDashboardContext } from '~/server/utils/dashboard-context-service'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { readDashboardToday } from '~/server/utils/dashboard-today'
import { oncePerRequest } from '~/server/utils/request-scope'

export default defineHandler(event => {
  if (!event.url.pathname.startsWith('/dashboard/')) return
  event.context.dashboardDocumentProvider = {
    read: (orgSlug: string, resource: string, query: Record<string, unknown>) => {
      const key = JSON.stringify(Object.entries(query).sort(([left], [right]) => left.localeCompare(right)))
      return oncePerRequest(event, `dashboard-document:${orgSlug}:${resource}:${key}`, async () => {
        switch (resource) {
          case '/api/dashboard/agenda':
            return readDashboardAgenda(event, query, orgSlug)
          case '/api/dashboard/bookings/calendar':
            if (query.unit !== 'nights' && query.unit !== 'slot') throw new HTTPError({ statusCode: 400, message: 'Calendar unit is required' })
            return dashboardBookingCalendar(event, query, orgSlug)
          case '/api/dashboard/stay-homes':
            return readDashboardStayHomes(event, orgSlug, true)
          case '/api/dashboard/payments':
            if (query.view !== 'performance') throw new HTTPError({ statusCode: 400, message: 'Earnings performance is required' })
            return readDashboardEarnings(event, query, orgSlug)
          case '/api/dashboard/settings':
            return readDashboardConnections(event, orgSlug)
          case '/api/dashboard/integrations/google-calendar': {
            const { organization } = await getDashboardMemberContext(event, { organizationSlug: orgSlug })
            return readGoogleCalendarSettings(event, organization.id, true)
          }
          default:
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
      return finalizeRequestMetrics(event, 'dashboard-catalog-ssr', await loadDashboardCatalog(event, orgSlug))
    }),
    today: (orgSlug: string) => oncePerRequest(event, `dashboard-today:${orgSlug}`, () => readDashboardToday(event, orgSlug)),
    booking: (orgSlug: string, bookingId: string) => oncePerRequest(event, `dashboard-reservation:${orgSlug}:${bookingId}`, async () => {
      setHeader(event, 'cache-control', 'private, no-store')
      return finalizeRequestMetrics(event, 'dashboard-reservation-ssr', await dashboardBookingDetails(event, { orgSlug, bookingId }))
    }),
  }
})
