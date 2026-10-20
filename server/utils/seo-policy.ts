import { TENANT_TYPES, type TenantType } from '../../utils/tenant-routing.ts'
import { TENANT_NON_INDEXABLE_EXACT_PATHS } from '../../utils/template-registry.ts'
import { isEnvironmentTenantAliasHost } from './tenant-hosts.ts'
import { isDemoHost, isDemoOrganization } from '../../shared/demo.ts'

/**
 * The platform routes that hold no page document: each renders its own data.
 * KrabiClaw's editorial marketing pages are not here —
 * they are published page documents, and the sitemap reads them from
 * content_documents so there is one inventory rather than two (#903).
 */
export const PLATFORM_SITEMAP_ROUTES = [
  '/blog',
  '/docs',
  '/help',
  '/templates',
  '/templates/blawby',
  '/templates/saya',
] as const

export const PRIVATE_ROUTE_PREFIXES = [
  '/api',
  '/auth',
  '/dashboard',
  '/dev',
  '/oauth',
  '/transfer',
] as const

export const PRIVATE_EXACT_ROUTES = new Set([
  ...TENANT_NON_INDEXABLE_EXACT_PATHS,
  '/accept-invitation',
  '/forgot-password',
  '/login',
  '/reset-password',
  '/signup',
])

// Paths that only a customer site answers. `/experiences` is not among them:
// on KrabiClaw's own host it is the published marketing page that sells the
// booking product (#903). Its subtree stays tenant-only — an individual
// experience belongs to a customer's catalog.
export const TENANT_ONLY_EXACT_ROUTES = new Set([
  '/contact',
  '/locations',
  '/menu',
  '/photos',
  '/qa',
  '/reservations',
  '/reviews',
  '/stays',
])

export const TENANT_ONLY_ROUTE_PREFIXES = [
  '/bookings/',
  '/contact/',
  '/experiences/',
  '/locations/',
  '/menu/',
  '/order/',
  '/pay/',
  '/photos/',
  '/qa/',
  '/reservations/',
  '/reviews/',
  '/stays/',
] as const

export interface RuntimeSeoConfig {
  url: string
  indexable: boolean
  name?: string
}

export function isPrivateSeoPath(pathname: string): boolean {
  if (PRIVATE_EXACT_ROUTES.has(pathname)) return true
  return PRIVATE_ROUTE_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export function isTenantOnlySeoPath(pathname: string): boolean {
  return TENANT_ONLY_EXACT_ROUTES.has(pathname)
    || TENANT_ONLY_ROUTE_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

export function isNonIndexableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'staging.krabiclaw.com'
    || isDemoHost(host)
    || isEnvironmentTenantAliasHost(host)
    || host.endsWith('.pages.dev')
    || host.endsWith('.workers.dev')
}

export function resolveRuntimeSeoConfig(input: {
  tenantType?: TenantType | null
  origin: string
  hostname: string
  tenantName?: string | null
  tenantSubdomain?: string | null
}): RuntimeSeoConfig {
  const indexable = !isNonIndexableHost(input.hostname) && !isDemoOrganization({ subdomain: input.tenantSubdomain })

  if (!indexable) {
    return {
      url: input.origin,
      indexable: false,
    }
  }

  if (input.tenantType === TENANT_TYPES.TENANT) {
    const name = String(input.tenantName || '').trim()
    return {
      url: input.origin,
      indexable: true,
      ...(name ? { name } : {}),
    }
  }

  if (input.tenantType === TENANT_TYPES.PLATFORM) {
    return {
      name: 'KrabiClaw',
      url: input.origin,
      indexable: true,
    }
  }

  return {
    url: input.origin,
    indexable: false,
  }
}
