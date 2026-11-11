import { expect, test } from '@playwright/test'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { openSeating, seededTables, tableSeatings } from './helpers/tables'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, testBaseUrl } from './test-env'

const baseURL = testBaseUrl()
const writable = ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)

/**
 * A seating's places are its session's capacity, the same as a class's.
 * Session capacity and its races are proven directly in
 * tests/integration/availability-d1.test.ts; this is the guest's site.
 */
test('concurrent guests cannot claim the same final places at a seating', async ({ request }, testInfo) => {
  test.skip(!writable, 'Booking writes require disposable local or preview data')
  const restaurant = seededTenant('restaurant')
  const releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, restaurant.organizationId)
  try {
    // Two parties each ask for every place the seating has left: the claim carries its own
    // capacity predicate, so one lands and the other is told, never overbooked.
    const seating = await openSeating(request, 1, 3 * 86_400_000)
    const party = seating.remaining!
    expect(party).toBeGreaterThan(0)
    const attempt = Date.now()
    const results = await Promise.all([1, 2].map(guest => request.post(`${baseURL}/api/public/products/${seededTables().slug}/book`, {
      headers: seededSiteHeaders('restaurant'),
      data: {
        idempotency_key: crypto.randomUUID(), guest_name: `Last places guest ${guest}`, guest_email: `last-seat-${attempt}-${guest}@playwright.example`,
        guest_phone: '+66812345678', product_session_id: seating.id, party_size: party,
      },
    })))
    expect(results.map(result => result.status()).sort()).toEqual([201, 409])

    // The guest's own calendar, read back through the product's sessions, shows the seating full.
    const after = (await tableSeatings(request)).find(session => session.id === seating.id)
    expect(after).toMatchObject({ remaining: 0, is_full: true })
  } finally {
    await releaseTenantMutationLock()
  }
})
