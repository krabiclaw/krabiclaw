import { changeDashboardDomain } from '~/server/utils/domain-dashboard-actions'
import { jsonResponse } from '~/server/utils/api-response'
import { queryFirst } from '~/server/db'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const domainId = getRouterParam(event, 'domain_id')
  if (!organizationId || !domainId) return jsonResponse({ error: 'Organization ID and domain ID are required' }, { status: 400 })

  const { env, db, session, organization } = await requireOrganizationAccess(event, organizationId)

  const domain = await queryFirst<DomainRecord>(db, `
    SELECT *
    FROM organization_domains
    WHERE id = ? AND organization_id = ? AND type = 'custom'
    LIMIT 1
  `, [domainId, organizationId])
  if (!domain) return jsonResponse({ error: 'Domain not found' }, { status: 404 })

  try {
    await changeDashboardDomain(env, db, {
      organizationId, organizationSlug: organization.slug, actorId: session.user.id, actorType: organization.member_role as 'owner' | 'admin',
    }, domain, 'deleted')
    return jsonResponse({ success: true })
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error('Failed to delete domain')
    return jsonResponse({ error: normalizedError.message || 'Failed to delete domain' }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import type { DomainRecord } from '~/server/utils/domains';
import { getRouterParam } from 'nitro/h3';
