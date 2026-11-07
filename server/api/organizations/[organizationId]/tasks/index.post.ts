import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { createTask } from '~/server/domain/tasks'
import { taskRouteContext } from '~/server/utils/task-route'

export default defineHandler(async (event) => {
  const { db, viewer } = await taskRouteContext(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { title: 'string', notes: 'nullable-string', startsAt: 'nullable-string', dueAt: 'nullable-string',
    assignedMemberId: 'nullable-string', assignedTeamId: 'nullable-string', productId: 'nullable-string', locationId: 'nullable-string', idempotencyKey: 'string' })
  const result = await createTask(db, await viewer(), body)
  return jsonResponse({ task: result.task }, { status: result.created ? 201 : 200 })
})
