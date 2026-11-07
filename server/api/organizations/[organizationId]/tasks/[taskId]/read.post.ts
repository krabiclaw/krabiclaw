import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getTask } from '~/server/domain/tasks'
import { acknowledgeTaskNotifications } from '~/server/utils/notification-acknowledgement'
import { publishNotificationInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

// Opening a task reads its alerts, as opening a conversation does.
export default defineHandler(async (event) => {
  const { db, env, principal, viewer } = await taskRouteContext(event)
  const taskId = routeId(event, 'taskId')
  const task = await getTask(db, await viewer(), taskId)
  if (await acknowledgeTaskNotifications(db, principal.userId, principal.organizationId, taskId) > 0) {
    await publishNotificationInvalidation(env, { type: 'notification.read', organizationId: principal.organizationId, locationId: task.locationId, targetUserId: principal.userId })
  }
  return jsonResponse({ task })
})
