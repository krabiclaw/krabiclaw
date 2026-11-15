import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { closeTask } from '~/server/domain/tasks'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

// One tap: the body is empty. What the person found they say in the job's conversation.
export default defineHandler(async (event) => {
  const { db, env, viewer } = await taskRouteContext(event)
  await readStrictBody(event, {})
  return jsonResponse({ task: await closeTask(db, await viewer(), routeId(event, 'task_id'), { status: 'skipped', env }) })
})
