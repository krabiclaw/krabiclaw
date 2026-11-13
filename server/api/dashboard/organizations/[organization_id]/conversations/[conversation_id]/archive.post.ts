import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { memberConversation } from '~/server/utils/dashboard-guest-threads'
import { conversationAccessSql } from '~/server/domain/conversations'
import { archiveConversation } from '~/server/domain/guest-threads/repository'
import { publishConversationAck } from '~/server/cloudflare/guest-inbox-events'
import { messageText } from '~/server/domain/guest-message-schedule'

/** Archive or unarchive the conversation for this member alone: { archived: boolean }. */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organization_id'), 'organization_id', 200)
  const conversationId = messageText(getRouterParam(event, 'conversation_id'), 'conversation_id', 200)
  const body = await readStrictBody<{ archived?: boolean }>(event, { archived: 'boolean' })
  if (typeof body.archived !== 'boolean') throw new HTTPError({ statusCode: 400, message: 'Say whether the conversation is archived', data: { code: 'INVALID_BODY_FIELD', field: 'archived' } })
  const { db, env, principal } = await memberConversation(event, organizationId, conversationId)
  const result = await archiveConversation(db, { organizationId, conversationId, userId: principal.userId, guard: await conversationAccessSql('c', principal), archived: body.archived })
  await publishConversationAck(env, { organizationId, conversationId, targetUserId: principal.userId })
  return jsonResponse(result)
})
