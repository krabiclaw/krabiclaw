import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor, updateStay } from '~/server/domain/stays'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const body = await readRequiredBody<Record<string, unknown>>(event)
  return jsonResponse({ stay: await updateStay(db, access, getRouterParam(event, 'stayId') ?? '', { ...body, expected_version: body.expected_version }) })
})
