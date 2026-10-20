// Direct dashboard settings handler.
// Avoids the generic dashboard proxy hop for this request path.
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { loadSettingsPayload } from '~/server/utils/organization-settings'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardContext(event)
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))

  const settings = await loadSettingsPayload(db, env, organization.id)

  return jsonResponse({
    success: true, settings
  })
})
import { defineHandler } from 'nitro';
