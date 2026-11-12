import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { listTaskAssignees, listTasks, parseTaskListQuery } from '~/server/domain/tasks'
import { taskRouteContext } from '~/server/utils/task-route'

export default defineHandler(async (event) => {
  const { db, viewer } = await taskRouteContext(event)
  const caller = await viewer()
  const [list, assignees] = await Promise.all([listTasks(db, caller, parseTaskListQuery(getQuery(event))), listTaskAssignees(db, caller)])
  return jsonResponse({ ...list, assignees }, { headers: { 'cache-control': 'private, no-store' } })
})
