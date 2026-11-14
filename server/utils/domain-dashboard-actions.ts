import { HTTPError } from 'nitro'
import { createCustomDomainPair, deleteCustomDomain, inspectDomainResolution, syncDomainWithCloudflare, validateCustomDomain, type DomainRecord } from '~/server/utils/domains'
import { buildDashboardUrl } from '~/server/utils/dashboard-links'
import { domainPair, rootDomainForPair } from '~/server/utils/domain-shared'
import { notifyDomainLifecycle } from '~/server/utils/domain-notifications'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { getOrganizationDomains, groupCustomDomains } from '~/server/utils/domain-read-model'
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

  const resolutions = await Promise.all(domainPair(requestedDomain, includeWww).map(async hostname => {
    try {
      return await inspectDomainResolution(env, hostname)
    } catch (error) {
      throw new HTTPError({ statusCode: 502, message: `Could not check where ${hostname} points: ${error instanceof Error ? error.message : String(error)}` })
    }
  }))
  const liveResolution = resolutions.find(result => result.records.length > 0 && result.points_to_saas !== true)
  if (liveResolution && acknowledgeCutover !== true) {
    const message = `${liveResolution.hostname} currently points elsewhere and may be live. Changing DNS can take it offline until KrabiClaw validation finishes.`
    throw new HTTPError({ statusCode: 409, message, data: {
      code: 'DOMAIN_LIVE_CUTOVER', live_cutover_warning: { hostname: liveResolution.hostname, records: liveResolution.records,
        message },
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

export async function checkDashboardDomainGroup(env: CloudflareEnv, db: D1Database, actor: DomainActor, domain: DomainRecord) {
  if (domain.organization_id !== actor.organizationId || domain.type !== 'custom') throw new HTTPError({ statusCode: 404, message: 'Custom domain not found' })
  const root = rootDomainForPair(domain.domain)
  const group = groupCustomDomains(await getOrganizationDomains(db, actor.organizationId)).find(item => item.id === root)
  const targets = group?.domains.filter(item => item.desired_state === 'active' && item.status !== 'disabled') ?? []
  if (!targets.some(item => item.id === domain.id)) throw new HTTPError({ statusCode: 409, message: 'This domain can no longer be checked.' })
  let result = domain
  for (const target of targets) {
    const checked = await changeDashboardDomain(env, db, actor, target, 'synced')
    if (target.id === domain.id) result = checked
  }
  return result
}
