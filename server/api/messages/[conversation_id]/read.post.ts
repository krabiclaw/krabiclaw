import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { conversationRequest } from '~/server/utils/conversation-request'
import { markConversationRead, participantGuard } from '~/server/domain/conversations'
import { publishConversationAck } from '~/server/cloudflare/guest-inbox-events'

export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { db, env, user, conversation, role } = await conversationRequest(event)
  const body = await readStrictBody<{ message_id?: string | null }>(event, { message_id: 'nullable-string' })
  const read = await markConversationRead(db, { organizationId: conversation.organization_id, conversationId: conversation.id, userId: user.id, guard: participantGuard('c', user.id, role), throughMessageId: body.message_id })
  await publishConversationAck(env, { organizationId: conversation.organization_id, conversationId: conversation.id, targetUserId: user.id })
  return jsonResponse(read)
})
