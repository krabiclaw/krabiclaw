import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { cancelScheduledGuestMessage } from '~/server/domain/guest-messaging'
import { messageText } from '~/server/domain/guest-message-schedule'

export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  return jsonResponse({ message: await cancelScheduledGuestMessage(db, access, messageText(getRouterParam(event, 'messageId'), 'messageId', 200)) })
})
