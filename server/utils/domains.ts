import { instantDate } from '~/utils/timezone'
// Cloudflare for SaaS custom domain management.

import { execute, executeBatch, queryAll, queryFirst, type BatchQuery } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { canonicalDomainForPair, domainPair, normalizeDomain } from '~/server/utils/domain-shared'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'

export interface DomainEnv {
  CF_ZONE_ID?: string
  CF_CUSTOM_HOSTNAMES_API_TOKEN?: string
  CLOUDFLARE_API_TOKEN?: string
  CF_SAAS_CNAME_TARGET?: string
  CF_ACCOUNT_ID?: string
  NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN?: string
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
}

export type DomainStatus = 'pending' | 'verifying' | 'active' | 'blocked' | 'failed' | 'disabled' | 'deleted'
export type DomainRole = 'canonical' | 'secondary'

export interface DomainRecord {
  id: string
  organization_id: string
  domain: string
  type: 'subdomain' | 'custom'
  role: DomainRole
  status: DomainStatus
  cloudflare_hostname_id?: string | null
  cloudflare_hostname_status?: string | null
  cloudflare_ssl_status?: string | null
  ownership_validation_name?: string | null
  ownership_validation_type?: string | null
  ownership_validation_value?: string | null
  ssl_validation_name?: string | null
  ssl_validation_type?: string | null
  ssl_validation_value?: string | null
  ssl_validation_name_2?: string | null
  ssl_validation_type_2?: string | null
  ssl_validation_value_2?: string | null
  validation_strategy?: 'http_auto' | 'txt_manual' | 'delegated_dcv'
  dcv_delegation_name?: string | null
  dcv_delegation_type?: string | null
  dcv_delegation_value?: string | null
  dns_target?: string | null
  dns_status?: 'pending' | 'valid' | 'invalid' | 'unknown'
  dns_last_resolved_at?: string | null
  dns_resolved_target?: string | null
  last_synced_at?: string | null
  next_check_at?: string | null
  retry_count?: number
  reconciliation_token?: string | null
  reconciliation_expires_at?: string | null
  desired_state: 'active' | 'deleted'
  activated_at?: string | null
  certificate_last_active_at?: string | null
  renewal_issue_started_at?: string | null
  renewal_notification_sent_at?: string | null
  certificate_expires_at?: string | null
  error_message?: string | null
  metadata?: string | null
  created_at: string
  updated_at: string
}

