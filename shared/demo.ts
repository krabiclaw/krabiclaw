/**
 * Canonical demo organization and host contracts.
 *
 * Demo organizations are synthetic showcase businesses, not real ones: the
 * "Ember & Slice" restaurant (production, copied to staging by snapshot), the
 * "Saltleaf Stays" lodging demo that scripts/provision-lodging-demo.ts
 * creates, and the "Cedar Legal Demo" law office that shows a paid legal
 * consultation from booking to payment. Their data is non-customer demo data,
 * only platform admins change their site settings and languages, they are never crawled or indexed, and
 * their payments run in Stripe test mode, on production too, so a visitor can
 * pay with a test card and nothing is charged.
 *
 * They are named by subdomain, not id.
 */

export const DEMO_SUBDOMAINS = new Set([
  'demo',
  'saltleaf-stays-demo',
  'cedar-legal-demo',
])

export const DEMO_HOSTS = new Set([
  'demo.krabiclaw.com',
  'demo.localhost',
  'cedar-legal-demo.krabiclaw.com',
  'cedar-legal-demo.localhost',
])

export function isDemoOrganization(organization?: { subdomain?: string | null } | null): boolean {
  return Boolean(organization?.subdomain && DEMO_SUBDOMAINS.has(organization.subdomain))
}

export function isDemoHost(host?: string | null): boolean {
  if (!host) return false
  const hostname = host.toLowerCase().replace(/\.$/, '').split(':')[0] || ''
  return DEMO_HOSTS.has(hostname)
}
