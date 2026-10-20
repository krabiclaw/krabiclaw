import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import {
  createCustomDomainPair, inspectDomainResolution, validateCustomDomain
} from '~/server/utils/domains'
import { canonicalDomainForPair, domainPair } from '~/server/utils/domain-shared'
import { domainInstructions, groupCustomDomains } from '~/server/utils/domain-read-model'
import { notifyDomainLifecycle } from '~/server/utils/domain-notifications'
import { buildDashboardUrl } from '~/server/utils/dashboard-links'

interface CreateDomainBody {
  domain?: string
  include_www?: boolean
  acknowledge_live_cutover?: boolean
}

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const body = await readBody<CreateDomainBody>(event)
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  const requestedDomain = typeof body.domain === 'string' ? body.domain.trim() : ''
  const includeWww = body.include_www !== false
  if (!requestedDomain) return jsonResponse({ error: 'Domain is required' }, { status: 400 })

  const { env, db, session, organization } = await requireOrganizationAccess(event, organizationId)
  const actorType = organization.member_role as 'owner' | 'admin'


  if (!(await hasOrganizationEntitlement(env, organizationId, 'custom_domains'))) {
    return jsonResponse({ error: 'Custom domains require a paid plan.' }, { status: 403 })
  }

  const validation = validateCustomDomain(env, requestedDomain)
  if (!validation.valid) return jsonResponse({ error: validation.reason }, { status: 400 })

  const canonicalHostname = canonicalDomainForPair(requestedDomain, includeWww)
  let liveResolution
  try {
    liveResolution = await inspectDomainResolution(env, canonicalHostname)
  } catch (error) {
    return jsonResponse({ error: `Could not check where ${canonicalHostname} points: ${error instanceof Error ? error.message : String(error)}` }, { status: 502 })
  }
  if (liveResolution.resolves_elsewhere && body.acknowledge_live_cutover !== true) {
    return jsonResponse({
      error: 'This domain currently points somewhere else.', live_cutover_warning: {
        hostname: liveResolution.hostname, records: liveResolution.records, message: 'This domain currently points elsewhere and may be live. Changing DNS now can take it offline until KrabiClaw validation finishes.', }, }, { status: 409 })
  }

  try {
    const domains = await createCustomDomainPair(env, db, {
      organizationId, domain: requestedDomain, includeWww, actorId: session.user.id, actorType
    })

    const dashboardUrl = buildDashboardUrl({
      env, organizationId: organization.id, organizationSlug: organization.slug }, 'organization.domains')
    for (const domain of domains) {
      await notifyDomainLifecycle(env, db, {
        organizationId: organization.id, domain: domain.domain, status: domain.status, title: `Domain added: ${domain.domain}`, message: `DNS configuration is required for ${domain.domain}. Follow the dashboard instructions to complete setup.`, dashboardUrl
      })
    }

    return jsonResponse({
      success: true, domains: domains.map((domain) => ({ ...domain, instructions: domainInstructions(domain) })), domain_groups: groupCustomDomains(domains), requested_hostnames: domainPair(requestedDomain, includeWww)
    })
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error('Unknown error')
    console.error('domains_create_failed', {
      organizationId, userId: session.user.id, requestedDomain, error: normalizedError.message, stack: normalizedError.stack || null
    })
    return jsonResponse({ error: 'Failed to add domain' }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