interface CloudflareCustomHostname {
  id: string
  hostname: string
  status?: string
  ownership_verification?: {
    name?: string
    type?: string
    value?: string
  }
  ownership_verification_http?: {
    http_url?: string
    http_body?: string
  }
  ssl?: {
    id?: string
    status?: string
    validation_records?: Array<{
      txt_name?: string
      txt_value?: string
      http_url?: string
      http_body?: string
      name?: string
      type?: string
      value?: string
    }>
    // DCV delegation CNAMEs (*.dcv.cloudflare.com) must NOT be used for SSL validation — they time out.
    // This field mirrors the upstream API shape only and must not be consumed or wired into client instructions.
    dcv_delegation_records?: Array<{
      cname?: string
      cname_target?: string
    }>
    expires_on?: string
  }
  verification_errors?: string[]
  created_at?: string
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'
const MAX_RETRY_COUNT = 12
const STUCK_AFTER_MS = 48 * 60 * 60 * 1000

const reservedDomains = [
  'app', 'api', 'admin', 'dashboard', 'login', 'signup',
  'pricing', 'billing', 'support', 'help', 'docs', 'blog', 'posts',
  'qa', 'legal', 'terms', 'privacy', 'static', 'assets', 'cdn',
  'mail', 'status', 'staging', 'dev', 'test', 'beta', 'demo',
  'ns1', 'ns2', 'mx', 'txt', 'cname', 'a', 'aaaa'
]

export function platformHostname(env: DomainEnv): string {
  const domain = env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN
  if (!domain) throw new Error('NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN is required')
  return domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export function platformDomain(env: DomainEnv): string {
  const domain = env.NUXT_PUBLIC_PLATFORM_DOMAIN
  if (!domain) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN is required')
  return domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function platformDomainCandidates(env: DomainEnv): string[] {
  const values = [
    env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN,
    env.NUXT_PUBLIC_PLATFORM_DOMAIN,
  ]
  const domains = values
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase())
  if (domains.length === 0) throw new Error('NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN or NUXT_PUBLIC_PLATFORM_DOMAIN is required')
  return domains
}

export function validateCustomDomain(env: DomainEnv, domain: string): { valid: boolean; reason?: string } {
  const normalized = normalizeDomain(domain)

  if (!normalized) return { valid: false, reason: 'Domain is required' }
  if (normalized.length < 3 || normalized.length > 253) return { valid: false, reason: 'Domain must be 3-253 characters' }

  const labels = normalized.split('.')
  if (labels.length < 2) return { valid: false, reason: 'Use a full domain such as restaurant.com' }
  if (normalized.includes('..')) return { valid: false, reason: 'Domain cannot contain consecutive dots' }

  const labelRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
  for (const label of labels) {
    if (!labelRegex.test(label)) return { valid: false, reason: 'Invalid domain format' }
  }

  for (const platformDomain of platformDomainCandidates(env)) {
    if (normalized === platformDomain || normalized.endsWith(`.${platformDomain}`)) {
      return { valid: false, reason: 'This domain is reserved for KrabiClaw platform traffic' }
    }
  }

  const firstLabel = labels[0]
  if (firstLabel !== 'www' && reservedDomains.includes(firstLabel || '')) {
    return { valid: false, reason: 'This hostname is reserved' }
  }

  return { valid: true }
}

export async function ensureDomainAvailable(db: D1Database, domains: string[], excludeOrganizationId?: string): Promise<void> {
  const params = excludeOrganizationId ? [d1JsonStringSet(domains), excludeOrganizationId] : [d1JsonStringSet(domains)]
  const exclusion = excludeOrganizationId ? 'AND (organization_id IS NULL OR organization_id != ?)' : ''

  const existing = await queryFirst<{ domain?: string }>(db, `
    SELECT domain
    FROM organization_domains
    WHERE domain IN (SELECT value FROM json_each(?)) AND status != 'deleted' ${exclusion}
    LIMIT 1
  `, params)

  if (existing?.domain) throw new Error(`${existing.domain} is already in use`)
}

export async function isSystemSubdomainSpent(
  env: DomainEnv,
  db: D1Database,
  subdomain: string,
): Promise<boolean> {
  const domain = `${subdomain}.${platformHostname(env)}`
  const spent = await queryFirst<{ domain: string }>(
    db,
    "SELECT domain FROM organization_domains WHERE domain = ? AND status = 'retired' LIMIT 1",
    [domain],
  )
  return Boolean(spent)
}

export async function createSystemSubdomain(
  env: DomainEnv,
  db: D1Database,
  organizationId: string,
  subdomain: string,
  options: {
    organizationUpdate?: { sql: string; values: unknown[] }
    writeGuard?: BatchQuery
  } = {},
): Promise<DomainRecord> {
  const now = new Date().toISOString()
  const domain = `${subdomain}.${platformHostname(env)}`
  const existing = await queryFirst<Pick<DomainRecord, 'id' | 'domain' | 'role' | 'created_at'>>(
    db,
    `SELECT id, domain, role, created_at
       FROM organization_domains
       WHERE organization_id = ? AND type = 'subdomain' AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1`,
    [ organizationId],
  )

  if (existing?.domain === domain) {
    return (await queryFirst<DomainRecord>(db, 'SELECT * FROM organization_domains WHERE id = ?', [existing.id])) as DomainRecord
  }

  if (await isSystemSubdomainSpent(env, db, subdomain)) {
    throw new Error(`${domain} has already been used and cannot be reassigned`)
  }

  const role = existing?.role ?? 'canonical'
  const id = existing
    ? `domain-${organizationId}-subdomain-${subdomain}`
    : `domain-${organizationId}-subdomain`

  const stmts: Array<{ sql: string; values: unknown[] }> = []

  if (existing) {
    stmts.push(
      {
        sql: `UPDATE organization_domains
                SET role = 'secondary', status = 'retired', former_organization_id = organization_id, successor_domain = ?, retired_at = ?,
                    organization_id = NULL, updated_at = ?
              WHERE id = ? AND organization_id = ? AND status = 'active'`,
        values: [domain, now, now, existing.id, organizationId],
      },
    )
  }

  stmts.push(
    {
      sql: `INSERT INTO organization_domains
        (id, organization_id, domain, type, role, status, dns_status, dns_target, activated_at, created_at, updated_at)
        VALUES (?, ?, ?, 'subdomain', ?, 'active', 'valid', ?, ?, ?, ?)`,
      values: [id, organizationId, domain, role, platformHostname(env), now, now, now],
    },
  )


  if (options.organizationUpdate) {
    stmts.push(options.organizationUpdate)
  }

  await executeBatch(db, [...(options.writeGuard ? [options.writeGuard] : []), ...stmts.map(s => ({ query: s.sql, params: s.values }))])

  return (await queryFirst<DomainRecord>(db, `SELECT * FROM organization_domains WHERE id = ?`, [id])) as DomainRecord
}

function requireCloudflareConfig(env: DomainEnv) {
  if (!env.CF_ZONE_ID) throw new Error('CF_ZONE_ID is required')
  if (!env.CF_CUSTOM_HOSTNAMES_API_TOKEN) throw new Error('CF_CUSTOM_HOSTNAMES_API_TOKEN is required')
  if (!env.CF_SAAS_CNAME_TARGET) throw new Error('CF_SAAS_CNAME_TARGET is required')
}

async function cloudflareRequest<T>(
  env: DomainEnv,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<T> {
  requireCloudflareConfig(env)

  const response = await fetch(`${CF_API_BASE}${path}`, {
    ...init,
    signal,
    headers: {
      Authorization: `Bearer ${env.CF_CUSTOM_HOSTNAMES_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  })

  const text = await response.text()
  let body: ApiValue
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new Error(`Cloudflare API HTTP ${response.status} returned non-JSON: ${text.slice(0, 200)}`, { cause: error })
  }
  if (!response.ok || body?.success === false) {
    const message = body?.errors?.map((err: ApiValue) => err.message).filter(Boolean).join('; ') || `Cloudflare API HTTP ${response.status}`
    throw new Error(message)
  }

  return body.result as T
}

export function cloudflareSslSettings(strategy: DomainRecord['validation_strategy'] = 'http_auto') {
  return {
    method: strategy === 'txt_manual' || strategy === 'delegated_dcv' ? 'txt' : 'http',
    type: 'dv',
    bundle_method: 'ubiquitous'
  }
}

async function createCloudflareHostname(
  env: DomainEnv,
  hostname: string,
  signal?: AbortSignal
): Promise<CloudflareCustomHostname> {
  return cloudflareRequest<CloudflareCustomHostname>(env, `/zones/${env.CF_ZONE_ID}/custom_hostnames`, {
    method: 'POST',
    body: JSON.stringify({
      hostname,
      ssl: cloudflareSslSettings()
    })
  }, signal)
}

async function getCloudflareHostname(env: DomainEnv, id: string, signal?: AbortSignal): Promise<CloudflareCustomHostname> {
  return cloudflareRequest<CloudflareCustomHostname>(env, `/zones/${env.CF_ZONE_ID}/custom_hostnames/${id}`, {}, signal)
}

async function patchCloudflareHostname(env: DomainEnv, id: string, signal?: AbortSignal): Promise<CloudflareCustomHostname> {
  return cloudflareRequest<CloudflareCustomHostname>(env, `/zones/${env.CF_ZONE_ID}/custom_hostnames/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ssl: cloudflareSslSettings() })
  }, signal)
}

async function deleteCloudflareHostname(env: DomainEnv, id: string): Promise<void> {
  await cloudflareRequest(env, `/zones/${env.CF_ZONE_ID}/custom_hostnames/${id}`, { method: 'DELETE' })
}

function firstSslValidation(hostname: CloudflareCustomHostname) {
  return hostname.ssl?.validation_records?.[0] || null
}

function secondSslValidation(hostname: CloudflareCustomHostname) {
  return hostname.ssl?.validation_records?.[1] || null
}

export function mapCloudflareStatus(hostnameStatus?: string, sslStatus?: string, dnsStatus: string = 'pending'): DomainStatus {
  if (hostnameStatus === 'active' && sslStatus === 'active' && dnsStatus === 'valid') return 'active'
  if (hostnameStatus === 'blocked') return 'blocked'
  if (hostnameStatus === 'moved') return 'failed'
  if (hostnameStatus === 'deleted') return 'failed'
  if (hostnameStatus === 'pending' || hostnameStatus === 'pending_validation' || sslStatus === 'pending_validation') return 'verifying'
  if (hostnameStatus === 'active' || sslStatus === 'active') return 'verifying'
  return 'pending'
}

function nextCheckAt(retryCount: number, options: { recentDnsChange?: boolean } = {}): string {
  const delayMinutes = options.recentDnsChange
    ? retryCount < 5
      ? 2
      : retryCount < 17
        ? 5
        : 60
    : Math.min(240, Math.max(5, 5 * 2 ** Math.min(retryCount, 6)))
  return new Date(Date.now() + delayMinutes * 60_000).toISOString()
}

async function queueReconciliation(db: D1Database, domainId: string, runAfter?: string) {
  await execute(db, `
    UPDATE organization_domains SET next_check_at = ?, reconciliation_token = NULL, reconciliation_expires_at = NULL,
      updated_at = ? WHERE id = ? AND status NOT IN ('deleted', 'retired', 'disabled')
  `, [runAfter ?? new Date().toISOString(), new Date().toISOString(), domainId])
}

function normalizeDnsValue(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '')
}


const DNS_RECORD_TYPES = { A: 1, CNAME: 5, AAAA: 28 } as const

async function queryDnsJson(hostname: string, type: 'CNAME' | 'A' | 'AAAA', signal?: AbortSignal): Promise<string[]> {
  const url = new URL('https://cloudflare-dns.com/dns-query')
  url.searchParams.set('name', hostname)
  url.searchParams.set('type', type)

  const response = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal,
  })
  if (!response.ok) throw new Error(`DNS ${type} lookup for ${hostname} failed (HTTP ${response.status})`)
  const body = await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> }
  if (body.Status !== 0 && body.Status !== 3) throw new Error(`DNS ${type} lookup for ${hostname} failed (status ${body.Status})`)
  return (body.Answer ?? [])
    .filter(answer => answer.type === DNS_RECORD_TYPES[type])
    .map((answer) => normalizeDnsValue(answer.data))
    .filter(Boolean)
}

