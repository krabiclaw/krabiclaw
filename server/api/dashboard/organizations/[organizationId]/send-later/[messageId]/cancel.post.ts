import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { cancelSendLaterMessage } from '~/server/domain/send-later'
import { messageText } from '~/server/domain/guest-message-schedule'

/** Cancel the caller's own message before it starts sending. */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organizationId'), 'organizationId', 200)
  const messageId = messageText(getRouterParam(event, 'messageId'), 'messageId', 200)
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  return jsonResponse({ message: await cancelSendLaterMessage(db, memberAccessPrincipal(organization.membership, { env, event }), messageId) })
})
