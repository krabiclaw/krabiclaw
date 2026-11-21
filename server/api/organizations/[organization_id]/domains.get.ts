import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { prepareOrganizationPlan } from '~/server/utils/billing-access'
import { organizationDomainsDashboardPayload, prepareOrganizationDomains } from '~/server/utils/domain-read-model'

export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'Organization ID is required' })
  const domains = prepareOrganizationDomains({ sql: BATCH_VIEWER.organization })
  const plan = prepareOrganizationPlan({ sql: BATCH_VIEWER.organization })
  const { db, env, organization, rows } = await readDashboardMemberResources(event, organizationId, [...domains.queries, plan.query])
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  return jsonResponse(await organizationDomainsDashboardPayload(domains.read(rows), organization, env, plan.read(rows.at(-1)!, organization.id)))
})