export interface DomainResolutionInspection {
  hostname: string
  checked_at: string
  records: Array<{ type: 'CNAME' | 'A' | 'AAAA'; value: string }>
  points_to_saas: boolean | null
  resolves_elsewhere: boolean
}

export function domainRecordsPointToSaas(
  cnameRecords: string[],
  aRecords: string[],
  aaaaRecords: string[],
  cnameTarget: string,
): boolean | null {
  if (cnameTarget && cnameRecords.some((value) => value === cnameTarget || value.endsWith(`.${cnameTarget}`))) {
    return true
  }
  if (cnameRecords.length > 0) return false
  if (aRecords.length > 0 || aaaaRecords.length > 0) return null
  return false
}

export async function inspectDomainResolution(env: DomainEnv, hostname: string, signal?: AbortSignal): Promise<DomainResolutionInspection> {
  const normalizedHostname = normalizeDomain(hostname)
  const cnameTarget = normalizeDnsValue(env.CF_SAAS_CNAME_TARGET)
  const [cnameRecords, aRecords, aaaaRecords] = await Promise.all([
    queryDnsJson(normalizedHostname, 'CNAME', signal),
    queryDnsJson(normalizedHostname, 'A', signal),
    queryDnsJson(normalizedHostname, 'AAAA', signal),
  ])
  const records = [
    ...cnameRecords.map((value) => ({ type: 'CNAME' as const, value })),
    ...aRecords.map((value) => ({ type: 'A' as const, value })),
    ...aaaaRecords.map((value) => ({ type: 'AAAA' as const, value })),
  ]
  const pointsToSaas = domainRecordsPointToSaas(cnameRecords, aRecords, aaaaRecords, cnameTarget)
  return {
    hostname: normalizedHostname,
    checked_at: new Date().toISOString(),
    records,
    points_to_saas: pointsToSaas,
    resolves_elsewhere: pointsToSaas === false && records.length > 0,
  }
}

function isPendingTooLong(domain: DomainRecord, status: DomainStatus, nowMs: number): boolean {
  if (status !== 'pending' && status !== 'verifying') return false
  const createdAtMs = Date.parse(domain.created_at)
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs >= STUCK_AFTER_MS
}

