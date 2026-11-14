import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { messageSession } from '~/server/utils/conversation-request'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { acceptConversationGuestInvite } from '~/server/domain/conversation-participants'

export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { db, env, user } = await messageSession(event)
  const { token } = await readStrictBody<{ token?: string }>(event, { token: 'string' })
  if (!token) throw new HTTPError({ statusCode: 404, message: 'Invitation not found', data: { code: 'INVITATION_NOT_FOUND', field: 'token' } })
  return jsonResponse(await acceptConversationGuestInvite(db, env, { token, user }), { headers: { 'cache-control': 'no-store' } })
})
