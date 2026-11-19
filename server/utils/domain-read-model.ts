import { GROWTH_PLAN_ID } from '~/shared/billing-model'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import { roleAllows } from '~/server/utils/member-access'
import { queryAll, type BatchQuery } from '~/server/db'
import { rootDomainForPair } from '~/server/utils/domain-shared'
import type { DomainRecord, DomainRole, DomainStatus } from '~/server/utils/domains'

function organizationDomainsQuery(organizationId: string | { sql: string }): BatchQuery {
  return { query: `SELECT * FROM organization_domains
    WHERE organization_id = ${typeof organizationId === 'string' ? '?' : organizationId.sql} AND status != 'deleted'
    ORDER BY type ASC, role ASC, created_at ASC`, params: typeof organizationId === 'string' ? [organizationId] : [] }
}

export async function getOrganizationDomains(db: D1Database, organizationId: string): Promise<DomainRecord[]> {
  const query = organizationDomainsQuery(organizationId)
  return await queryAll<DomainRecord>(db, query.query, query.params)
}

export interface DomainDnsRecord {
  type: string
  name: string
  value: string
  purpose: 'ownership' | 'dcv_delegation' | 'traffic' | 'ssl'
}

export interface DomainInstructions {
  dns: DomainDnsRecord | null
  ssl: DomainDnsRecord | null
  ssl_records: DomainDnsRecord[]
  dcv_delegation: DomainDnsRecord | null
  ownership: DomainDnsRecord | null
  records: DomainDnsRecord[]
  apex_note: string | null
  registrar_guides: Record<string, string>
}

export function domainInstructions(domain: DomainRecord) {
  if (domain.type === 'subdomain') {
    return {
      dns: null,
      ssl: null,
      ssl_records: [],
      dcv_delegation: null,
      ownership: null,
      records: [],
      apex_note: null,
      registrar_guides: {}
    } satisfies DomainInstructions
  }

  const root = rootDomainForPair(domain.domain)
  const isApex = domain.domain === root
  const target = domain.dns_target || ''
  const dns = isApex
    ? null
    : { type: 'CNAME', name: domain.domain.replace(`.${root}`, '') || 'www', value: target, purpose: 'traffic' as const }
  const ownership = domain.ownership_validation_name && domain.ownership_validation_value
    ? {
        type: domain.ownership_validation_type || 'TXT',
        name: domain.ownership_validation_name,
        value: domain.ownership_validation_value,
        purpose: 'ownership' as const,
      }
    : null
  const dcvDelegation = domain.validation_strategy === 'delegated_dcv' && domain.dcv_delegation_name && domain.dcv_delegation_value
    ? {
        type: domain.dcv_delegation_type || 'CNAME',
        name: domain.dcv_delegation_name,
        value: domain.dcv_delegation_value,
        purpose: 'dcv_delegation' as const,
      }
    : null
  const sslRecords: DomainDnsRecord[] = []
  if (domain.ssl_validation_name && domain.ssl_validation_value) {
    sslRecords.push({
      type: domain.ssl_validation_type || 'TXT',
      name: domain.ssl_validation_name,
      value: domain.ssl_validation_value,
      purpose: 'ssl',
    })
  }
  if (domain.ssl_validation_name_2 && domain.ssl_validation_value_2) {
    sslRecords.push({
      type: domain.ssl_validation_type_2 || 'TXT',
      name: domain.ssl_validation_name_2,
      value: domain.ssl_validation_value_2,
      purpose: 'ssl',
    })
  }
  const records = [ownership, dcvDelegation, dns, ...sslRecords]
    .filter((record): record is DomainDnsRecord => Boolean(record))

  return {
    dns,
    ssl: sslRecords[0] ?? null,
    ssl_records: sslRecords,
    dcv_delegation: dcvDelegation,
    ownership,
    records,
    apex_note: isApex ? `Forward ${root} to https://www.${root}` : null,
    registrar_guides: {}
  } satisfies DomainInstructions
}

function groupedStatus(records: DomainRecord[]): DomainStatus {
  const statuses = records.map((record) => record.status)
  for (const status of ['failed', 'blocked', 'verifying', 'pending'] as const) {
    if (statuses.includes(status)) return status
  }
  return statuses.every((status) => status === 'active') ? 'active' : 'pending'
}

export function domainStatusLabel(status: DomainStatus) {
  return {
    active: 'Active', pending: 'DNS required', verifying: 'Checking', failed: 'Failed',
    blocked: 'Blocked', disabled: 'Disabled', deleted: 'Deleted',
  }[status]
}

