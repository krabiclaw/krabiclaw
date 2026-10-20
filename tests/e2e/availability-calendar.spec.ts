import { expect, test } from '@playwright/test'
import { loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { devLoginHeaders, E2E_DEMO_ORGANIZATION_ID, tenantTestExtraHeaders, testBaseUrl } from './test-env'

const baseURL = testBaseUrl()
const writable = ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)
const availabilityUrl = `${baseURL}/api/editor/organizations/org-demo/locations/loc-demo/reservation-availability`
const configUrl = `${baseURL}/api/editor/organizations/org-demo/locations/loc-demo/reservation-config`

interface Slot { time_slot: string; capacity: number | null; claimed: number; remaining: number | null; is_closed: boolean; is_full: boolean }
interface Day { date: string; timezone: string; slots: Slot[] }

/**
 * The reservation calendar covers a LOCATION and nothing else.
 *
 * A Product's occurrences are real session rows with their own screen. Session
 * capacity and its races are proven directly in
 * tests/integration/availability-d1.test.ts.
 */
test('concurrent guests cannot claim the same final reservation seat', async ({ page, request }, testInfo) => {
  test.skip(!writable, 'Booking writes require disposable local or preview data')
  // The demo location's reservation capacity is shared with the MCP reservation specs.
  const releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, E2E_DEMO_ORGANIZATION_ID)
  try {
    await loginAs(page.request, baseURL)
    const today = new Date()
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 21)).toISOString().slice(0, 10)

    const original = await page.request.get(configUrl)
    expect(original.status()).toBe(200)
    const priorPolicy = (await original.json()).config
    const priorDuration = priorPolicy.duration_minutes
    const duration = await page.request.put(configUrl, { data: { duration_minutes: 60, expected_updated_at: priorPolicy.updated_at } })
    expect(duration.status(), await duration.text()).toBe(200)

    const read = await page.request.get(availabilityUrl, { params: { from: date, to: date }, headers: devLoginHeaders() ?? {} })
    expect(read.status(), await read.text()).toBe(200)
    const { days }: { days: Day[] } = await read.json()
    const slot = days[0]!.slots.find(entry => !entry.is_closed)
    expect(slot, `loc-demo offers no open reservation slot on ${date}`).toBeTruthy()

    // One seat left, two guests: the claim carries its own capacity predicate,
    // so one lands and the other is told, never overbooked. Seats are the
    // location's standing capacity — the only place a reservation's capacity
    // comes from.
    const priorConfig = await page.request.get(configUrl, { headers: devLoginHeaders() ?? {} })
    expect(priorConfig.status(), await priorConfig.text()).toBe(200)
    const configuredPolicy = (await priorConfig.json()).config
    const priorCapacity = configuredPolicy.slot_capacity

    const capacity = slot!.claimed + 1
    const configured = await page.request.put(configUrl, {
      headers: devLoginHeaders() ?? {},
      data: { slot_capacity: capacity, expected_updated_at: configuredPolicy.updated_at },
    })
    expect(configured.status(), await configured.text()).toBe(200)

    try {
      const attempt = Date.now()
      const results = await Promise.all([1, 2].map(guest => request.post(`${baseURL}/api/public/reservations`, {
        headers: tenantTestExtraHeaders(),
        data: {
          idempotency_key: crypto.randomUUID(),
          name: `Last seat guest ${guest}`,
          email: `last-seat-${attempt}-${guest}@playwright.example`,
          phone: '+66812345678',
          location_id: 'loc-demo',
          date,
          time: slot!.time_slot,
          guests: '1',
        },
      })))
      expect(results.map(result => result.status()).sort()).toEqual([201, 409])

      const final = await page.request.get(availabilityUrl, { params: { from: date, to: date }, headers: devLoginHeaders() ?? {} })
      const { days: finalDays }: { days: Day[] } = await final.json()
      expect(finalDays[0]!.slots.find(entry => entry.time_slot === slot!.time_slot)).toMatchObject({
        capacity, remaining: 0, is_full: true, is_closed: false,
      })
    } finally {
      // The standing capacity is the location's, not this test's.
      const current = await page.request.get(configUrl)
      expect(current.status()).toBe(200)
      const restored = await page.request.put(configUrl, { headers: devLoginHeaders() ?? {}, data: { slot_capacity: priorCapacity, duration_minutes: priorDuration, expected_updated_at: (await current.json()).config.updated_at } })
      expect(restored.status(), await restored.text()).toBe(200)
    }
  } finally {
    await releaseTenantMutationLock()
  }
})
