import { HTTPError } from 'nitro'
import { createCustomDomainPair, deleteCustomDomain, inspectDomainResolution, syncDomainWithCloudflare, validateCustomDomain, type DomainRecord } from '~/server/utils/domains'
import { buildDashboardUrl } from '~/server/utils/dashboard-links'
import { domainPair, rootDomainForPair } from '~/server/utils/domain-shared'
import { notifyDomainLifecycle } from '~/server/utils/domain-notifications'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { queryAll, queryFirst } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { publishEvent, type DomainEvent } from '~/server/events'

type DomainActor = { organizationId: string; organizationSlug: string; actorId: string; actorType: 'owner' | 'admin' }

type DomainCheck = Extract<DomainEvent, { type: 'domain.check_requested' }>

async function requestDomainCheck(env: CloudflareEnv, organizationId: string, domains: Array<Pick<DomainRecord, 'id' | 'cloudflare_hostname_id'>>, actor?: DomainActor) {
  await publishEvent(env, {
    type: 'domain.check_requested', organization_id: organizationId,
    domains: domains.map(domain => ({ id: domain.id, cloudflare_hostname_id: domain.cloudflare_hostname_id ?? null })),
    ...(actor && { actor: { id: actor.actorId, type: actor.actorType, organization_slug: actor.organizationSlug } }),
  })
}

export async function reconcileRequestedDomains(env: CloudflareEnv, event: DomainCheck, retry: boolean): Promise<void> {
  const db = env.DB
  const dashboardUrl = event.actor && buildDashboardUrl({ env, organizationId: event.organization_id, organizationSlug: event.actor.organization_slug }, 'organization.domains')
  for (const check of event.domains) {
    const domain = await queryFirst<DomainRecord>(db, `
      SELECT * FROM organization_domains WHERE id = ? AND organization_id = ? AND cloudflare_hostname_id IS ?
        AND type = 'custom' AND desired_state = 'active' AND status NOT IN ('disabled', 'deleted')
    `, [check.id, event.organization_id, check.cloudflare_hostname_id])
    if (!domain) continue
    const synced = await syncDomainWithCloudflare(env, db, domain, event.actor?.type, event.actor?.id, retry)
    if (dashboardUrl) await notifyDomainLifecycle(env, db, { organizationId: event.organization_id, event: 'synced', domain: synced, dashboardUrl })
  }
}

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
    organizationId, domain: requestedDomain, includeWww, actorId, actorType, resolutions,
  })
  await requestDomainCheck(env, organizationId, domains)
  const dashboardUrl = buildDashboardUrl({ env, organizationId, organizationSlug }, 'organization.domains')
  for (const domain of domains) {
    await notifyDomainLifecycle(env, db, { organizationId, event: 'added', domain, dashboardUrl })
  }
  return domains
}

export async function changeDashboardDomain(env: CloudflareEnv, db: D1Database, actor: DomainActor, domain: DomainRecord, action: 'deleted') {
  const { organizationId, organizationSlug, actorId, actorType } = actor
  if (domain.organization_id !== organizationId || domain.type !== 'custom') throw new HTTPError({ statusCode: 404, message: 'Custom domain not found' })
  const dashboardUrl = buildDashboardUrl({ env, organizationId, organizationSlug }, 'organization.domains')
  await deleteCustomDomain(env, db, domain.id, actorType, actorId)
  await notifyDomainLifecycle(env, db, { organizationId, event: action, domain, dashboardUrl })
  return domain
}

export async function checkDashboardDomainGroup(env: CloudflareEnv, db: D1Database, actor: DomainActor, domain: DomainRecord) {
  if (domain.organization_id !== actor.organizationId || domain.type !== 'custom') throw new HTTPError({ statusCode: 404, message: 'Custom domain not found' })
  const root = rootDomainForPair(domain.domain)
  const targets = await queryAll<Pick<DomainRecord, 'id' | 'cloudflare_hostname_id'>>(db, `
    SELECT id, cloudflare_hostname_id FROM organization_domains WHERE organization_id = ? AND domain IN (?, ?)
      AND type = 'custom' AND desired_state = 'active' AND status NOT IN ('disabled', 'deleted')
    ORDER BY role ASC, id
  `, [actor.organizationId, root, `www.${root}`])
  if (!targets.some(item => item.id === domain.id)) throw new HTTPError({ statusCode: 409, message: 'This domain can no longer be checked.' })
  await requestDomainCheck(env, actor.organizationId, targets, actor)
}
