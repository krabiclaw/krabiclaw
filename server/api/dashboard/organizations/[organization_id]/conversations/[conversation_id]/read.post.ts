import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { memberConversation } from '~/server/utils/dashboard-guest-threads'
import { conversationAccessSql, markConversationRead } from '~/server/domain/conversations'
import { publishConversationAck } from '~/server/cloudflare/guest-inbox-events'
import { messageText } from '~/server/domain/guest-message-schedule'

/**
 * Read the conversation through `message_id`, the newest message the member was
 * shown when they opened it, or through its newest message (Mark as read).
 */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organization_id'), 'organization_id', 200)
  const conversationId = messageText(getRouterParam(event, 'conversation_id'), 'conversation_id', 200)
  const body = await readStrictBody<{ message_id?: string | null }>(event, { message_id: 'nullable-string' })
  const { db, env, principal } = await memberConversation(event, organizationId, conversationId)
  const read = await markConversationRead(db, { organizationId, conversationId, userId: principal.userId, guard: await conversationAccessSql('c', principal), throughMessageId: body.message_id ?? null })
  await publishConversationAck(env, { organizationId, conversationId, targetUserId: principal.userId })
  return jsonResponse(read)
})
