/** The seeded businesses a fixture can belong to; see tests/e2e/seed. */
export type SeedTenantKey = 'restaurant' | 'experience' | 'legal'

/** Seeded local actors share one password; nothing here exists outside a local E2E database. */
export const E2E_PASSWORD = 'E2e-Local-Password-7!'

/** The platform administrator the seed bootstraps first and every default sign-in uses. */
export const E2E_ADMIN_ID = 'user-e2e-platform-admin'

export interface E2eAuthFixture {
  id: string
  name: string
  email: string
  phoneNumber?: string
  platformRole?: 'user' | 'admin'
  memberships?: Array<{
    tenant: SeedTenantKey
    role: 'owner' | 'admin'
  }>
}

// Phone numbers come from ACMA's reserved fictitious mobile range
// (+61 491 570 006 - 570 156), which is never assigned to a real subscriber.
// These were previously real customer numbers copied out of production, which
// collided on user.phoneNumber the moment a developer database held real rows.
// They were then Ofcom's drama range (+44 7700 900xxx), which libphonenumber
// reports as invalid — and a notification phone goes through parsePhoneOrThrow,
// so a fixture in that range cannot be one a tenant could have saved.
//
// A fixture's phoneNumber is where its WhatsApp owner alerts go: the member is
// the recipient, so a verified number on the account is the whole of the
// routing. The suite used to alert whichever number a location had configured,
// which meant it alerted whichever production number the snapshot happened to
// carry.
export const E2E_AUTH_FIXTURES: readonly E2eAuthFixture[] = [
  {
    id: 'user-e2e-platform-admin',
    name: 'E2E Platform Admin',
    email: 'platform-admin@playwright.example',
    platformRole: 'admin',
    memberships: [{ tenant: 'restaurant', role: 'owner' }, { tenant: 'experience', role: 'owner' }, { tenant: 'legal', role: 'owner' }],
  },
  {
    // A buyer with no organization: bookings, purchases, saved cards and account deletion.
    id: 'user-e2e-buyer',
    name: 'E2E Buyer',
    email: 'buyer@playwright.example',
  },
  {
    id: 'user-e2e-demo-owner',
    name: 'E2E Demo Owner',
    email: 'demo-owner@playwright.example',
    memberships: [{ tenant: 'restaurant', role: 'owner' }],
  },
  {
    id: 'user-e2e-demo-role-owner',
    name: 'E2E Demo Role Owner',
    email: 'demo-role-owner@playwright.example',
    memberships: [{ tenant: 'restaurant', role: 'owner' }],
  },
  {
    id: 'user-e2e-pottery-owner',
    name: 'E2E Pottery Owner',
    email: 'pottery-owner@playwright.example',
    phoneNumber: '+61491570006',
    memberships: [{ tenant: 'experience', role: 'owner' }],
  },
  {
    id: 'user-e2e-pottery-location-owner',
    name: 'E2E Pottery Location Owner',
    email: 'pottery-location-owner@playwright.example',
    memberships: [{ tenant: 'experience', role: 'owner' }],
  },
  {
    id: 'user-e2e-kikuzuki-owner',
    name: 'E2E Kikuzuki Owner',
    email: 'kikuzuki-owner@playwright.example',
    phoneNumber: '+61491570156',
    memberships: [{ tenant: 'restaurant', role: 'owner' }],
  },
  {
    id: 'user-e2e-ncls-owner',
    name: 'E2E NCLS Owner',
    email: 'ncls-owner@playwright.example',
    memberships: [{ tenant: 'legal', role: 'owner' }],
  },
  {
    id: 'user-e2e-ncls-consultation-owner',
    name: 'E2E NCLS Consultation Owner',
    email: 'ncls-consultation-owner@playwright.example',
    memberships: [{ tenant: 'legal', role: 'owner' }],
  },
  ...[
    'oauth-cimd',
    'oauth-private-cimd',
    // Drives the new-site wizard end to end, owning the organization it creates.
    'onboarding-wizard',
    // Signs in like the native app, with a bearer session and no cookies, and
    // owns the organization it creates for the lodging-identity spec.
    'lodging-native',
    // Joins that organization through an invite link.
    'lodging-invitee',
    // Owns the lodging organization the stays spec creates, with its homes and stays.
    'lodging-host',
    ...[
      'inaccessible',
      'wrong-site',
      'cross-a',
      'cross-b',
      'owner-reply',
    ].map(key => `mcp-fresh-${key}`),
  ].map((key) => ({
    id: `user-e2e-${key}`,
    name: `E2E ${key.replaceAll('-', ' ')}`,
    email: `${key}@playwright.example`,
  })),
]

export const DEFAULT_E2E_USER_ID = E2E_ADMIN_ID

export function findE2eAuthFixture(userId = DEFAULT_E2E_USER_ID): E2eAuthFixture {
  const fixture = E2E_AUTH_FIXTURES.find(candidate => candidate.id === userId)
  if (!fixture) {
    throw new Error(`No credentialed E2E fixture is registered for user ${userId}`)
  }
  return fixture
}
