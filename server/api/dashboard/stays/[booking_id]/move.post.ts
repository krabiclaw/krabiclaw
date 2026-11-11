import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { moveStay, stayAccessFor } from '~/server/domain/stays'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const body = await readRequiredBody<{ version?: unknown; product_id?: unknown }>(event)
  return jsonResponse({ stay: await moveStay(db, env, access, getRouterParam(event, 'booking_id') ?? '', { version: body.version, product_id: body.product_id }) })
})