function newestDate(values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .map((value) => value ? Date.parse(value) : NaN)
    .filter((value) => Number.isFinite(value))
  if (!timestamps.length) return null
  return new Date(Math.max(...timestamps)).toISOString()
}

export interface DomainGroup {
  id: string
  domain: string
  root_domain: string
  role: DomainRole
  status: DomainStatus
  status_label: string
  primary_domain_id: string | null
  apex_domain_id: string | null
  www_domain_id: string | null
  domains: DomainRecord[]
  records: DomainDnsRecord[]
  warning: string | null
  error: string | null
  last_synced_at: string | null
}

export function groupCustomDomains(domains: DomainRecord[]): DomainGroup[] {
  const byRoot = new Map<string, DomainRecord[]>()
  for (const domain of domains) {
    if (domain.type !== 'custom') continue
    const root = rootDomainForPair(domain.domain)
    byRoot.set(root, [...(byRoot.get(root) ?? []), domain])
  }

  return Array.from(byRoot.entries()).map(([root, records]) => {
    const apex = records.find((record) => record.domain === root) ?? null
    const www = records.find((record) => record.domain === `www.${root}`) ?? null
    const primary = records.find((record) => record.role === 'canonical')
      ?? records.find((record) => record.status === 'active')
      ?? www
      ?? apex
      ?? records[0]
      ?? null
    const dnsRecords = [...new Map(records.flatMap(domain => domainInstructions(domain).records)
      .map(record => [JSON.stringify([record.type, record.name, record.value]), record])).values()]
    const status = groupedStatus(records)
    return {
      id: root,
      domain: root,
      root_domain: root,
      role: records.some((record) => record.role === 'canonical') ? 'canonical' : 'secondary',
      status,
      status_label: domainStatusLabel(status),
      primary_domain_id: primary?.id ?? null,
      apex_domain_id: apex?.id ?? null,
      www_domain_id: www?.id ?? null,
      domains: records,
      records: dnsRecords,
      warning: null,
      error: records.find(record => record.error_message)?.error_message ?? null,
      last_synced_at: newestDate(records.map((record) => record.last_synced_at)),
    } satisfies DomainGroup
  }).sort((a, b) => a.domain.localeCompare(b.domain))
}

/** Domain status and each domain's latest events share the authorized screen read. */
export function prepareOrganizationDomains(organizationId: string | { sql: string }) {
  const domains = organizationDomainsQuery(organizationId)
  const events: BatchQuery = {
    query: `WITH domains AS (${domains.query}), events AS (
      SELECT e.id, e.organization_id, e.event_name AS event_type, e.body AS message,
        e.actor_user_id AS actor_id, e.payload_json ->> '$.actorType' AS actor_type,
        d.id AS domain_id, e.payload_json ->> '$.beforeState' AS before_state,
        e.payload_json ->> '$.afterState' AS after_state, e.payload_json ->> '$.metadata' AS metadata, e.created_at,
        row_number() OVER (PARTITION BY d.id ORDER BY e.created_at DESC) AS event_rank
      FROM domains d JOIN activity_entries e ON e.organization_id = d.organization_id
        AND e.payload_json ->> '$.entityType' = 'domain' AND e.payload_json ->> '$.entityId' = d.id
      WHERE d.type = 'custom'
    ) SELECT id, organization_id, event_type, message, actor_id, actor_type, domain_id, before_state, after_state, metadata, created_at FROM events WHERE event_rank <= 100 ORDER BY created_at DESC`, params: domains.params,
  }
  return { queries: [domains, events], read([domainRows, eventRows]: D1Result[]) {
    const domains = domainRows!.results as DomainRecord[]
    const events = eventRows!.results as (Record<string, unknown> & { domain_id: string })[]
    return { domains: domains.map(domain => ({ ...domain, instructions: domainInstructions(domain), events: events.filter(event => event.domain_id === domain.id) })), domain_groups: groupCustomDomains(domains) }
  } }
}

export async function organizationDomainsDashboardPayload(
  payload: ReturnType<ReturnType<typeof prepareOrganizationDomains>['read']>,
  organization: Pick<import('~/server/utils/dashboard-context').DashboardOrganizationRow, 'id' | 'slug' | 'subdomain' | 'status' | 'role'>,
  env: import('~/server/utils/auth').CloudflareEnv,
  plan: string,
) {
  const canConnect = getPlanEntitlements(plan).custom_domains === true
  const canUpdateBilling = await roleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['update'] } })
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

  return {
    success: true, ...payload, organization_id: organization.id, included_address, action,
    empty_title: canConnect ? 'No custom domains' : 'Custom domains are included with Growth',
  }
}
