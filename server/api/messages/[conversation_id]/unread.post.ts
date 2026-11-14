import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { conversationRequest } from '~/server/utils/conversation-request'
import { markConversationUnread, participantGuard } from '~/server/domain/conversations'
import { publishConversationAck } from '~/server/cloudflare/guest-inbox-events'

export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { db, env, user, conversation, role } = await conversationRequest(event)
  const unread = await markConversationUnread(db, { organizationId: conversation.organization_id, conversationId: conversation.id, userId: user.id, guard: participantGuard('c', user.id, role) })
  await publishConversationAck(env, { organizationId: conversation.organization_id, conversationId: conversation.id, targetUserId: user.id })
  return jsonResponse(unread)
})
