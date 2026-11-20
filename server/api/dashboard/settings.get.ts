// Direct dashboard settings handler.
// Avoids the generic dashboard proxy hop for this request path.
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { loadSettingsPayload, prepareWebsiteSettings } from '~/server/utils/organization-settings'
import { executeBatch } from '~/server/db'

export default defineHandler(async (event) => {
  if (getQuery(event).connections === '1') return jsonResponse(await readDashboardConnections(event))
  const { env, db, organization } = await getDashboardContext(event)
  if (getQuery(event).view === 'website') {
    const website = prepareWebsiteSettings(organization.id, env)
    return jsonResponse(website.read(await executeBatch(db, website.queries, { operation: 'Read website workspace' })))
  }
  return jsonResponse({ success: true, settings: await loadSettingsPayload(db, env, organization.id) })
})
import { getQuery } from 'nitro/h3'
import { readDashboardConnections } from '~/server/utils/dashboard-connections'
import { defineHandler } from 'nitro';
