import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { setStayNights, stayAccessFor } from '~/server/domain/stays'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const body = await readRequiredBody<Record<string, unknown>>(event)
  return jsonResponse(await setStayNights(db, access, { ...body, product_id: getRouterParam(event, 'productId') ?? '', from: body.from, to: body.to }))
})
