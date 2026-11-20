import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { prepareOrganizationLanguageSettings } from '~/server/utils/organization-languages'

export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'Organization ID required' })
  const plan = prepareOrganizationLanguageSettings({ sql: BATCH_VIEWER.organization }, getQuery(event).view === 'progress')
  const { db, env, organization, rows } = await readDashboardMemberResources(event, organizationId, plan.queries)
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  return plan.read(rows, organization.id, organization.slug)
})
