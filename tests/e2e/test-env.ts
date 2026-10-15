import {
  environmentTenantAliasHostname,
  usesTenantHeader,
} from '../../server/utils/tenant-hosts'

export const POTTERY_HOUSE_CANONICAL_URL = 'https://www.potteryhousekrabi.com'
export const KIKUZUKI_CANONICAL_URL = 'https://www.kikuzuki-thailand.com'
export const NCLS_CANONICAL_URL = 'https://www.northcarolinalegalservices.org'

export const E2E_DEMO_ORGANIZATION_ID = 'org-demo'
export const E2E_POTTERY_ORGANIZATION_ID = 'org-user-pottery-house'
export const E2E_KIKUZUKI_ORGANIZATION_ID = 'org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX'

export function testBaseUrl() {
  const previewUrl = process.env.PLAYWRIGHT_PREVIEW_URL
  if (previewUrl) return previewUrl

  const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PLAYWRIGHT_PORT must be a valid port')

  // Local E2E should target the webServer port explicitly instead of a stale
  // app domain from .env, otherwise tests can hit an unrelated process.
  return `http://localhost:${port}`
}

function previewWorkerHeaders(slug: string): Record<string, string> {
  return { 'x-preview-tenant': slug }
}

function usesSharedTenantHost(base: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    || usesTenantHeader(base.hostname)
}

function deployedEnvironmentTenantBaseUrl(base: URL, slug: string): string | null {
  const aliasHostname = environmentTenantAliasHostname(base.hostname, slug)
  if (!aliasHostname) return null
  base.hostname = aliasHostname
  return base.toString().replace(/\/$/, '')
}

export function tenantTestBaseUrl() {
  const base = new URL(testBaseUrl())
  const environmentBaseUrl = deployedEnvironmentTenantBaseUrl(base, 'demo')
  if (environmentBaseUrl) return environmentBaseUrl
  if (usesSharedTenantHost(base)) {
    return base.toString().replace(/\/$/, '')
  }
  base.hostname = base.hostname.startsWith('demo.') ? base.hostname : `demo.${base.hostname}`
  return base.toString().replace(/\/$/, '')
}

export function potteryHouseTestBaseUrl() {
  const base = new URL(testBaseUrl())
  const environmentBaseUrl = deployedEnvironmentTenantBaseUrl(base, 'pottery-house')
  if (environmentBaseUrl) return environmentBaseUrl
  if (usesSharedTenantHost(base)) {
    return base.toString().replace(/\/$/, '')
  }
  return POTTERY_HOUSE_CANONICAL_URL
}

export function blawbyTestBaseUrl() {
  const base = new URL(testBaseUrl())
  const environmentBaseUrl = deployedEnvironmentTenantBaseUrl(base, 'ncls')
  if (environmentBaseUrl) return environmentBaseUrl
  if (usesSharedTenantHost(base)) return base.toString().replace(/\/$/, '')
  return NCLS_CANONICAL_URL
}

export function kikuzukiTestBaseUrl() {
  const base = new URL(testBaseUrl())
  const environmentBaseUrl = deployedEnvironmentTenantBaseUrl(base, 'kikuzuki-krabi-thailand')
  if (environmentBaseUrl) return environmentBaseUrl
  if (usesSharedTenantHost(base)) {
    return base.toString().replace(/\/$/, '')
  }
  return KIKUZUKI_CANONICAL_URL
}

/**
 * Can a tenant be reached at its own hostname here?
 *
 * The local Worker preserves <tenant>.localhost, so iframe previews use their
 * real tenant hostname. Shared preview origins that require x-preview-tenant
 * cannot convey tenant identity from an iframe URL.
 */
export function tenantHostIsAddressable(): boolean {
  const base = new URL(testBaseUrl())
  return base.hostname === 'localhost' || !usesSharedTenantHost(base)
}

export function tenantTestExtraHeaders(): Record<string, string> {
  const base = new URL(testBaseUrl())
  return usesSharedTenantHost(base) ? previewWorkerHeaders('demo') : {}
}

export function potteryHouseTestExtraHeaders(): Record<string, string> {
  const base = new URL(testBaseUrl())
  return usesSharedTenantHost(base) ? previewWorkerHeaders('pottery-house') : {}
}

export function blawbyTestExtraHeaders(): Record<string, string> {
  const base = new URL(testBaseUrl())
  return usesSharedTenantHost(base) ? previewWorkerHeaders('ncls') : {}
}

export function kikuzukiTestExtraHeaders(): Record<string, string> {
  const base = new URL(testBaseUrl())
  return usesSharedTenantHost(base)
    ? previewWorkerHeaders('kikuzuki-krabi-thailand')
    : {}
}

export function devLoginHeaders(): Record<string, string> | undefined {
  const secret = process.env.E2E_DEV_ROUTE_SECRET ?? ''
  return secret ? { 'x-dev-route-secret': secret } : undefined
}
