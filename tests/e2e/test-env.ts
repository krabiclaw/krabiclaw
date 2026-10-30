import { usesTenantHeader } from '../../server/utils/tenant-hosts'
import { SEED_SUBDOMAINS } from './seed/manifest'
import type { SeedTenantKey } from '../../config/development-auth-fixtures'

export function testBaseUrl() {
  const previewUrl = process.env.PLAYWRIGHT_PREVIEW_URL
  if (previewUrl) return previewUrl

  const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PLAYWRIGHT_PORT must be a valid port')

  // Local E2E should target the webServer port explicitly instead of a stale
  // app domain from .env, otherwise tests can hit an unrelated process.
  return `http://localhost:${port}`
}

function usesSharedTenantHost(base: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    || usesTenantHeader(base.hostname)
}

/** A seeded business's public site: the local Worker, named by its subdomain header. */
export function seededSiteURL(_key: SeedTenantKey): string {
  return testBaseUrl().replace(/\/$/, '')
}

export function seededSiteHeaders(key: SeedTenantKey): Record<string, string> {
  return { 'x-preview-tenant': SEED_SUBDOMAINS[key] }
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

export function devLoginHeaders(): Record<string, string> | undefined {
  const secret = process.env.E2E_DEV_ROUTE_SECRET ?? ''
  return secret ? { 'x-dev-route-secret': secret } : undefined
}
