import { defineHandler } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { saveMessageTemplate } from '~/server/domain/guest-messaging'

export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  return jsonResponse({ template: await saveMessageTemplate(db, access, null, await readRequiredBody(event)) }, { status: 201 })
})
