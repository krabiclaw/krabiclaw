import { mkdirSync, writeFileSync } from 'node:fs'
import { E2E_ADMIN_ID, E2E_AUTH_FIXTURES, E2E_PASSWORD, findE2eAuthFixture, type SeedTenantKey } from '../../../config/development-auth-fixtures.ts'
import { SeedClient } from './client.ts'
import { SEED_MANIFEST_PATH, type SeedManifest, type SeedTenant } from './manifest.ts'

// Builds the synthetic businesses pull-request E2E runs on, from an empty
// migrated local D1, through the application's own boundaries. Nothing here is
// copied from production; every row exists because an owner action made it.

const DEV_ROUTE_SECRET = () => {
  const secret = process.env.E2E_DEV_ROUTE_SECRET
  if (!secret) throw new Error('E2E_DEV_ROUTE_SECRET is required to bootstrap the local administrator')
  return secret
}

async function bootstrapAdministrator(baseURL: string) {
  const admin = findE2eAuthFixture(E2E_ADMIN_ID)
  const response = await fetch(`${baseURL}/api/dev/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-route-secret': DEV_ROUTE_SECRET(), origin: baseURL },
    body: JSON.stringify({ admin: { id: admin.id, email: admin.email, name: admin.name, password: E2E_PASSWORD } }),
  })
  if (response.status !== 201) throw new Error(`Bootstrapping the administrator and platform site failed: ${response.status} ${await response.text()}`)
  return SeedClient.signedIn(baseURL, admin.email, E2E_PASSWORD)
}

async function createActors(admin: SeedClient) {
  for (const fixture of E2E_AUTH_FIXTURES) {
    if (fixture.id === E2E_ADMIN_ID) continue
    const created = await admin.auth<{ user: { id: string } }>('admin/create-user', {
      email: fixture.email, name: fixture.name, password: E2E_PASSWORD, role: fixture.platformRole ?? 'user',
      data: { id: fixture.id, emailVerified: true, ...(fixture.phoneNumber ? { phoneNumber: fixture.phoneNumber, phoneNumberVerified: true } : {}) },
    })
    if (created.user.id !== fixture.id) throw new Error(`Better Auth did not keep the requested ID for ${fixture.email}`)
  }
}

interface TenantPlan {
  key: SeedTenantKey
  name: string
  slug: string
  subdomain: string
  vertical: 'restaurant' | 'experience' | 'service' | 'lodging'
  currency: string
  timezone: string
}

/** The first owner listed for a tenant creates it; every other fixture member joins by invitation. */
async function createTenant(baseURL: string, plan: TenantPlan): Promise<{ owner: SeedClient; tenant: SeedTenant }> {
  const members = E2E_AUTH_FIXTURES.filter(fixture => fixture.memberships?.some(membership => membership.tenant === plan.key))
  const creator = members.find(fixture => fixture.id !== E2E_ADMIN_ID) ?? findE2eAuthFixture(E2E_ADMIN_ID)
  const owner = await SeedClient.signedIn(baseURL, creator.email, E2E_PASSWORD)
  const organization = await owner.auth<{ id: string }>('organization/create', {
    name: plan.name, slug: plan.slug, default_currency: plan.currency, timezone: plan.timezone,
  })
  await owner.json('POST', '/api/organizations', { organizationId: organization.id, name: plan.name, subdomain: plan.subdomain, vertical: plan.vertical, sourceLocale: 'en' })
  await owner.auth('organization/set-active', { organizationId: organization.id })
  for (const fixture of members) {
    if (fixture.id === creator.id) continue
    const role = fixture.memberships!.find(membership => membership.tenant === plan.key)!.role
    const invitation = await owner.auth<{ id: string }>('organization/invite-member', { organizationId: organization.id, email: fixture.email, role })
    const member = await SeedClient.signedIn(baseURL, fixture.email, E2E_PASSWORD)
    try {
      await member.auth('organization/accept-invitation', { invitationId: invitation.id })
    } finally { await member.dispose() }
  }
  const { members: roster } = await owner.auth<{ members: Array<{ id: string; userId: string }> }>(`organization/list-members?organizationId=${organization.id}&limit=100`)
  const memberIds = Object.fromEntries(roster.map(member => [member.userId, member.id]))
  return {
    owner,
    tenant: { key: plan.key, organizationId: organization.id, name: plan.name, slug: plan.slug, subdomain: plan.subdomain, vertical: plan.vertical, currency: plan.currency, timezone: plan.timezone, memberIds, locations: {}, products: {}, media: {}, collections: {}, categories: {} },
  }
}

export async function seedE2e(baseURL: string) {
  const admin = await bootstrapAdministrator(baseURL)
  try {
    await createActors(admin)
    const manifest: SeedManifest = { baseURL, adminUserId: E2E_ADMIN_ID, tenants: {} as SeedManifest['tenants'] }
    const { seedRestaurant } = await import('./tenants/restaurant.ts')
    manifest.tenants.restaurant = await seedRestaurant((plan: TenantPlan) => createTenant(baseURL, plan))
    mkdirSync(new URL('.', SEED_MANIFEST_PATH), { recursive: true })
    writeFileSync(SEED_MANIFEST_PATH, JSON.stringify(manifest, null, 2))
    return manifest
  } finally { await admin.dispose() }
}

export type { TenantPlan }
export type CreateTenant = (plan: TenantPlan) => ReturnType<typeof createTenant>
