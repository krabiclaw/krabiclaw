import { environmentTenantAliasHostname, normalizeHost } from '~/server/utils/tenant-hosts'

/**
 * Where a site lives, from the browser's point of view.
 *
 * Production and local development address a site as `<subdomain>.<free site
 * domain>`. Staging cannot: its free-site domain is the production one, and
 * Cloudflare's universal certificate does not cover a second-level wildcard, so
 * staging gives every tenant a first-level alias instead —
 * `<subdomain>-staging.krabiclaw.com`. Building the host by hand gets this
 * wrong in exactly the way that makes a staging preview frame the
 * production site, so every surface that needs a site's origin (the onboarding
 * pane, the page editor's preview, the dashboard's live-site links) calls this.
 */
export function tenantOrganizationOrigin(input: {
  platformDomain: string
  freeOrganizationDomain: string
  subdomain: string
  canonicalDomain?: string | null
}): string {
  const subdomain = input.subdomain.trim().toLowerCase()
  const freeOrganizationHost = input.freeOrganizationDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const protocol = input.freeOrganizationDomain.startsWith('http://') ? 'http:' : 'https:'
  const canonicalHost = normalizeHost(input.canonicalDomain)
  if (canonicalHost && canonicalHost === normalizeHost(input.freeOrganizationDomain)) {
    return input.platformDomain.replace(/\/$/, '')
  }

  // Deployed staging: a first-level alias off the production root.
  // normalizeHost first: environmentTenantAliasHostname takes a hostname, and
  // a configured value is a full URL.
  const alias = environmentTenantAliasHostname(normalizeHost(input.platformDomain), subdomain)
  if (alias) return `${protocol}//${alias}`

  if (canonicalHost) return `https://${canonicalHost}`
  if (!freeOrganizationHost) return ''
  if (!subdomain) return ''
  return `${protocol}//${subdomain}.${freeOrganizationHost}`
}
