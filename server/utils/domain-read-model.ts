import { queryAll } from '~/server/db'
import { rootDomainForPair } from '~/server/utils/domain-shared'
import type { DomainRecord, DomainRole, DomainStatus } from '~/server/utils/domains'

export async function getOrganizationDomains(db: D1Database, organizationId: string): Promise<DomainRecord[]> {
  const domains = await queryAll<DomainRecord>(db, `
    SELECT *
    FROM organization_domains
    WHERE organization_id = ? AND status != 'deleted'
    ORDER BY type ASC, role ASC, created_at ASC
  `, [organizationId])

  return domains || []
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

export async function getDomainEvents(db: D1Database, domainId: string) {
  const events = await queryAll(db, `
    SELECT id, organization_id, event_name AS event_type, body AS message,
           actor_user_id AS actor_id, payload_json ->> '$.actorType' AS actor_type,
           payload_json ->> '$.entityId' AS domain_id,
           payload_json ->> '$.beforeState' AS before_state,
           payload_json ->> '$.afterState' AS after_state,
           payload_json ->> '$.metadata' AS metadata, created_at
    FROM activity_entries
    WHERE payload_json ->> '$.entityType' = 'domain' AND payload_json ->> '$.entityId' = ?
    ORDER BY created_at DESC
    LIMIT 100
  `, [domainId])

  return events || []
}

export async function getOrganizationDomainsDashboardPayload(db: D1Database, organizationId: string) {
  const domains = await getOrganizationDomains(db, organizationId)
  const enriched = []
  for (const domain of domains) {
    enriched.push({
      ...domain,
      instructions: domainInstructions(domain),
      events: domain.type === 'custom' ? await getDomainEvents(db, domain.id) : [],
    })
  }

  return {
    domains: enriched,
    domain_groups: groupCustomDomains(domains),
  }
}
