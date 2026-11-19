import { execute, queryAll, queryFirst } from '~/server/db'
import { PLATFORM_THEME_ID } from '~/utils/site-routing'
import { customHostnameZone, type DomainEnv } from '~/server/utils/domains'
import { NATIVE_PAGEVIEW_ZARAZ_EVENT, ZARAZ_ANALYTICS_PURPOSE, ZARAZ_ANALYTICS_PURPOSE_ID, ZARAZ_CONSENT_COOKIE_NAME, zarazConsentModalIntroHtml } from '~/utils/zaraz-consent'

export interface ZarazEnv extends DomainEnv {
  CLOUDFLARE_API_TOKEN?: string
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
  /**
   * `absent` declares that this environment has no Zaraz zone of its own.
   * Staging, preview, local development and E2E run on copies of production's
   * rows, and the only Zaraz zone is production's, so reconciling from them
   * would rewrite production's tags. Production leaves it unset.
   */
  ZARAZ_ANALYTICS?: string
}

interface ZarazAction {
  actionType: string
  firingTriggers: string[]
  blockingTriggers?: string[]
  enabled: boolean
}

interface ZarazTool {
  component: string
  name: string
  enabled: boolean
  settings: Record<string, unknown>
  defaultFields?: Record<string, string | boolean>
  defaultPurpose?: string
  vendorName?: string
  vendorPolicyUrl?: string
  actions: Record<string, ZarazAction>
  [key: string]: unknown
}

interface ZarazTrigger {
  name?: string
  loadRules: Array<{ id?: string; match: string; op: string; value: string }>
  [key: string]: unknown
}

export interface ZarazConfig {
  tools: Record<string, ZarazTool>
  triggers: Record<string, ZarazTrigger | Record<string, unknown>>
  consent?: {
    enabled?: boolean
    hideModal?: boolean
    purposes?: Record<string, { name: string; description: string }>
    purposesWithTranslations?: Record<string, {
      name: Record<string, string>
      description: Record<string, string>
      order: number
    }>
    defaultLanguage?: string
    tcfCompliant?: boolean
    consentModalIntroHTML?: string
    customCSS?: string
    buttonTextTranslations?: {
      accept_all?: Record<string, string>
      confirm_my_choices?: Record<string, string>
      reject_all?: Record<string, string>
    }
    [key: string]: unknown
  }
  historyChange?: boolean
  variables?: Record<string, unknown>
  [key: string]: unknown
}

type CloudflareEnvelope<T> = {
  success: boolean
  result: T
  errors?: Array<{ message?: string }>
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'
const LOCK_STALE_MS = 60_000
const LOCK_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000]
const TENANT_KEY_PREFIX = 'ga-tenant-'
// Not under TENANT_KEY_PREFIX: it is shared by every GA4 tool and outlives any one tenant's.
const NATIVE_PAGEVIEW_TRIGGER_KEY = 'krabiclaw-native-pageview'
const GOOGLE_VENDOR_NAME = 'Google Analytics'
const GOOGLE_VENDOR_POLICY_URL = 'https://policies.google.com/privacy'

type ZarazPresence = 'present' | 'absent'

function requireZarazEnv(env: ZarazEnv): ZarazPresence {
  if (env.ZARAZ_ANALYTICS !== undefined) {
    if (env.ZARAZ_ANALYTICS !== 'absent') {
      throw new Error(`ZARAZ_ANALYTICS must be 'absent' or unset, not '${env.ZARAZ_ANALYTICS}'`)
    }
    if (env.CF_ZONE_ID || env.CF_PLATFORM_ZONE_ID) {
      throw new Error('ZARAZ_ANALYTICS=absent cannot be used with a Zaraz zone binding')
    }
    return 'absent'
  }
  if (!env.CF_ZONE_ID) throw new Error('CF_ZONE_ID is required')
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required')
  return 'present'
}

