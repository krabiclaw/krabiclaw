import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { listSendLaterMessages } from '~/server/domain/send-later'
import { messageText } from '~/server/domain/guest-message-schedule'

/** The caller's own send-later messages, optionally for one conversation (?threadId). */
export default defineHandler(async (event) => {
  const organizationId = messageText(getRouterParam(event, 'organizationId'), 'organizationId', 200)
  const { threadId } = getQuery(event)
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const messages = await listSendLaterMessages(db, memberAccessPrincipal(organization.membership, { env, event }),
    threadId === undefined ? null : messageText(threadId, 'threadId', 200))
  return jsonResponse({ messages })
})
