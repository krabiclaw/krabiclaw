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
  const { platformOrganizationId } = await response.json() as { platformOrganizationId: string }
  return { admin: await SeedClient.signedIn(baseURL, admin.email, E2E_PASSWORD), platformOrganizationId }
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
  /** The KrabiClaw plan the business pays for; null stays on Basic. */
  subscription: 'growth' | 'business' | null
}

/**
 * Better Auth starts the owner's upgrade exactly as the dashboard does: it
 * gives the organization its Stripe test customer and an incomplete
 * subscription, and returns the Checkout Session. The seed then completes what
 * the owner would complete in Checkout: Stripe test mode creates the
 * subscription from the session's own items, paid with Stripe's test card, and Stripe's
 * checkout.session.completed reaches Better Auth's webhook, signed with the
 * local webhook secret, so Better Auth itself records the active plan.
 */
async function subscribe(baseURL: string, owner: SeedClient, organizationId: string, plan: 'growth' | 'business') {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey?.startsWith('sk_test_') && !secretKey?.startsWith('rk_test_')) throw new Error('The E2E seed needs a Stripe test-mode STRIPE_SECRET_KEY')
  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(secretKey)
  const session = await owner.auth<{ id: string; customer: string; metadata: Record<string, string> }>('subscription/upgrade', {
    plan, referenceId: organizationId, customerType: 'organization', disableRedirect: true,
    successUrl: `${baseURL}/dashboard`, cancelUrl: `${baseURL}/dashboard`,
  })
  const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ['data.price'] })
  const card = await stripe.paymentMethods.attach('pm_card_visa', { customer: session.customer })
  const subscription = await stripe.subscriptions.create({
    customer: session.customer, default_payment_method: card.id, metadata: session.metadata,
    items: items.data.map(item => item.price!.recurring?.usage_type === 'metered' ? { price: item.price!.id } : { price: item.price!.id, quantity: item.quantity ?? 1 }),
  })
  const payload = JSON.stringify({
    id: `evt_seed_${subscription.id}`, object: 'event', type: 'checkout.session.completed', api_version: '2025-08-27.basil',
    created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: { ...session, object: 'checkout.session', mode: 'subscription', status: 'complete', subscription: subscription.id } },
  })
  const signed = await fetch(`${baseURL}/api/dev/stripe-signature`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-route-secret': DEV_ROUTE_SECRET() }, body: JSON.stringify({ payload }),
  })
  if (signed.status !== 200) throw new Error(`Signing the Stripe event failed: ${signed.status} ${await signed.text()}`)
  const { signature } = await signed.json() as { signature: string }
  const delivered = await fetch(`${baseURL}/api/auth/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload })
  if (delivered.status !== 200) throw new Error(`Better Auth refused the Stripe event: ${delivered.status} ${await delivered.text()}`)
  const active = await owner.auth<Array<{ plan: string; status: string }>>(`subscription/list?referenceId=${organizationId}&customerType=organization`)
  if (!active.some(row => row.plan === plan && row.status === 'active')) throw new Error(`Better Auth did not record the ${plan} plan: ${JSON.stringify(active)}`)
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
  if (plan.subscription) await subscribe(baseURL, owner, organization.id, plan.subscription)
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
  const { admin, platformOrganizationId } = await bootstrapAdministrator(baseURL)
  try {
    await createActors(admin)
    const manifest: SeedManifest = { baseURL, adminUserId: E2E_ADMIN_ID, tenants: {} as SeedManifest['tenants'] }
    const create: CreateTenant = plan => createTenant(baseURL, plan)
    const [{ seedRestaurant }, { seedExperience }, { seedLegal }] = await Promise.all([
      import('./tenants/restaurant.ts'), import('./tenants/experience.ts'), import('./tenants/legal.ts'),
    ])
    manifest.tenants.restaurant = await seedRestaurant(create)
    manifest.tenants.experience = await seedExperience(create)
    manifest.tenants.legal = await seedLegal(create)
    const { seedTraffic } = await import('./traffic.ts')
    await seedTraffic(baseURL, manifest)
    const { seedPlatform } = await import('./tenants/platform.ts')
    await seedPlatform(admin, platformOrganizationId)
    // A booking made during the seed has to have ended before any test reads it as past.
    const ended = Math.max(0, ...Object.values(manifest.tenants).map(tenant => tenant.endedSessionEndsAt ? Date.parse(tenant.endedSessionEndsAt) : 0))
    if (ended > Date.now()) await new Promise(resolve => setTimeout(resolve, ended - Date.now() + 1_000))
    mkdirSync(new URL('.', SEED_MANIFEST_PATH), { recursive: true })
    writeFileSync(SEED_MANIFEST_PATH, JSON.stringify(manifest, null, 2))
    return manifest
  } finally { await admin.dispose() }
}

export type { TenantPlan }
export type CreateTenant = (plan: TenantPlan) => ReturnType<typeof createTenant>
