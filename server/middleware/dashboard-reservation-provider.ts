import { defineHandler } from 'nitro'
import { setHeader } from 'nitro/h3'
import { dashboardBookingDetails } from '~/server/utils/dashboard-bookings'
import { loadDashboardContext } from '~/server/utils/dashboard-context-service'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(event => {
  if (!event.url.pathname.startsWith('/dashboard/')) return
  event.context.dashboardReservationProvider = {
    context: async (orgSlug: string) => {
      setHeader(event, 'cache-control', 'private, no-store')
      return finalizeRequestMetrics(event, 'dashboard-context-ssr', await loadDashboardContext(event, { orgSlug }))
    },
    booking: async (orgSlug: string, bookingId: string) => {
      setHeader(event, 'cache-control', 'private, no-store')
      return finalizeRequestMetrics(event, 'dashboard-reservation-ssr', await dashboardBookingDetails(event, { orgSlug, bookingId }))
    },
  }
})
