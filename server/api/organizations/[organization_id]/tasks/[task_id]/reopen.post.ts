import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { reopenTask } from '~/server/domain/tasks'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

export default defineHandler(async (event) => {
  const { db, viewer } = await taskRouteContext(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { version: 'number' })
  return jsonResponse({ task: await reopenTask(db, await viewer(), routeId(event, 'task_id'), body) })
})
