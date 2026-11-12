import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { loadDashboardGuestThreadDetails } from '~/server/utils/dashboard-guest-threads'
import { messageText } from '~/server/domain/guest-message-schedule'

/** "In this conversation": participants with their roles, the gallery newest first, and the conversation's actions. */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organization_id'), 'organizationId', 200)
  const threadId = messageText(getRouterParam(event, 'conversation_id'), 'conversation_id', 200)
  return jsonResponse(await loadDashboardGuestThreadDetails(event, organizationId, threadId))
})
