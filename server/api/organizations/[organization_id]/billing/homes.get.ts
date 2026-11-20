import { timeRequestPhase } from '~/server/utils/request-metrics'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { homesQuote, prepareHomesQuote, parseHomesAdding } from '~/server/utils/billing'
import { readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'

// What adding homes costs on this organization's plan, before they are added:
// the dashboard's home pages and the iOS import review ask here, and the
// answer is the same rule the write then applies.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const adding = parseHomesAdding(getQuery(event).adding)
  const plan = prepareHomesQuote({ sql: BATCH_VIEWER.organization })
  const { env, db, organization, rows } = await readDashboardMemberResources(event, organizationId, plan.queries)
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  return jsonResponse(await timeRequestPhase(event, 'stripe_quote', () => homesQuote(env, db, organizationId, adding, rows)))
})
