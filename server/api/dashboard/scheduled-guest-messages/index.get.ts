import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { assertConversationAccess } from '~/server/domain/conversations'
import { stayAccessFor } from '~/server/domain/stays'
import { listScheduledGuestMessages } from '~/server/domain/guest-messaging'
import { messagingError, parseMessageListQuery } from '~/server/domain/guest-message-schedule'

export default defineHandler(async (event) => {
  const query = getQuery(event), page = parseMessageListQuery(query, ['conversation_id'])
  if ('conversation_id' in query && (typeof query.conversation_id !== 'string' || !query.conversation_id.trim())) messagingError(400, 'INVALID_MESSAGING_QUERY', 'conversation_id must identify a guest conversation', 'conversation_id')
  const conversationId = typeof query.conversation_id === 'string' ? query.conversation_id : null
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event }), access = await stayAccessFor(principal)
  if (conversationId !== null) await assertConversationAccess(db, principal, conversationId)
  return jsonResponse(await listScheduledGuestMessages(db, access, page, conversationId))
})
