// Direct dashboard settings handler.
// Avoids the generic dashboard proxy hop for this request path.
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { loadConnectionSummary, loadSettingsPayload } from '~/server/utils/organization-settings'

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardContext(event)
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))

  if (getQuery(event).connections === '1') {
    const integrations = await loadConnectionSummary(db, env, organization.id)
    const connections = await connectionRows({ db, env, organization }, integrations)
    return jsonResponse({ success: true, settings: { integrations }, connectionFilters, connectionGroups, connections })
  }
  return jsonResponse({ success: true, settings: await loadSettingsPayload(db, env, organization.id) })
})
import { getQuery } from 'nitro/h3'
import { connectionFilters, connectionGroups, connectionRows } from '~/server/utils/dashboard-connections'
import { defineHandler } from 'nitro';
