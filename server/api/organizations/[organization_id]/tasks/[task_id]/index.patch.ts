import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { updateTask } from '~/server/domain/tasks'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

export default defineHandler(async (event) => {
  const { db, viewer } = await taskRouteContext(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { version: 'number', title: 'string', notes: 'nullable-string', starts_at: 'nullable-string', due_at: 'nullable-string',
    assigned_member_id: 'nullable-string' })
  return jsonResponse({ task: await updateTask(db, await viewer(), routeId(event, 'task_id'), body) })
})
