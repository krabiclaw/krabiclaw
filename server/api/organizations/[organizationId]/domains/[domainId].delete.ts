import { jsonResponse } from '~/server/utils/api-response'
import { queryFirst } from '~/server/db'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { deleteCustomDomain } from '~/server/utils/domains'
import { notifyDomainLifecycle } from '~/server/utils/domain-notifications'
import { buildDashboardUrl } from '~/server/utils/dashboard-links'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const domainId = getRouterParam(event, 'domainId')
  if (!organizationId || !domainId) return jsonResponse({ error: 'Organization ID and domain ID are required' }, { status: 400 })

  const { env, db, session, organization } = await requireOrganizationAccess(event, organizationId)

  const domain = await queryFirst<{ id: string; domain: string }>(db, `
    SELECT *
    FROM organization_domains
    WHERE id = ? AND organization_id = ? AND type = 'custom'
    LIMIT 1
  `, [domainId, organizationId])
  if (!domain) return jsonResponse({ error: 'Domain not found' }, { status: 404 })

  try {
    await deleteCustomDomain(env, db, domainId, organization.member_role as 'owner' | 'admin', session.user.id)
    await notifyDomainLifecycle(env, db, {
      organizationId: organization.id, domain: domain.domain, status: 'deleted', title: `Domain deleted: ${domain.domain}`, message: `${domain.domain} has been removed from KrabiClaw.`, dashboardUrl: buildDashboardUrl({
        env, organizationId: organization.id, organizationSlug: organization.slug }, 'organization.domains')
    })
    return jsonResponse({ success: true })
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error('Failed to delete domain')
    return jsonResponse({ error: normalizedError.message || 'Failed to delete domain' }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