async function persistCloudflareState(
  env: DomainEnv,
  db: D1Database,
  domainId: string,
  hostname: CloudflareCustomHostname,
  options: {
    leaseToken?: string | null
    incrementRetry?: boolean
    actorType?: DomainActorType
    actorId?: string | null
    skipPromotion?: boolean
    dnsInspection?: DomainResolutionInspection
    triggeredRevalidation?: boolean
  } = {}
): Promise<DomainRecord> {
  const before = await queryFirst<DomainRecord>(db, `SELECT * FROM organization_domains WHERE id = ?`, [domainId])
  if (!before) throw new Error('Domain not found')
  if ((before.reconciliation_token ?? null) !== (options.leaseToken ?? null)) throw new Error('Domain reconciliation was superseded')

  const sslValidation = firstSslValidation(hostname)
  const sslValidation2 = secondSslValidation(hostname)
  const dnsTarget = env.CF_SAAS_CNAME_TARGET || null
  const retryCount = options.incrementRetry ? Math.min(MAX_RETRY_COUNT, Number(before.retry_count || 0) + 1) : Number(before.retry_count || 0)
  const dnsStatus = options.dnsInspection?.points_to_saas
    ? 'valid'
    : options.dnsInspection?.resolves_elsewhere
      ? 'invalid'
      : hostname.status === 'active'
        ? 'valid'
        : (before.dns_status || 'pending')
  const mappedStatus = mapCloudflareStatus(hostname.status, hostname.ssl?.status, dnsStatus)
  const now = new Date().toISOString()
  const status = isPendingTooLong(before, mappedStatus, Date.parse(now)) ? 'failed' : mappedStatus
  const activatedAt = status === 'active' ? (before.activated_at || now) : before.activated_at
  const certificateLastActiveAt = hostname.ssl?.status === 'active'
    ? now
    : before.certificate_last_active_at ?? null
  const renewalIssueStartedAt = before.status === 'active' && hostname.ssl?.status && hostname.ssl.status !== 'active'
    ? before.renewal_issue_started_at ?? now
    : hostname.ssl?.status === 'active'
      ? null
      : before.renewal_issue_started_at ?? null
  const errors = hostname.verification_errors?.join('; ') || null

  const updates: BatchQuery[] = []
  if (status === 'active' && before.role === 'canonical') {
    updates.push({
      query: `
      UPDATE organization_domains
      SET role = 'secondary', updated_at = ?
      WHERE organization_id = ?
        AND id != ?
        AND role = 'canonical'
        AND EXISTS (
          SELECT 1
          FROM organization_domains expected
          WHERE expected.id = ? AND expected.role = 'canonical' AND expected.reconciliation_token IS ?
        )
    `,
      params: [now, before.organization_id, domainId, domainId, options.leaseToken ?? null],
    })
  }

  // One list of what this reconciliation writes, so the statement and the
  // audit row's afterState are the same values rather than two copies.
  const next = {
    cloudflare_hostname_id: hostname.id,
    cloudflare_hostname_status: hostname.status ?? null,
    cloudflare_ssl_status: hostname.ssl?.status ?? null,
    ownership_validation_name: hostname.ownership_verification?.name ?? null,
    ownership_validation_type: hostname.ownership_verification?.type ?? null,
    ownership_validation_value: hostname.ownership_verification?.value ?? null,
    ssl_validation_name: sslValidation?.txt_name ?? sslValidation?.name ?? null,
    ssl_validation_type: sslValidation?.type ?? 'TXT',
    ssl_validation_value: sslValidation?.txt_value ?? sslValidation?.value ?? null,
    ssl_validation_name_2: sslValidation2?.txt_name ?? sslValidation2?.name ?? null,
    ssl_validation_type_2: sslValidation2?.type ?? 'TXT',
    ssl_validation_value_2: sslValidation2?.txt_value ?? sslValidation2?.value ?? null,
    validation_strategy: before.validation_strategy ?? 'http_auto',
    dcv_delegation_name: before.validation_strategy === 'delegated_dcv' ? before.dcv_delegation_name ?? null : null,
    dcv_delegation_type: before.validation_strategy === 'delegated_dcv' ? before.dcv_delegation_type ?? null : null,
    dcv_delegation_value: before.validation_strategy === 'delegated_dcv' ? before.dcv_delegation_value ?? null : null,
    dns_target: dnsTarget,
    dns_status: dnsStatus,
    dns_last_resolved_at: options.dnsInspection?.checked_at ?? before.dns_last_resolved_at ?? null,
    dns_resolved_target: options.dnsInspection?.records.map((record) => `${record.type}:${record.value}`).join(', ') || before.dns_resolved_target || null,
    status,
    last_synced_at: now,
    next_check_at: status === 'active' || status === 'disabled' || status === 'deleted'
      ? null
      : nextCheckAt(retryCount, { recentDnsChange: options.triggeredRevalidation || dnsStatus === 'valid' }),
    retry_count: retryCount,
    activated_at: activatedAt,
    certificate_last_active_at: certificateLastActiveAt,
    renewal_issue_started_at: renewalIssueStartedAt,
    certificate_expires_at: hostname.ssl?.expires_on == null ? null : instantDate(hostname.ssl.expires_on).toISOString(),
    error_message: errors,
    metadata: JSON.stringify({
      cloudflare_created_at: hostname.created_at ?? null,
      ssl_validation_value2: null,
    }),
    updated_at: now,
    reconciliation_token: null,
    reconciliation_expires_at: null,
  } satisfies Partial<DomainRecord>
  const columns = Object.keys(next) as Array<keyof typeof next>
  const updateIndex = updates.length
  updates.push({
    query: `
    UPDATE organization_domains
    SET ${columns.map(column => `${column} = ?`).join(', ')}
    WHERE id = ? AND reconciliation_token IS ? AND desired_state = 'active' AND status NOT IN ('disabled', 'deleted')
  `,
    params: [...columns.map(column => next[column]), domainId, options.leaseToken ?? null],
  })

  // Both events are guarded on the update just before them: a reconciliation
  // that was superseded changed nothing and must not record that it did. The
  // second is guarded on the first, which inserted a row only if the update
  // changed one.
  const afterState = { ...before, ...next } satisfies DomainRecord
  if (before.status !== status || before.cloudflare_ssl_status !== next.cloudflare_ssl_status) {
    updates.push(organizationEventQuery({
      organizationId: before.organization_id,
      entityType: 'domain',
      entityId: domainId,
      eventType: 'domain_state_changed',
      actorType: options.actorType ?? 'cloudflare',
      actorId: options.actorId ?? null,
      message: `${before.domain} is ${status}`,
      beforeState: before,
      afterState,
      onlyIfPreviousChangedOneRow: true,
    }))
    if (before.status !== status && (status === 'active' || status === 'failed' || status === 'blocked')) {
      updates.push(organizationEventQuery({
        organizationId: before.organization_id,
        actorId: options.actorId ?? null,
        eventType: status === 'active' ? 'domain.verified' : 'domain.failed',
        entityType: 'domain',
        entityId: domainId,
        metadata: { domain: before.domain, status },
        onlyIfPreviousChangedOneRow: true,
      }))
    }
  }
  const updated = (await executeBatch(db, updates, { operation: 'Persist domain reconciliation' }))[updateIndex]
  if (updated?.meta?.changes !== 1) throw new Error('Domain reconciliation was superseded')

  const after = await queryFirst<DomainRecord>(db, `SELECT * FROM organization_domains WHERE id = ?`, [domainId]) as DomainRecord

  const zarazNeedsReconcile = before.status !== after.status && (before.status === 'active' || after.status === 'active')

  // promoteCanonicalIfReady can call setCanonicalDomain, which reads/writes
  // organization_domains rows for this site — callers still inserting other domain
  // rows for the same batch (createCustomDomainPair) must defer this until
  // after those inserts are done, so the candidate rows already exist.
  if (!options.skipPromotion) {
    if (after.status === 'active') await promoteCanonicalIfReady(db, after.organization_id)
    else await queueReconciliation(db, domainId, after.next_check_at || undefined)
  }

  // Last, and deliberately so. Reconciliation rewrites the analytics configuration
  // this domain change invalidates, and a failure is raised rather than swallowed —
  // but the status transition committed in the batch above, and every step between
  // there and here is derived from it and runs exactly once. Raising before them
  // stranded the domain: the next reconcile reads before.status === after.status
  // and reruns none of it, an active domain has next_check_at NULL so nothing
  // reschedules, and inside createCustomDomainPair the throw reached a cleanup
  // that deleted the hostnames just provisioned.
  if (zarazNeedsReconcile) {
    await (await import('~/server/utils/zaraz-analytics')).reconcileZarazAnalytics(env, db)
  }

  return after
}

