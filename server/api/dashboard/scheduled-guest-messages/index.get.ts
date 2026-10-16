import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { assertAssignedBookingAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { listScheduledGuestMessages } from '~/server/domain/guest-messaging'
import { messagingError, parseMessageListQuery } from '~/server/domain/guest-message-schedule'

export default defineHandler(async (event) => {
  const query = getQuery(event), page = parseMessageListQuery(query, ['request_id'])
  if ('request_id' in query && (typeof query.request_id !== 'string' || !query.request_id.trim())) messagingError(400, 'INVALID_MESSAGING_QUERY', 'request_id must identify a canonical guest conversation', 'request_id')
  const requestId = typeof query.request_id === 'string' ? query.request_id : null
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event }), access = await stayAccessFor(principal)
  if (requestId !== null) await assertAssignedBookingAccess(db, { ...principal, requestId })
  return jsonResponse(await listScheduledGuestMessages(db, access, page, requestId))
})
