import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { setStayNights, stayAccessFor } from '~/server/domain/stays'
import { organizationEventContext } from '~/server/utils/organization-events'

export default defineHandler(async (event) => {
  const { env, db, organization, session } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  access.audit = organizationEventContext(event, 'dashboard', session.user.id, session.session)
  const body = await readRequiredBody<Record<string, unknown>>(event)
  return jsonResponse(await setStayNights(db, env, access, { ...body, product_id: getRouterParam(event, 'product_id') ?? '', from: body.from, to: body.to }))
})
