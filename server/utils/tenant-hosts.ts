// Pure host-matching helpers for tenant/platform resolution.
// Extracted so the platform-vs-tenant decision can be unit tested
// independently of the H3 event/D1 plumbing in tenant-resolution.ts.

export interface TenantHostEnv {
  NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN?: string
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
}

const PAGES_DEV_HOST = 'krabiclaw.pages.dev'

const ENVIRONMENT_PLATFORM_HOST_PATTERN = /^(staging)\.(.+)$/
const ENVIRONMENT_TENANT_ALIAS_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-staging\.krabiclaw\.com$/
const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

// Strip protocol, path, and port so config values (which may be
// full URLs like "https://krabiclaw.com" or "http://localhost:3000") compare
// cleanly against a request's hostname (which never carries protocol and has
// already had its port stripped by the caller).
export function normalizeHost(value?: string | null): string {
  return String(value || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .split(':')[0] || ''
}

export function hostnameOf(host: string): string {
  return host?.split(':')[0] || ''
}

export function getPlatformHosts(env: TenantHostEnv): string[] {
  return Array.from(new Set([
    'localhost',
    '127.0.0.1',
    normalizeHost(env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN),
    normalizeHost(env.NUXT_PUBLIC_PLATFORM_DOMAIN),
  ].filter((value): value is string => Boolean(value))))
}

export function getPlatformHtmlCacheHosts(
  env: TenantHostEnv,
  extraHosts: (string | null | undefined)[] = [],
): string[] {
  return Array.from(new Set([
    ...extraHosts.map(normalizeHost),
    ...getPlatformHosts(env),
  ].filter((value): value is string => Boolean(value))))
}

export function isPlatformHost(host: string, env: TenantHostEnv): boolean {
  const hostname = hostnameOf(host)
  if (hostname === PAGES_DEV_HOST || hostname.endsWith(`.${PAGES_DEV_HOST}`)) {
    return true
  }
  return getPlatformHosts(env).includes(hostname)
}

export function isEnvironmentTenantAliasHost(host: string): boolean {
  return ENVIRONMENT_TENANT_ALIAS_HOST_PATTERN.test(
    hostnameOf(host).toLowerCase().replace(/\.$/, ''),
  )
}

export function environmentTenantAliasHostname(platformHost: string, tenantSlug: string): string {
  const hostname = hostnameOf(platformHost).toLowerCase().replace(/\.$/, '')
  const match = hostname.match(ENVIRONMENT_PLATFORM_HOST_PATTERN)
  if (!match || !TENANT_SLUG_PATTERN.test(tenantSlug)) return ''

  const [, environment, rootDomain] = match
  if (!environment || !rootDomain) return ''
  return `${tenantSlug}-${environment}.${rootDomain}`
}

export function environmentTenantAliasSlug(host: string, env: TenantHostEnv): string | null {
  const hostname = hostnameOf(host).toLowerCase().replace(/\.$/, '')
  const platformHost = normalizeHost(env.NUXT_PUBLIC_PLATFORM_DOMAIN).toLowerCase()
  const match = platformHost.match(ENVIRONMENT_PLATFORM_HOST_PATTERN)
  if (!match) return null

  const [, environment, rootDomain] = match
  if (!environment || !rootDomain) return null
  const suffix = `-${environment}.${rootDomain}`
  if (!hostname.endsWith(suffix)) return null

  const slug = hostname.slice(0, -suffix.length)
  return TENANT_SLUG_PATTERN.test(slug) ? slug : null
}

// Only hosts that cannot express tenant identity in their hostname use the
// test-only x-preview-tenant header. Deployed staging uses direct first-level
// tenant aliases instead.
export function usesTenantHeader(host: string): boolean {
  const hostname = hostnameOf(host).toLowerCase().replace(/\.$/, '')
  // A tenant is framed locally as <subdomain>.localhost, which is as
  // non-production as localhost itself. Missing that served every local page
  // from the public resource cache, so an edit appeared to change nothing.
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1'
}

// Returns true for non-production hosts: local development and Cloudflare Quick
// Tunnels, the staging environment, and its tenant aliases. This is about *which
// environment* a request is in — not about the preview of an unpublished site,
// which is server/utils/preview-token.ts and means one owner looking at their
// own site. Call usesTenantHeader() when deciding how tenant identity is
// transported; deployed aliases are non-production but resolve identity from
// their hostname.
export function isNonProductionHost(host: string): boolean {
  const hostname = hostnameOf(host).toLowerCase().replace(/\.$/, '')
  if (usesTenantHeader(hostname)) return true
  if (hostname === 'staging.krabiclaw.com') return true
  if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$/.test(hostname)) return true
  return isEnvironmentTenantAliasHost(hostname)
}

export function getFreeOrganizationDomain(env: TenantHostEnv): string {
  const domain = normalizeHost(env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)
  if (!domain) throw new Error('NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN is required')
  return domain
}
