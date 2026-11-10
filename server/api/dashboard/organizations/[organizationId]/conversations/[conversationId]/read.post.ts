import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { memberConversation } from '~/server/utils/dashboard-guest-threads'
import { markConversationRead } from '~/server/domain/conversations'
import { publishConversationAck } from '~/server/cloudflare/guest-inbox-events'
import { messageText } from '~/server/domain/guest-message-schedule'

/**
 * Read the conversation through `messageId`, the newest message the member was
 * shown when they opened it, or through its newest message (Mark as read).
 */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organizationId'), 'organizationId', 200)
  const conversationId = messageText(getRouterParam(event, 'conversationId'), 'conversationId', 200)
  const body = await readStrictBody<{ messageId?: string | null }>(event, { messageId: 'nullable-string' })
  const { db, env, principal } = await memberConversation(event, organizationId, conversationId)
  const read = await markConversationRead(db, { organizationId, conversationId, userId: principal.userId, throughMessageId: body.messageId ?? null })
  await publishConversationAck(env, { organizationId, conversationId, targetUserId: principal.userId })
  return jsonResponse(read)
})
