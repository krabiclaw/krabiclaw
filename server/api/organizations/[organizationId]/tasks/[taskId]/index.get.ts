import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getTask } from '~/server/domain/tasks'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

export default defineHandler(async (event) => {
  const { db, viewer } = await taskRouteContext(event)
  return jsonResponse({ task: await getTask(db, await viewer(), routeId(event, 'taskId')) }, { headers: { 'cache-control': 'private, no-store' } })
})
