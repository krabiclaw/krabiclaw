import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { createSendLaterMessage } from '~/server/domain/send-later'
import { messageText } from '~/server/domain/guest-message-schedule'

/** Schedule the caller's own reply in this conversation: { body, sendAt }. */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organizationId'), 'organizationId', 200)
  const threadId = messageText(getRouterParam(event, 'threadId'), 'threadId', 200)
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const body = await readBody<{ body?: unknown; sendAt?: unknown } | null>(event)
  const message = await createSendLaterMessage(db, memberAccessPrincipal(organization.membership, { env, event }), threadId, { body: body?.body, sendAt: body?.sendAt })
  return jsonResponse({ message }, { status: 201 })
})
