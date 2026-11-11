import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { getStay, stayAccessFor } from '~/server/domain/stays'
import { guestReplyDestination } from '~/server/domain/guest-threads/operations'
import { getGuestRequest } from '~/server/domain/requests'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const stayId = getRouterParam(event, 'stayId') ?? ''
  if (!access.manage) return jsonResponse({ stay: await getStay(db, access, stayId), manage: false })
  const stay = await getStay(db, access, stayId)
  const conversation = await getGuestRequest(db, stay.conversation_id, organization.id, 'booking')
  if (!conversation) throw new Error('The stay has no guest conversation')
  const destination = await guestReplyDestination(db, conversation)
  return jsonResponse({ stay, manage: true, can_message_guest: destination.channel !== null && !conversation.blocked_at })
})
