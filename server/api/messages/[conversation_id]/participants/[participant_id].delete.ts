import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { conversationRequest } from '~/server/utils/conversation-request'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { removeConversationGuest } from '~/server/domain/conversation-participants'

export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { db, env, user, conversation, role } = await conversationRequest(event)
  const participantId = getRouterParam(event, 'participant_id', { decode: true })
  if (!participantId) throw new HTTPError({ statusCode: 400, message: 'A participant is required', data: { code: 'VALIDATION_ERROR', field: 'participant_id' } })
  return jsonResponse(await removeConversationGuest(db, env, {
    conversationId: conversation.id, organizationId: conversation.organization_id, userId: user.id,
    ...(role === 'guest' ? { invitationId: participantId } : { travelerUserId: participantId }),
  }))
})
