import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { updateSendLaterMessage } from '~/server/domain/send-later'
import { messageText } from '~/server/domain/guest-message-schedule'

/** Change the caller's own pending message: { body, sendAt, expectedVersion }. */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organizationId'), 'organizationId', 200)
  const messageId = messageText(getRouterParam(event, 'messageId'), 'messageId', 200)
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const body = await readBody<{ body?: unknown; sendAt?: unknown; expectedVersion?: unknown } | null>(event)
  const message = await updateSendLaterMessage(db, memberAccessPrincipal(organization.membership, { env, event }), messageId,
    { body: body?.body, sendAt: body?.sendAt, expectedVersion: body?.expectedVersion })
  return jsonResponse({ message })
})