export type DomainActorType = 'owner' | 'admin' | 'system' | 'cloudflare'

export async function createCustomDomainPair(
  env: DomainEnv,
  db: D1Database,
  opts: {
    organizationId: string
    domain: string
    includeWww?: boolean
    actorId?: string | null
    actorType?: DomainActorType
  }
): Promise<DomainRecord[]> {
  const domains = domainPair(opts.domain, opts.includeWww !== false)
  const canonical = canonicalDomainForPair(opts.domain, opts.includeWww !== false)
  await ensureDomainAvailable(db, domains, opts.organizationId)

  const now = new Date().toISOString()
  const entries = domains.map((domain) => ({
    id: crypto.randomUUID(),
    domain,
    role: (domain === canonical ? 'canonical' : 'secondary') as DomainRole
  }))
  const cloudflareByDomainId = new Map<string, CloudflareCustomHostname>()
  const createdHostnameIds: string[] = []
  const insertedDomainIds: string[] = []
  const records: DomainRecord[] = []

  try {
    // External side-effect first: provision both hostnames before DB commit.
    for (const entry of entries) {
      const hostname = await createCloudflareHostname(env, entry.domain)
      cloudflareByDomainId.set(entry.id, hostname)
      if (hostname.id) createdHostnameIds.push(hostname.id)
    }

    // The pair, what the owner did and what it achieved commit as one: the
    // hostnames are provisioned by now, so these rows are the domain being
    // connected. If a later step fails, the catch removes the rows and records
    // that it did, so the trail reads added, connected, failed.
    await executeBatch(db, entries.flatMap((entry) => [{
      query: `
        INSERT INTO organization_domains
        (id, organization_id, domain, type, role, status, validation_strategy, dns_target, dns_status, created_at, updated_at)
        VALUES (?, ?, ?, 'custom', ?, 'pending', 'http_auto', ?, 'pending', ?, ?)
      `,
      params: [entry.id, opts.organizationId, entry.domain, entry.role, env.CF_SAAS_CNAME_TARGET, now, now],
    }, organizationEventQuery({
      organizationId: opts.organizationId,
      entityType: 'domain',
      entityId: entry.id,
      eventType: 'domain_added',
      actorType: opts.actorType ?? 'owner',
      actorId: opts.actorId ?? null,
      message: `${entry.domain} added`
    }), organizationEventQuery({
      organizationId: opts.organizationId,
      actorId: opts.actorId ?? null,
      eventType: 'domain.connected',
      entityType: 'domain',
      entityId: entry.id,
      metadata: { domain: entry.domain, role: entry.role },
    })]), { operation: 'Connect custom domain pair' })
    insertedDomainIds.push(...entries.map(entry => entry.id))

    for (const entry of entries) {
      const hostname = cloudflareByDomainId.get(entry.id)
      if (!hostname) throw new Error(`Missing Cloudflare hostname for ${entry.domain}`)
      records.push(await persistCloudflareState(env, db, entry.id, hostname, { actorType: 'cloudflare', skipPromotion: true }))
    }

    // Deferred from persistCloudflareState (skipPromotion: true) — must run
    // after the inserts above since promoteCanonicalIfReady/setCanonicalDomain
    // write to the same rows and should see them already committed.
    for (const record of records) {
      if (record.status === 'active') await promoteCanonicalIfReady(db, record.organization_id)
      else await queueReconciliation(db, record.id, record.next_check_at || undefined)
    }

  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error('Cloudflare hostname creation failed')
    const message = normalizedError.message || 'Cloudflare hostname creation failed'

    // Every piece of cleanup is attempted before anything is raised, so one
    // that fails does not strand the rest; whatever was left behind is named
    // in the error this function throws.
    const leftBehind: string[] = []
    for (const hostnameId of createdHostnameIds) {
      try {
        await deleteCloudflareHostname(env, hostnameId)
      } catch (cleanupError) {
        leftBehind.push(`Cloudflare hostname ${hostnameId} (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`)
      }
    }

    // The rows come out, so a retry is not blocked, in the same batch as the
    // record of why.
    try {
      await executeBatch(db, [
        ...insertedDomainIds.map(domainId => ({ query: 'DELETE FROM organization_domains WHERE id = ?', params: [domainId] })),
        ...entries.map(entry => organizationEventQuery({
          organizationId: opts.organizationId,
          entityType: 'domain',
          eventType: 'cloudflare_create_failed',
          actorType: 'cloudflare',
          message: `${entry.domain}: ${message}`,
          metadata: { domain: entry.domain, error: message }
        })),
      ], { operation: 'Remove failed custom domain pair' })
    } catch (cleanupError) {
      leftBehind.push(`domain rows ${insertedDomainIds.join(', ') || 'none'} and their failure record (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`)
    }

    throw new Error(leftBehind.length ? `${message}; not cleaned up: ${leftBehind.join('; ')}` : message, { cause: error })
  }

  return records
}

