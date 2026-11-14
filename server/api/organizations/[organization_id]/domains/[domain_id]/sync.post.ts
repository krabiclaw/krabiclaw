import { changeDashboardDomain } from '~/server/utils/domain-dashboard-actions'
import { jsonResponse } from '~/server/utils/api-response'
import { queryFirst } from '~/server/db'
import { domainInstructions } from '~/server/utils/domain-read-model'
import { requireOrganizationAccess } from '~/server/utils/location-access'

import type { DomainRecord } from '~/server/utils/domains'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const domainId = getRouterParam(event, 'domain_id')
  if (typeof organizationId !== 'string' || !organizationId.trim() || typeof domainId !== 'string' || !domainId.trim()) {
    return jsonResponse({ error: 'Organization ID and domain ID are required' }, { status: 400 })
  }

  const { env, db, session, organization } = await requireOrganizationAccess(event, organizationId)

  const domainRecord = await queryFirst<DomainRecord>(db, `
    SELECT *
    FROM organization_domains
    WHERE id = ?
    LIMIT 1
  `, [domainId])
  if (!domainRecord || domainRecord.organization_id !== organization.id) {
    return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })
  }

  try {
    const domain = await changeDashboardDomain(env, db, {
      organizationId, organizationSlug: organization.slug, actorId: session.user.id, actorType: organization.member_role as 'owner' | 'admin',
    }, domainRecord, 'synced')
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
