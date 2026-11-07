import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { getStay, stayAccessFor } from '~/server/domain/stays'
import { buildNotificationVisibilityFilter } from '~/server/utils/notification-access'
import { unreadScheduleNotificationIds } from '~/server/utils/notification-acknowledgement'

export default defineHandler(async (event) => {
  const { env, db, organization, userId } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const stayId = getRouterParam(event, 'stayId') ?? ''
  const visibility = buildNotificationVisibilityFilter({ userId, organization, platformAdmin: false })
  const unreadNotificationIds = await unreadScheduleNotificationIds(db, { userId, ...visibility }, 'stay', stayId)
  return jsonResponse({ stay: await getStay(db, access, stayId), manage: access.manage, unreadNotificationIds })
})