async function zarazRequest<T>(zoneId: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${CF_API_BASE}/zones/${zoneId}/settings/zaraz/config`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const payload = await response.json() as CloudflareEnvelope<T>
  if (!response.ok || !payload.success) {
    const message = payload.errors?.map(error => error.message).filter(Boolean).join('; ')
    throw new Error(message || `Cloudflare Zaraz API request failed (${response.status})`)
  }
  return payload.result
}

async function acquireLock(db: D1Database, zoneId: string): Promise<number> {
  const key = 'lease:zaraz:' + zoneId
  for (const delay of LOCK_RETRY_DELAYS_MS) {
    const now = new Date()
    const lease = await queryFirst<{ count: number }>(db, `
      INSERT INTO rate_limits (key, count, updated_at, expires_at) VALUES (?, 1, ?, ?)
      ON CONFLICT(key) DO UPDATE SET count = rate_limits.count + 1,
        updated_at = excluded.updated_at, expires_at = excluded.expires_at
      WHERE rate_limits.expires_at <= excluded.updated_at
      RETURNING count
    `, [key, now.toISOString(), new Date(now.getTime() + LOCK_STALE_MS).toISOString()])
    if (lease) return lease.count
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  throw new Error('Timed out waiting for Zaraz configuration sync lock')
}

async function releaseLock(db: D1Database, zoneId: string, generation: number): Promise<void> {
  await execute(db, `UPDATE rate_limits SET expires_at = ? WHERE key = ? AND count = ?`,
    [new Date().toISOString(), 'lease:zaraz:' + zoneId, generation])
}

function tenantKey(organizationId: string): string {
  return `${TENANT_KEY_PREFIX}${organizationId}`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function tenantPageLocationRegex(hostnames: string[]): string {
  return `^(${hostnames.map(escapeRegex).join('|')})$`
}

function configureZarazConsentManagement(config: ZarazConfig, platformOrigin: string) {
  config.consent ||= {}
  config.consent.enabled = true
  // The site notice asks for a choice on first visit. Cookie preferences opens
  // Zaraz's own modal to change that answer later.
  config.consent.hideModal = true
  config.consent.cookieName = ZARAZ_CONSENT_COOKIE_NAME
  config.consent.defaultLanguage = 'en'
  config.consent.tcfCompliant = false
  const intro = zarazConsentModalIntroHtml(platformOrigin)
  config.consent.consentModalIntroHTML = intro
  config.consent.consentModalIntroHTMLWithTranslations = { en: intro }
  config.consent.customCSS = ''
  config.consent.buttonTextTranslations = {
    accept_all: { en: 'Accept' },
    confirm_my_choices: { en: 'Confirm my choices' },
    reject_all: { en: 'Reject' },
  }
  config.consent.purposes ||= {}
  config.consent.purposes[ZARAZ_ANALYTICS_PURPOSE_ID] = ZARAZ_ANALYTICS_PURPOSE
  config.consent.purposesWithTranslations = {
    ...config.consent.purposesWithTranslations,
    [ZARAZ_ANALYTICS_PURPOSE_ID]: {
      name: { en: ZARAZ_ANALYTICS_PURPOSE.name },
      description: { en: ZARAZ_ANALYTICS_PURPOSE.description },
      order: 0,
    },
  }
}

function makeHostBlockTrigger(name: string, hostnames: string[]): ZarazTrigger {
  return {
    name,
    loadRules: [{
      match: '{{ system.page.url.hostname }}',
      op: 'NOT_MATCH_REGEX',
      value: tenantPageLocationRegex(hostnames),
    }],
  }
}

function firingTriggersForAction(action: ZarazAction): string[] {
  // A page view is sent to GA only when the collector reports that the native pageview was accepted;
  // Zaraz's own automatic pageview trigger (page load and history changes) never fires it.
  if (action.actionType === 'pageview') return [NATIVE_PAGEVIEW_TRIGGER_KEY]
  if (action.actionType === 'event') return ['AllTracks']
  return action.firingTriggers?.length ? action.firingTriggers : ['Pageview']
}

function scopeActionsToTrigger(actions: Record<string, ZarazAction> | undefined, blockingTriggers: string[]) {
  const source = actions && Object.keys(actions).length
    ? actions
    : { AllPageviews: { actionType: 'pageview', firingTriggers: [], enabled: true } }
  return Object.fromEntries(Object.entries(source).map(([key, action]) => [
    key,
    {
      ...action,
      firingTriggers: firingTriggersForAction(action),
      blockingTriggers,
      enabled: action.enabled !== false,
    },
  ]))
}

function isGa4Tool(tool: ZarazTool | undefined): tool is ZarazTool {
  return tool?.component === 'google-analytics_v4'
}

function ga4ToolTemplate(config: ZarazConfig): ZarazTool | undefined {
  return Object.values(config.tools ?? {}).find(tool =>
    isGa4Tool(tool) && tool.defaultFields
  )
}

function zarazFieldMap(value: unknown): Record<string, string | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) =>
      typeof fieldValue === 'string' || typeof fieldValue === 'boolean'
    ),
  )
}

function upsertGa4Tool(
  config: ZarazConfig,
  key: string,
  input: { name: string; measurementId: string; triggerKey: string; existing?: ZarazTool; template?: ZarazTool },
) {
  const existing = input.existing
  const template = input.template ?? (existing?.defaultFields ? existing : ga4ToolTemplate(config))
  config.tools[key] = {
    ...template,
    ...existing,
    component: 'google-analytics_v4',
    name: existing?.name || input.name,
    enabled: true,
    settings: { ...(template?.settings ?? {}), ...(existing?.settings ?? {}), tid: input.measurementId },
    defaultFields: {
      ...zarazFieldMap(template?.defaultFields),
      ...zarazFieldMap(existing?.defaultFields),
      user_id: '{{ client.user_id }}',
    },
    defaultPurpose: ZARAZ_ANALYTICS_PURPOSE_ID,
    vendorName: GOOGLE_VENDOR_NAME,
    vendorPolicyUrl: GOOGLE_VENDOR_POLICY_URL,
    // The template is another GA4 tool, usually the platform's; its tool-level
    // blocking trigger must not travel with it, or the tenant tool is blocked
    // on the tenant's own hosts (Zaraz debug on NCLS, 2026-09-27).
    blockingTriggers: [input.triggerKey],
    actions: scopeActionsToTrigger(existing?.actions ?? template?.actions, [input.triggerKey]),
  }
}

function upsertTenantZarazAnalytics(
  config: ZarazConfig,
  input: ZarazAnalyticsTenant,
  template?: ZarazTool,
) {
  if (!input.measurementId || !input.hostnames.length) return
  config.triggers ||= {}
  config.tools ||= {}
  // No automatic single-page-application pageviews: the collector sends each one, manually, after the
  // native record accepted it.
  config.historyChange = false
  config.triggers[NATIVE_PAGEVIEW_TRIGGER_KEY] = {
    name: 'Native pageview accepted',
    description: 'Fires when the Blawby collector reports a recorded native pageview',
    loadRules: [{ id: 'kc-native-pageview', match: '{{ client.__zarazTrack }}', op: 'EQUALS', value: NATIVE_PAGEVIEW_ZARAZ_EVENT }],
    excludeRules: [],
  }
  const allTracks = config.triggers.AllTracks as ZarazTrigger | undefined
  if (allTracks && !allTracks.loadRules.some(rule => rule.id === 'kc-exclude-native-pageview')) {
    allTracks.loadRules.push({ id: 'kc-exclude-native-pageview', match: '{{ client.__zarazTrack }}', op: 'NOT_MATCH_REGEX', value: `^${NATIVE_PAGEVIEW_ZARAZ_EVENT}$` })
  }
  const key = tenantKey(input.organizationId)
  config.triggers[key] = makeHostBlockTrigger(`Block non-tenant hosts (${input.organizationId})`, input.hostnames)
  upsertGa4Tool(config, key, {
    name: `Tenant GA4 (${input.organizationId})`,
    measurementId: input.measurementId,
    triggerKey: key,
    existing: config.tools[key],
    template,
  })
}

function removeUndesiredAnalyticsConfig(config: ZarazConfig, desiredKeys: Set<string>): number {
  let removedTools = 0
  for (const key of Object.keys(config.tools ?? {})) {
    if ((key === 'ga-platform' || key.startsWith(TENANT_KEY_PREFIX)) && isGa4Tool(config.tools[key]) && !desiredKeys.has(key)) {
      Reflect.deleteProperty(config.tools, key)
      removedTools += 1
    }
  }
  for (const key of Object.keys(config.triggers ?? {})) {
    if ((key === 'ga-platform' || key.startsWith(TENANT_KEY_PREFIX)) && !desiredKeys.has(key)) {
      Reflect.deleteProperty(config.triggers, key)
    }
  }
  return removedTools
}

interface ActiveTenantAnalyticsRow {
  organization_id: string
  theme_id: string
  ga4_measurement_id: string
  domain: string
  type: string
  dns_target: string | null
}

export interface ZarazAnalyticsConfigChanges {
  configuredTenants: number
  removedAnalyticsTools: number
  updated: boolean
}

/**
 * `zaraz_absent` is this environment declaring it has no Zaraz zone
 * (ZARAZ_ANALYTICS=absent): nothing was read or written, so it carries zero
 * changes and callers report it rather than a reconciliation.
 */
export type ZarazAnalyticsReconciliationResult = ZarazAnalyticsConfigChanges & {
  status: 'reconciled' | 'zaraz_absent'
}

export interface ZarazAnalyticsTenant {
  organizationId: string
  measurementId: string
  hostnames: string[]
}

/** Key-order-independent serialization: the change check compares content, not the order assignments happened in. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
      : v)
}

interface PlatformZarazTemplate {
  tool: ZarazTool
  allTracks: ZarazTrigger
}

export function reconcileZarazAnalyticsConfig(
  config: ZarazConfig,
  input: {
    tenants: ZarazAnalyticsTenant[]
    platformOrigin: string
    platformTemplate?: PlatformZarazTemplate
  },
): ZarazAnalyticsConfigChanges {
  config.triggers ||= {}
  config.tools ||= {}
  const before = stableStringify(config)
  const desiredKeys = new Set(input.tenants.map(tenant => tenantKey(tenant.organizationId)))

  // The product page's ecommerce events (Product Viewed, Checkout Started)
  // reach the GA4 tools' ecommerce action only when the zone enables Zaraz's
  // ecommerce API.
  config.settings = { ...(config.settings as Record<string, unknown> | undefined), ecommerce: true }
  if (input.tenants.length) configureZarazConsentManagement(config, input.platformOrigin)
  if (input.platformTemplate && !config.triggers.AllTracks) {
    config.triggers.AllTracks = structuredClone(input.platformTemplate.allTracks)
  }
  for (const tenant of input.tenants) {
    upsertTenantZarazAnalytics(config, tenant, input.platformTemplate?.tool)
  }
  const removedAnalyticsTools = removeUndesiredAnalyticsConfig(config, desiredKeys)

  return {
    configuredTenants: input.tenants.length,
    removedAnalyticsTools,
    updated: stableStringify(config) !== before,
  }
}

export async function reconcileZarazAnalytics(
  env: ZarazEnv,
  db: D1Database,
): Promise<ZarazAnalyticsReconciliationResult> {
  if (requireZarazEnv(env) === 'absent') {
    return { status: 'zaraz_absent', configuredTenants: 0, removedAnalyticsTools: 0, updated: false }
  }

  const rows = await queryAll<ActiveTenantAnalyticsRow>(db, `
    SELECT o.id AS organization_id,
           o.theme_id,
           analytics.measurement_id AS ga4_measurement_id,
           domain.domain, domain.type, domain.dns_target
      FROM organization o
      JOIN organization_integrations analytics
        ON analytics.organization_id = o.id AND analytics.provider = 'google_analytics'
      JOIN organization_domains domain
        ON domain.organization_id = o.id
     WHERE o.status = 'active'
       AND o.onboarding_status = 'active'
       AND domain.status = 'active'
     ORDER BY o.id, domain.domain
  `)

  const tenants = new Map<string, {
    measurementId: string
    hostnames: string[]
  }>()
  for (const row of rows) {
    const existing = tenants.get(row.organization_id)
    if (existing) {
      existing.hostnames.push(row.domain.toLowerCase())
      continue
    }
    tenants.set(row.organization_id, {
      measurementId: row.ga4_measurement_id,
      hostnames: [row.domain.toLowerCase()],
    })
  }

  const platformUrl = new URL(env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '')
  if (platformUrl.protocol !== 'https:') throw new Error('Zaraz requires an HTTPS platform origin')
  const saasZone = env.CF_ZONE_ID!
  const token = env.CLOUDFLARE_API_TOKEN!
  const platformZone = env.CF_PLATFORM_ZONE_ID
  const zones = [{ id: saasZone, tenants: [...tenants].map(([organizationId, tenant]) => ({
    organizationId,
    measurementId: tenant.measurementId,
    hostnames: [...new Set(tenant.hostnames)].sort(),
  })) }]
  let platformTemplateKey: string | undefined
  if (platformZone) {
    const separateZones = platformZone !== saasZone
    const tenantHosts = zones[0]!.tenants
    let platformTenants = tenantHosts
    if (separateZones) {
      const managedPlatformHostnames = new Set(rows.filter(row =>
        row.type === 'custom' && customHostnameZone(env, row.dns_target) === platformZone,
      ).map(row => row.domain.toLowerCase()))
      const hostedByPlatformZone = (hostname: string) =>
        hostname === platformUrl.hostname || hostname.endsWith(`.${platformUrl.hostname}`)
        || managedPlatformHostnames.has(hostname)
      const selectHosts = (matches: (hostname: string) => boolean) => tenantHosts
        .map(tenant => ({ ...tenant, hostnames: tenant.hostnames.filter(matches) }))
        .filter(tenant => tenant.hostnames.length > 0)
      platformTenants = selectHosts(hostedByPlatformZone)
      zones[0]!.tenants = selectHosts(hostname => !hostedByPlatformZone(hostname))
      zones.push({ id: platformZone, tenants: platformTenants })
    }
    const platformIds = new Set(rows.filter(row => row.theme_id === PLATFORM_THEME_ID).map(row => row.organization_id))
    if (platformIds.size > 1) throw new Error('More than one linked organization runs the platform site')
    const platformId = [...platformIds][0]
    const analytics = platformId ? tenants.get(platformId) : undefined
    if (platformId && analytics?.measurementId) {
      if (separateZones) platformTemplateKey = tenantKey(platformId)
      const platformTenant = platformTenants.find(tenant => tenant.organizationId === platformId)
      if (platformTenant) {
        platformTenant.hostnames = [...new Set([...platformTenant.hostnames, platformUrl.hostname])].sort()
      } else platformTenants.push({
        organizationId: platformId,
        measurementId: analytics.measurementId,
        hostnames: [platformUrl.hostname],
      })
    }
  }

  const result: ZarazAnalyticsReconciliationResult = {
    status: 'reconciled', configuredTenants: tenants.size, removedAnalyticsTools: 0, updated: false,
  }
  let platformTemplate: PlatformZarazTemplate | undefined
  for (const zone of zones) {
    const generation = await acquireLock(db, zone.id)
    try {
      const input = { tenants: zone.tenants, platformOrigin: platformUrl.origin, platformTemplate: zone.id === platformZone ? platformTemplate : undefined }
      const config = await zarazRequest<ZarazConfig>(zone.id, token)
      const changes = reconcileZarazAnalyticsConfig(config, input)
      if (changes.updated) {
        await zarazRequest<ZarazConfig>(zone.id, token, { method: 'PUT', body: JSON.stringify(config) })
        const persisted = await zarazRequest<ZarazConfig>(zone.id, token)
        if (reconcileZarazAnalyticsConfig(persisted, input).updated) {
          throw new Error(`Zaraz zone ${zone.id} did not retain the reconciled native analytics settings`)
        }
      }
      if (zone.id === saasZone && platformTemplateKey) {
        const tool = config.tools[platformTemplateKey]
        const allTracks = config.triggers.AllTracks
        if (!isGa4Tool(tool) || !allTracks || !Array.isArray(allTracks.loadRules)
          || !Object.values(tool.actions).some(action => action.actionType === 'event' && action.enabled)) {
          throw new Error('The existing platform Zaraz tool must support ordinary events before it can be configured on the separate platform zone')
        }
        platformTemplate = { tool, allTracks: allTracks as ZarazTrigger }
      }
      result.removedAnalyticsTools += changes.removedAnalyticsTools
      result.updated ||= changes.updated
    } finally {
      await releaseLock(db, zone.id, generation)
    }
  }
  return result
}