export async function syncDomainWithCloudflare(
  env: DomainEnv,
  db: D1Database,
  domainId: string,
  actorType: DomainActorType = 'system',
  actorId?: string | null,
  signal?: AbortSignal,
  options: { forceRevalidation?: boolean; leaseToken?: string } = {}
): Promise<DomainRecord> {
  const leaseToken = options.leaseToken ?? crypto.randomUUID()
  try {
    signal?.throwIfAborted()

    const now = new Date().toISOString()
    const domain = await queryFirst<DomainRecord>(db, `
      UPDATE organization_domains SET reconciliation_token = ?, reconciliation_expires_at = ?
      WHERE id = ? AND type = 'custom' AND desired_state = 'active' AND status NOT IN ('deleted', 'disabled')
        AND (reconciliation_token = ? OR reconciliation_expires_at IS NULL OR reconciliation_expires_at <= ?)
      RETURNING *
    `, [leaseToken, new Date(Date.now() + 120_000).toISOString(), domainId, options.leaseToken ?? null, now])
    if (!domain) throw new Error('Domain is unavailable or another reconciliation is running')

    if (!domain.cloudflare_hostname_id) {
      const hostname = await createCloudflareHostname(env, domain.domain, signal)
      signal?.throwIfAborted()
      return await persistCloudflareState(env, db, domainId, hostname, { leaseToken, incrementRetry: true, actorType, actorId })
    }

    const dnsInspection = await inspectDomainResolution(env, domain.domain, signal)
    signal?.throwIfAborted()
    let hostname = await getCloudflareHostname(env, domain.cloudflare_hostname_id, signal)
    signal?.throwIfAborted()
    const shouldPatch = options.forceRevalidation
      || hostname.status === 'moved'
      || domain.status === 'failed'
      || (dnsInspection.points_to_saas === true && hostname.status !== 'active')
    let triggeredRevalidation = false
    if (shouldPatch) {
      hostname = await patchCloudflareHostname(env, domain.cloudflare_hostname_id, signal)
      triggeredRevalidation = true
      signal?.throwIfAborted()
    }
    return await persistCloudflareState(env, db, domainId, hostname, {
      leaseToken,
      incrementRetry: true,
      actorType,
      actorId,
      dnsInspection,
      triggeredRevalidation,
    })
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error('Unknown error')
    // A lease this call took is released with the reason, so a retry is not
    // locked out until it expires. A caller that passed its own lease
    // (the reconciliation scheduler) releases it and records the failure itself.
    if (!options.leaseToken) {
      await execute(db, `
        UPDATE organization_domains SET error_message = ?, updated_at = ?,
          reconciliation_token = NULL, reconciliation_expires_at = NULL
        WHERE id = ? AND reconciliation_token = ?
      `, [normalizedError.message, new Date().toISOString(), domainId, leaseToken])
    }
    if (normalizedError.name === 'AbortError') {
      const abortError = new Error('Domain sync aborted')
      abortError.name = 'AbortError'
      throw abortError
    }
    throw normalizedError
  }
}

