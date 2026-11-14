import { jsonResponse } from '~/server/utils/api-response'
import { GROWTH_PLAN_ID } from '~/shared/billing-model'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'
import { roleAllows } from '~/server/utils/member-access'
import { getOrganizationDomainsDashboardPayload } from '~/server/utils/domain-read-model'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })

  const { db, env, organization } = await requireOrganizationAccess(event, organizationId)
  const [payload, canConnect, canUpdateBilling] = await Promise.all([
    getOrganizationDomainsDashboardPayload(db, organizationId),
    hasOrganizationEntitlement(env, organizationId, 'custom_domains'),
    roleAllows({ organizationId, role: organization.member_role, permissions: { billing: ['update'] } }),
  ])
  const action = canConnect
    ? { label: 'Connect domain', to: null }
    : canUpdateBilling
      ? { label: 'View plans', to: `/dashboard/${encodeURIComponent(organization.slug)}/billing/upgrade?plan=${GROWTH_PLAN_ID}` }
      : null

  const includedDomain = payload.domains.find(domain => domain.type === 'subdomain')
  const url = includedDomain && tenantOrganizationOrigin({
    platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
    freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
    subdomain: organization.subdomain ?? '',
    canonicalDomain: includedDomain.domain,
  })
  const included_address = url ? {
    host: new URL(url).host,
    url: organization.status === 'active' ? url : null,
    status: organization.status === 'active' ? 'Live' : organization.status === 'suspended' ? 'Suspended' : 'Private',
  } : null

  return jsonResponse({
    success: true, ...payload, organization_id: organizationId, included_address, action,
    empty_title: canConnect ? 'No custom domains' : 'Custom domains are included with Growth',
  })
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
