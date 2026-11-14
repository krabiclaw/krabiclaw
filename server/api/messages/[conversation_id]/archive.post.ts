import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { conversationRequest } from '~/server/utils/conversation-request'
import { conversationAccessDenied, participantGuard } from '~/server/domain/conversations'
import { archiveConversation } from '~/server/domain/guest-threads/repository'
import { publishConversationAck } from '~/server/cloudflare/guest-inbox-events'

export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { db, env, user, conversation, role } = await conversationRequest(event)
  if (role !== 'member') conversationAccessDenied()
  const { archived } = await readStrictBody<{ archived?: boolean }>(event, { archived: 'boolean' })
  if (typeof archived !== 'boolean') throw new HTTPError({ statusCode: 422, message: 'Specify archived', data: { code: 'INVALID_BODY_FIELD', field: 'archived' } })
  const result = await archiveConversation(db, { organizationId: conversation.organization_id, conversationId: conversation.id, userId: user.id, archived, guard: participantGuard('c', user.id, role) })
  await publishConversationAck(env, { organizationId: conversation.organization_id, conversationId: conversation.id, targetUserId: user.id })
  return jsonResponse(result)
})