export async function deleteCustomDomain(
  env: DomainEnv,
  db: D1Database,
  domainId: string,
  actorType: DomainActorType,
  actorId?: string | null,
  leaseToken?: string,
): Promise<void> {
  const token = leaseToken ?? crypto.randomUUID()
  const domain = await queryFirst<DomainRecord>(db, `
    UPDATE organization_domains SET desired_state = 'deleted', reconciliation_token = ?, reconciliation_expires_at = ?
    WHERE id = ? AND type = 'custom' AND status <> 'deleted'
      AND (reconciliation_token = ? OR reconciliation_expires_at IS NULL OR reconciliation_expires_at <= ?)
    RETURNING *
  `, [token, new Date(Date.now() + 120_000).toISOString(), domainId, leaseToken ?? null, new Date().toISOString()])
  if (!domain) throw new Error('Domain not found')

  let cloudflareDeleteError: string | null = null
  if (domain.cloudflare_hostname_id) {
    try {
      await deleteCloudflareHostname(env, domain.cloudflare_hostname_id)
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error('Cloudflare hostname deletion failed')
      cloudflareDeleteError = normalizedError.message || 'Cloudflare hostname deletion failed'
      console.error('deleteCustomDomain: failed to delete Cloudflare hostname', {
        domainId,
        cloudflareHostnameId: domain.cloudflare_hostname_id,
        error: cloudflareDeleteError
      })
    }
  }

  const now = new Date().toISOString()

  // If the Cloudflare hostname is still live, the domain must NOT be marked
  // deleted locally — ensureDomainAvailable only excludes status = 'deleted',
  // so doing so would let another site claim a hostname Cloudflare still
  // routes to this one. Keep it active and queue a reconciliation retry
  // instead, so cleanup is retried until the Cloudflare side actually clears.
  if (cloudflareDeleteError) {
    // The failure is recorded whether or not this call still holds the lease:
    // Cloudflare refused the delete either way.
    await executeBatch(db, [{
      query: `
      UPDATE organization_domains
      SET error_message = ?, updated_at = ?, retry_count = MIN(12, retry_count + 1), next_check_at = ?,
          reconciliation_token = NULL, reconciliation_expires_at = NULL
      WHERE id = ? AND reconciliation_token = ?
    `,
      params: [`Cloudflare delete failed: ${cloudflareDeleteError}`, now, nextCheckAt(Number(domain.retry_count ?? 0) + 1), domainId, token],
    }, organizationEventQuery({
      organizationId: domain.organization_id,
      entityType: 'domain',
      entityId: domainId,
      eventType: 'cloudflare_delete_failed',
      actorType: 'cloudflare',
      message: cloudflareDeleteError,
      metadata: {
        cloudflare_hostname_id: domain.cloudflare_hostname_id,
        error: cloudflareDeleteError
      }
    })], { operation: 'Record failed domain deletion' })
    throw new Error(`Failed to delete domain: ${cloudflareDeleteError}`)
  }

  const [deleted] = await executeBatch(db, [{
    query: `
    UPDATE organization_domains
    SET status = 'deleted', role = 'secondary', updated_at = ?, next_check_at = NULL,
        reconciliation_token = NULL, reconciliation_expires_at = NULL
    WHERE id = ? AND reconciliation_token = ?
  `,
    params: [now, domainId, token],
  }, organizationEventQuery({
    organizationId: domain.organization_id,
    entityType: 'domain',
    entityId: domainId,
    eventType: 'domain_deleted',
    actorType,
    actorId,
    message: `${domain.domain} deleted`,
    onlyIfPreviousChangedOneRow: true,
  })], { operation: 'Delete custom domain' })
  if (deleted?.meta?.changes !== 1) throw new Error('Domain deletion was superseded')

  await promoteCanonicalIfReady(db, domain.organization_id)

  // Same ordering as reconcileDomain, for the same reason: the row is already
  // 'deleted', so a second call answers "Domain not found" and never reaches
  // here again. Raising before the promotion left the site with no canonical
  // domain at all, which is worse than the analytics it was protecting.
  if (domain.status === 'active') {
    await (await import('~/server/utils/zaraz-analytics')).reconcileZarazAnalytics(env, db)
  }
}

