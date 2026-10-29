import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { suggestGuestReply } from '~/server/domain/suggested-reply'
import { messageText } from '~/server/domain/guest-message-schedule'

/** A draft reply to the guest's latest message; nothing is sent or stored. */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organizationId'), 'organizationId', 200)
  const threadId = messageText(getRouterParam(event, 'threadId'), 'threadId', 200)
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  return jsonResponse({ suggestion: await suggestGuestReply(db, env as unknown as Record<string, unknown>, memberAccessPrincipal(organization.membership, { env, event }), threadId) })
})
