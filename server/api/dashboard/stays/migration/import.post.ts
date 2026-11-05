import { defineHandler } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { organizationEventContext } from '~/server/utils/organization-events'
import { stayAccessFor } from '~/server/domain/stays'
import { importStayMigration } from '~/server/domain/stay-migration'

export default defineHandler(async (event) => {
  const { db, env, organization, session } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  access.audit = organizationEventContext(event, 'dashboard', session.user.id, session.session)
  const receipt = await importStayMigration(db, env, access, await readRequiredBody(event))
  return jsonResponse(receipt)
})
