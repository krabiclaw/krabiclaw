import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardBookingCalendar } from '~/server/utils/dashboard-bookings'

export default defineHandler(async event => jsonResponse(await dashboardBookingCalendar(event, getQuery(event))))
