export interface E2eAuthFixture {
  id: string
  name: string
  email: string
  phoneNumber?: string
  platformRole?: 'user' | 'admin'
  memberships?: Array<{
    organizationId: string
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
    memberships: [{ organizationId: 'org-demo', role: 'owner' }],
  },
  {
    id: 'user-e2e-demo-role-owner',
    name: 'E2E Demo Role Owner',
    email: 'demo-role-owner@playwright.example',
    memberships: [{ organizationId: 'org-demo', role: 'owner' }],
  },
  {
    id: 'user-e2e-pottery-owner',
    name: 'E2E Pottery Owner',
    email: 'pottery-owner@playwright.example',
    phoneNumber: '+61491570006',
    memberships: [{ organizationId: 'org-user-pottery-house', role: 'owner' }],
  },
  {
    id: 'user-e2e-pottery-location-owner',
    name: 'E2E Pottery Location Owner',
    email: 'pottery-location-owner@playwright.example',
    memberships: [{ organizationId: 'org-user-pottery-house', role: 'owner' }],
  },
  {
    id: 'user-e2e-kikuzuki-owner',
    name: 'E2E Kikuzuki Owner',
    email: 'kikuzuki-owner@playwright.example',
    phoneNumber: '+61491570156',
    memberships: [{ organizationId: 'org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX', role: 'owner' }],
  },
  {
    id: 'user-e2e-ncls-owner',
    name: 'E2E NCLS Owner',
    email: 'ncls-owner@playwright.example',
    memberships: [{ organizationId: 'org-ncls-blawby', role: 'owner' }],
  },
  {
    id: 'user-e2e-ncls-consultation-owner',
    name: 'E2E NCLS Consultation Owner',
    email: 'ncls-consultation-owner@playwright.example',
    memberships: [{ organizationId: 'org-ncls-blawby', role: 'owner' }],
  },
  ...[
    'oauth-cimd',
    'oauth-private-cimd',
    // Drives the new-site wizard end to end; every run leaves it owning one more
    // organization, which reset-e2e-artifacts sweeps as a non-fixture org.
    'onboarding-wizard',
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

export const DEFAULT_E2E_USER_ID = 'user-e2e-demo-owner'

export function findE2eAuthFixture(userId = DEFAULT_E2E_USER_ID): E2eAuthFixture {
  const fixture = E2E_AUTH_FIXTURES.find(candidate => candidate.id === userId)
  if (!fixture) {
    throw new Error(`No credentialed E2E fixture is registered for user ${userId}`)
  }
  return fixture
}
