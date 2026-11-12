import { jsonResponse } from '~/server/utils/api-response'
import { queryFirst } from '~/server/db'
import { syncDomainWithCloudflare } from '~/server/utils/domains'
import { domainInstructions } from '~/server/utils/domain-read-model'
import { notifyDomainLifecycle } from '~/server/utils/domain-notifications'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { buildDashboardUrl } from '~/server/utils/dashboard-links'

interface DomainRecordRow {
  id: string
  organization_id: string
}

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const domainId = getRouterParam(event, 'domain_id')
  if (typeof organizationId !== 'string' || !organizationId.trim() || typeof domainId !== 'string' || !domainId.trim()) {
    return jsonResponse({ error: 'Organization ID and domain ID are required' }, { status: 400 })
  }

  const { env, db, session, organization } = await requireOrganizationAccess(event, organizationId)

  const domainRecord = await queryFirst<DomainRecordRow>(db, `
    SELECT id, organization_id
    FROM organization_domains
    WHERE id = ?
    LIMIT 1
  `, [domainId])
  if (!domainRecord || domainRecord.organization_id !== organization.id) {
    return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })
  }

  try {
    const domain = await syncDomainWithCloudflare(env, db, domainId, organization.member_role as 'owner' | 'admin', session.user.id, undefined, { forceRevalidation: true })
    if (domain.organization_id !== organization.id) {
      return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })
    }

    await notifyDomainLifecycle(env, db, {
      organizationId: organization.id, event: 'synced', domain, dashboardUrl: buildDashboardUrl({
        env, organizationId: organization.id, organizationSlug: organization.slug }, 'organization.domains')
    })
    return jsonResponse({ success: true, domain: { ...domain, instructions: domainInstructions(domain) } })
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error('Unknown error')
    console.error('domain_sync_failed', {
      organizationId, domainId, userId: session.user.id, error: normalizedError.message, stack: normalizedError.stack ?? null
    })
    return jsonResponse({ error: `Failed to sync domain: ${normalizedError.message}` }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
