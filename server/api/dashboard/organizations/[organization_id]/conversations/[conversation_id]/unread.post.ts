import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { memberConversation } from '~/server/utils/dashboard-guest-threads'
import { markConversationUnread } from '~/server/domain/conversations'
import { publishConversationAck } from '~/server/cloudflare/guest-inbox-events'
import { messageText } from '~/server/domain/guest-message-schedule'

/** Mark as unread: the newest message from someone else is unread again for this member. */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organization_id'), 'organization_id', 200)
  const conversationId = messageText(getRouterParam(event, 'conversation_id'), 'conversation_id', 200)
  const { db, env, principal } = await memberConversation(event, organizationId, conversationId)
  const unread = await markConversationUnread(db, { organizationId, conversationId, userId: principal.userId })
  await publishConversationAck(env, { organizationId, conversationId, targetUserId: principal.userId })
  return jsonResponse(unread)
})
