import type { APIRequestContext } from '@playwright/test'
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

function tenantPreviewHeaders(subdomain: string): Record<string, string> {
  return { 'x-preview-tenant': subdomain }
}

/** A seeded business's public site: the local Worker, named by its subdomain header. */
export function seededSiteURL(_key: SeedTenantKey): string {
  return testBaseUrl().replace(/\/$/, '')
}

export function seededSiteHeaders(key: SeedTenantKey): Record<string, string> {
  return tenantPreviewHeaders(SEED_SUBDOMAINS[key])
}

/** Chromium navigates tenant subdomains. Node requests name the tenant on the local Worker. */
export function readLocalTenant(request: APIRequestContext, subdomain: string, target: URL | string, params?: Record<string, string | number | boolean>) {
  const url = new URL(testBaseUrl())
  const { pathname, search } = new URL(target, url)
  url.pathname = pathname
  url.search = search
  return request.get(url.href, { headers: tenantPreviewHeaders(subdomain), params })
}

export function devLoginHeaders(): Record<string, string> | undefined {
  const secret = process.env.E2E_DEV_ROUTE_SECRET ?? ''
  return secret ? { 'x-dev-route-secret': secret } : undefined
}

/** The local Worker inherits these provider settings; CI may leave Payments unconfigured. */
export const paymentsProviderConfigured = ['STRIPE_SECRET_KEY', 'STRIPE_PAYMENTS_METHOD_CONFIGURATION', 'NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY']
  .every(name => Boolean(process.env[name]))
