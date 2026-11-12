import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardBookingDetails } from '~/server/utils/dashboard-bookings'

export default defineHandler(async event => jsonResponse(await dashboardBookingDetails(event)))
