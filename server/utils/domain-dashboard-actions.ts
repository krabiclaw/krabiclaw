import { HTTPError } from 'nitro'
import { createCustomDomainPair, deleteCustomDomain, inspectDomainResolution, syncDomainWithCloudflare, validateCustomDomain, type DomainRecord } from '~/server/utils/domains'
import { buildDashboardUrl } from '~/server/utils/dashboard-links'
import { canonicalDomainForPair } from '~/server/utils/domain-shared'
import { notifyDomainLifecycle } from '~/server/utils/domain-notifications'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import type { CloudflareEnv } from '~/server/utils/auth'

type DomainActor = { organizationId: string; organizationSlug: string; actorId: string; actorType: 'owner' | 'admin' }

export async function connectDashboardDomain(
  env: CloudflareEnv, db: D1Database, actor: DomainActor,
  requestedDomain: string, includeWww: boolean, acknowledgeCutover: boolean,
) {
  const { organizationId, organizationSlug, actorId, actorType } = actor
  if (!(await hasOrganizationEntitlement(env, organizationId, 'custom_domains'))) {
    throw new HTTPError({ statusCode: 403, message: 'Custom domains require a paid plan.' })
  }

  const validation = validateCustomDomain(env, requestedDomain)
  if (!validation.valid) throw new HTTPError({ statusCode: 400, message: validation.reason })

  const canonicalHostname = canonicalDomainForPair(requestedDomain, includeWww)
  let liveResolution
  try {
    liveResolution = await inspectDomainResolution(env, canonicalHostname)
  } catch (error) {
    throw new HTTPError({ statusCode: 502, message: `Could not check where ${canonicalHostname} points: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (liveResolution.resolves_elsewhere && acknowledgeCutover !== true) {
    throw new HTTPError({ statusCode: 409, message: 'This domain currently points somewhere else.', data: {
      live_cutover_warning: { hostname: liveResolution.hostname, records: liveResolution.records,
        message: 'This domain currently points elsewhere and may be live. Changing DNS now can take it offline until KrabiClaw validation finishes.' },
    } })
  }

  const domains = await createCustomDomainPair(env, db, {
    organizationId, domain: requestedDomain, includeWww, actorId, actorType,
  })
  const dashboardUrl = buildDashboardUrl({ env, organizationId, organizationSlug }, 'organization.domains')
  for (const domain of domains) {
    await notifyDomainLifecycle(env, db, { organizationId, event: 'added', domain, dashboardUrl })
  }
  return domains
}

export async function changeDashboardDomain(env: CloudflareEnv, db: D1Database, actor: DomainActor, domain: DomainRecord, action: 'synced' | 'deleted') {
  const { organizationId, organizationSlug, actorId, actorType } = actor
  if (domain.organization_id !== organizationId || domain.type !== 'custom') throw new HTTPError({ statusCode: 404, message: 'Custom domain not found' })
  const dashboardUrl = buildDashboardUrl({ env, organizationId, organizationSlug }, 'organization.domains')
  if (action === 'synced') {
    const synced = await syncDomainWithCloudflare(env, db, domain.id, actorType, actorId, undefined, { forceRevalidation: true })
    await notifyDomainLifecycle(env, db, { organizationId, event: action, domain: synced, dashboardUrl })
    return synced
  }
  await deleteCustomDomain(env, db, domain.id, actorType, actorId)
  await notifyDomainLifecycle(env, db, { organizationId, event: action, domain, dashboardUrl })
  return domain
}
