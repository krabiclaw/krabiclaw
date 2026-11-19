import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { readDashboardToday } from '~/server/utils/dashboard-today'

export default defineHandler(async event => jsonResponse(await readDashboardToday(event), {
  headers: { 'cache-control': 'private, no-store' },
}))
