import { defineHandler } from 'nitro'
import { nightBooking } from '~/server/utils/dashboard-bookings'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { recordStayPayment, stayAccessFor } from '~/server/domain/stays'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const { stay } = await recordStayPayment(db, env, access, getRouterParam(event, 'booking_id') ?? '', await readRequiredBody<Record<string, unknown>>(event))
  return jsonResponse({ booking: nightBooking(stay) }, { status: 201 })
})
