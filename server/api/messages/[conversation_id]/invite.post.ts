import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { conversationRequest } from '~/server/utils/conversation-request'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { createConversationGuestInvite } from '~/server/domain/conversation-participants'
import { platformOrigin } from '~/server/utils/dashboard-notification-links'

export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { db, env, conversation, user } = await conversationRequest(event)
  const { email } = await readStrictBody<{ email?: string }>(event, { email: 'string' })
  if (!email) throw new HTTPError({ statusCode: 422, message: 'Enter the invited traveler’s email', data: { code: 'INVALID_INVITE_EMAIL', field: 'email' } })
  const invite = await createConversationGuestInvite(db, { organizationId: conversation.organization_id, userId: user.id }, { conversationId: conversation.id, email })
  const url = new URL('/messages/invite', platformOrigin(env))
  url.searchParams.set('token', invite.token)
  return jsonResponse({ url: url.href, expires_at: invite.expires_at }, { status: 201, headers: { 'cache-control': 'no-store' } })
})
