import { defineHandler } from 'nitro'
import { setHeader } from 'nitro/h3'
import { dashboardBookingDetails } from '~/server/utils/dashboard-bookings'
import { loadDashboardContext } from '~/server/utils/dashboard-context-service'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { oncePerRequest } from '~/server/utils/request-scope'

export default defineHandler(event => {
  if (!event.url.pathname.startsWith('/dashboard/')) return
  event.context.dashboardReservationProvider = {
    context: (orgSlug: string) => oncePerRequest(event, `dashboard-context:${orgSlug}`, async () => {
      setHeader(event, 'cache-control', 'private, no-store')
      return finalizeRequestMetrics(event, 'dashboard-context-ssr', await loadDashboardContext(event, { orgSlug }))
    }),
    booking: (orgSlug: string, bookingId: string) => oncePerRequest(event, `dashboard-reservation:${orgSlug}:${bookingId}`, async () => {
      setHeader(event, 'cache-control', 'private, no-store')
      return finalizeRequestMetrics(event, 'dashboard-reservation-ssr', await dashboardBookingDetails(event, { orgSlug, bookingId }))
    }),
  }
})