// Releases the Cloudflare custom hostnames behind a set of organization_domains rows.
// Best-effort per domain: one domain's Cloudflare failure (queued for
// reconciliation retry by deleteCustomDomain) must not stop the rest.
async function deleteCustomDomainsWhere(
  env: DomainEnv,
  db: D1Database,
  scope: { column: 'organization_id' | 'organization_id'; value: string },
): Promise<void> {
  const domains = await queryAll<{ id: string }>(db, `
    SELECT id FROM organization_domains
    WHERE ${scope.column} = ? AND type = 'custom' AND status != 'deleted'
  `, [scope.value])
  // Every domain is attempted before any failure is raised, because one that
  // cannot be deleted must not strand the rest. But a sweep that left domains
  // behind has not deleted them, and said so only to a console.
  const undeleted: Array<{ domainId: string; cause: unknown }> = []
  for (const domain of domains || []) {
    try {
      await deleteCustomDomain(env, db, domain.id, 'system')
    } catch (error) {
      undeleted.push({ domainId: domain.id, cause: error })
      console.error('deleteCustomDomains: failed to delete domain', {
        [scope.column]: scope.value,
        domainId: domain.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (undeleted.length) {
    throw new AggregateError(
      undeleted.map(({ cause }) => cause instanceof Error ? cause : new Error(String(cause))),
      `${undeleted.length} custom domain(s) could not be deleted: ${undeleted.map(({ domainId }) => domainId).join(', ')}`,
    )
  }
}

export async function deleteOrganizationCustomDomains(
  env: DomainEnv,
  db: D1Database,
  organizationId: string
): Promise<void> {
  await deleteCustomDomainsWhere(env, db, { column: 'organization_id', value: organizationId })
}

export async function setCanonicalDomain(
  db: D1Database,
  organizationId: string,
  domainId: string,
  actorType: DomainActorType,
  actorId?: string | null
): Promise<DomainRecord> {
  const domain = await queryFirst<DomainRecord>(db, `
    SELECT *
    FROM organization_domains
    WHERE id = ? AND organization_id = ? AND status = 'active'
    LIMIT 1
  `, [domainId, organizationId])
  if (!domain) throw new Error('Only active domains can be canonical')

  // One batch, so the site is never left with two canonical domains or none,
  // and the record of the change commits with it.
  const now = new Date().toISOString()
  await executeBatch(db, [
    { query: `UPDATE organization_domains SET role = 'secondary', updated_at = ? WHERE organization_id = ? AND role = 'canonical'`, params: [now, organizationId] },
    { query: `UPDATE organization_domains SET role = 'canonical', updated_at = ? WHERE id = ?`, params: [now, domainId] },
    organizationEventQuery({
      organizationId: domain.organization_id,
      entityType: 'domain',
      entityId: domainId,
      eventType: 'canonical_domain_changed',
      actorType,
      actorId,
      message: `${domain.domain} set as primary`
    }),
  ], { operation: 'Set canonical domain' })

  const row = await queryFirst<DomainRecord>(db, `SELECT * FROM organization_domains WHERE id = ?`, [domainId])
  if (!row) throw new Error(`Domain not found: ${domainId}`)
  return row
}

async function promoteCanonicalIfReady(db: D1Database, organizationId: string): Promise<void> {
  const activeCanonical = await queryFirst<DomainRecord>(db, `
    SELECT *
    FROM organization_domains
    WHERE organization_id = ? AND role = 'canonical' AND status = 'active'
    LIMIT 1
  `, [organizationId])

  if (activeCanonical) return

  const activeCustom = await queryFirst<DomainRecord>(db, `
    SELECT *
    FROM organization_domains
    WHERE organization_id = ? AND type = 'custom' AND status = 'active'
    ORDER BY domain LIKE 'www.%' DESC, created_at ASC
    LIMIT 1
  `, [organizationId])

  if (activeCustom) {
    await setCanonicalDomain(db, organizationId, activeCustom.id, 'system')
    return
  }

  const activeSubdomain = await queryFirst<DomainRecord>(db, `
    SELECT *
    FROM organization_domains
    WHERE organization_id = ? AND type = 'subdomain' AND status = 'active'
    ORDER BY created_at ASC
    LIMIT 1
  `, [organizationId])

  if (!activeSubdomain) return

  await setCanonicalDomain(db, organizationId, activeSubdomain.id, 'system')
}

export async function reconcileDueDomains(env: DomainEnv, db: D1Database, limit = 25): Promise<{ checked: number; failed: number }> {
  const now = new Date().toISOString()
  const rows = await queryAll<{ id: string }>(db, `
    SELECT id FROM organization_domains WHERE type = 'custom' AND status <> 'deleted'
      AND (status IN ('pending', 'verifying', 'failed', 'blocked') OR desired_state = 'deleted')
      AND (next_check_at IS NULL OR next_check_at <= ?)
      AND (reconciliation_expires_at IS NULL OR reconciliation_expires_at <= ?)
    ORDER BY COALESCE(next_check_at, created_at) LIMIT ?
  `, [now, now, limit])
  let checked = 0
  let failed = 0
  for (const row of rows) {
    const token = crypto.randomUUID()
    const currentTime = new Date().toISOString()
    const claim = await queryFirst<{ desired_state: 'active' | 'deleted'; retry_count: number }>(db, `
      UPDATE organization_domains SET reconciliation_token = ?, reconciliation_expires_at = ?
      WHERE id = ? AND status <> 'deleted'
        AND (status IN ('pending', 'verifying', 'failed', 'blocked') OR desired_state = 'deleted')
        AND (next_check_at IS NULL OR next_check_at <= ?)
        AND (reconciliation_expires_at IS NULL OR reconciliation_expires_at <= ?)
      RETURNING desired_state, retry_count
    `, [token, new Date(Date.now() + 120_000).toISOString(), row.id, currentTime, currentTime])
    if (!claim) continue
    checked += 1
    try {
      if (claim.desired_state === 'deleted') await deleteCustomDomain(env, db, row.id, 'system', null, token)
      else await syncDomainWithCloudflare(env, db, row.id, 'system', null, undefined, { leaseToken: token })
    } catch (error) {
      failed += 1
      const retryCount = Math.min(MAX_RETRY_COUNT, claim.retry_count + 1)
      await execute(db, `
        UPDATE organization_domains SET retry_count = ?, next_check_at = ?, error_message = ?, updated_at = ?,
          reconciliation_token = NULL, reconciliation_expires_at = NULL
        WHERE id = ? AND reconciliation_token = ?
      `, [retryCount, nextCheckAt(retryCount), error instanceof Error ? error.message : 'Domain reconciliation failed', new Date().toISOString(), row.id, token])
    }
  }
  return { checked, failed }
}

/**
 * The site's canonical public origin, as a URL-prefix property: scheme, host,
 * trailing slash. Search Console treats `https://example.com` and
 * `https://example.com/` as different properties and only accepts the latter
 * for a URL prefix, so the slash is part of the value rather than a caller's
 * responsibility.
 *
 * Null when the organization has no active canonical domain yet, which is a organization that
 * cannot be verified — the caller says so rather than guessing a host.
 */
export async function organizationPublicUrl(env: DomainEnv, db: D1Database, organizationId: string): Promise<string | null> {
  const row = await queryFirst<{ domain: string; subdomain: string | null }>(db, `
    SELECT d.domain, o.subdomain FROM organization_domains d
    JOIN organization o ON o.id = d.organization_id
    WHERE d.organization_id = ? AND d.role = 'canonical' AND d.status = 'active'
    LIMIT 1
  `, [organizationId])
  if (!row) return null
  const origin = tenantOrganizationOrigin({
    platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
    freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
    subdomain: row.subdomain ?? '',
    canonicalDomain: row.domain,
  })
  if (!origin) throw new Error('Active organization domain has no configured public origin')
  return `${origin}/`
}
