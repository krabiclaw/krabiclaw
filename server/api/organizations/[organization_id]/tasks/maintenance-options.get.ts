import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { maintenanceOptions } from '~/server/domain/tasks'
import { taskRouteContext } from '~/server/utils/task-route'

/** Where a maintenance job can be sent and who can do it, for the sheet that creates one. */
export default defineHandler(async (event) => {
  const { db, viewer } = await taskRouteContext(event)
  return jsonResponse(await maintenanceOptions(db, await viewer()), { headers: { 'cache-control': 'private, no-store' } })
})
