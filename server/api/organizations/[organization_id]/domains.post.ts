import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { defineHandler, HTTPError } from 'nitro'
import { connectDashboardDomain } from '~/server/utils/domain-dashboard-actions'
import { domainPair } from '~/server/utils/domain-shared'
import { domainInstructions, groupCustomDomains } from '~/server/utils/domain-read-model'

interface CreateDomainBody {
  domain?: string
  include_www?: boolean
  acknowledge_live_cutover?: boolean
}

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const body = await readBody<CreateDomainBody>(event)
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  const requestedDomain = typeof body.domain === 'string' ? body.domain.trim() : ''
  const includeWww = body.include_www !== false
  if (!requestedDomain) return jsonResponse({ error: 'Domain is required' }, { status: 400 })

  const { env, db, session, organization } = await requireOrganizationAccess(event, organizationId)
  const actorType = organization.member_role as 'owner' | 'admin'


  try {
    const domains = await connectDashboardDomain(env, db, {
      organizationId, organizationSlug: organization.slug, actorId: session.user.id, actorType,
    }, requestedDomain, includeWww, body.acknowledge_live_cutover === true)

    return jsonResponse({
      success: true, domains: domains.map((domain) => ({ ...domain, instructions: domainInstructions(domain) })), domain_groups: groupCustomDomains(domains), requested_hostnames: domainPair(requestedDomain, includeWww)
    })
  } catch (error) {
    if (HTTPError.isError(error)) {
      return jsonResponse({ error: error.message, ...(error.data ?? {}) }, { status: error.statusCode })
    }
    const normalizedError = error instanceof Error ? error : new Error('Unknown error')
    console.error('domains_create_failed', {
      organizationId, userId: session.user.id, requestedDomain, error: normalizedError.message, stack: normalizedError.stack || null
    })
    return jsonResponse({ error: 'Failed to add domain' }, { status: 500 })
  }
})
import { getRouterParam, readBody  } from 'nitro/h3';
