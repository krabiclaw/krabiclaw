import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { setDashboardGuestThreadRead } from '~/server/utils/dashboard-guest-threads'
import { messageText } from '~/server/domain/guest-message-schedule'

/** Mark the conversation unread for this member: its newest alert shows as new again. */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organizationId'), 'organizationId', 200)
  const threadId = messageText(getRouterParam(event, 'threadId'), 'threadId', 200)
  return jsonResponse(await setDashboardGuestThreadRead(event, organizationId, threadId, false))
})
