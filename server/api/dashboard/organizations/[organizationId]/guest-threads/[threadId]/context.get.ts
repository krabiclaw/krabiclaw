import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { guestThreadMessagingContext } from '~/server/domain/guest-messaging'
import { messageText } from '~/server/domain/guest-message-schedule'

export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organizationId'), 'organizationId', 200)
  const requestId = messageText(getRouterParam(event, 'threadId'), 'requestId', 200)
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  return jsonResponse(await guestThreadMessagingContext(db, memberAccessPrincipal(organization.membership, { env, event }), requestId))
})
