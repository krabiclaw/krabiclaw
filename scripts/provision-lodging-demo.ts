#!/usr/bin/env node
// Creates, or resets, the lodging demo: "Saltleaf Stays", a vacation-rental
// business with four homes on its Saya site.
//
//   node --env-file=.env --experimental-strip-types scripts/provision-lodging-demo.ts --staging
//   node --env-file=.env --experimental-strip-types scripts/provision-lodging-demo.ts --production
//
// Staging signs in as the development owner (KRABICLAW_DEV_EMAIL and
// KRABICLAW_DEV_PASSWORD) and books stays through test-mode Stripe Connect.
// Production signs in as the app-review account (CANARY_LOGIN_EMAIL and
// CANARY_LOGIN_PASSWORD); with no online payments there its homes take
// enquiries. Either way it uses the same endpoints the
// dashboard and the native app use, so every write goes through the canonical
// domain code. Re-running it is the reset: the homes get their details, prices
// and blocked nights back, and the stays booked on them are cancelled. The
// site's own location holds no home, so it is set inactive and takes no plan
// location. Lapsed
// checkout holds need nothing: the calendar reads them as free and the next
// hold on those nights clears them.
//
// Billing is the owner's, in a browser, because financial approvals are
// same-origin browser actions: the Commerce plan for four locations (the four
// homes) on both, and on staging the test-mode Stripe Connect onboarding
// (docs/operations/lodging-demo.md). Until the plan covers four locations the
// script stops before adding the next home, naming what is missing.

import { parseArgs } from 'node:util'
import type { StayPropertyType, StayPropertyTypeGroup } from '../shared/stay-listing.ts'

const DEMO = {
  name: 'Saltleaf Stays',
  // shared/demo.ts names this subdomain as a demo organization.
  slug: 'saltleaf-stays-demo',
  currency: 'USD',
  timezone: 'America/Los_Angeles',
  sourceLocale: 'en',
} as const

interface DemoHome {
  key: string
  name: string
  timezone: string
  address: string
  city: string
  state: string | null
  country: string
  zip_code: string | null
  check_in_time: string
  check_out_time: string
  max_guests: number
  min_nights: number
  base_price_minor: number
  weekend_price_minor: number
  holiday_price_minor: number
  description: string
  property_type_group: StayPropertyTypeGroup
  property_type: StayPropertyType
  bedrooms: number
  beds: number
  bathrooms: number
  amenities: string[]
  cancellation_policy: 'flexible' | 'moderate' | 'firm'
  check_in_method: 'in_person' | 'lockbox' | 'keypad' | 'smart_lock'
  check_in_instructions: string
  /** Nights closed for owner use, as days from today. */
  blocked: Array<[number, number]>
}

const HOMES: DemoHome[] = [
  {
    // The staging post-deploy stay test books through this home's listing,
    // /stays/saltleaf-ocean-avenue-studio, from the site's homepage: keep its
    // name, which is its slug, and keep it featured there.
    key: 'santa-monica',
    name: 'Saltleaf Ocean Avenue Studio',
    timezone: 'America/Los_Angeles',
    address: '100 Ocean Avenue',
    city: 'Santa Monica',
    state: 'CA',
    country: 'US',
    zip_code: '90401',
    check_in_time: '15:00',
    check_out_time: '11:00',
    max_guests: 2,
    min_nights: 2,
    base_price_minor: 12_000,
    weekend_price_minor: 14_500,
    holiday_price_minor: 17_500,
    description: 'A bright studio for two a short walk from the beach, with a queen bed, a kitchenette, fast Wi-Fi and a desk.',
    property_type_group: 'apartments', property_type: 'apartment',
    bedrooms: 0,
    beds: 1,
    bathrooms: 1,
    amenities: ['wireless_internet', 'laptop_friendly_workspace', 'ac', 'kitchen', 'refrigerator', 'microwave', 'coffee_maker', 'cooking_basics', 'dishes_and_silverware', 'tv', 'beach_access', 'hot_water', 'essentials', 'bed_linens', 'smoke_detector', 'carbon_monoxide_detector', 'fire_extinguisher', 'first_aid_kit'],
    cancellation_policy: 'moderate',
    check_in_method: 'smart_lock',
    check_in_instructions: 'Check-in is from 15:00. Your door code for the smart lock arrives by message on your arrival day; enter it on the keypad and press the lock button.',
    blocked: [],
  },
  {
    key: 'ao-nang',
    name: 'Saltleaf Ao Nang Pool Villa',
    timezone: 'Asia/Bangkok',
    address: 'Ao Nang Beach Road',
    city: 'Krabi',
    state: 'Krabi',
    country: 'TH',
    zip_code: '81180',
    check_in_time: '15:00',
    check_out_time: '11:00',
    max_guests: 6,
    min_nights: 2,
    base_price_minor: 18_500,
    weekend_price_minor: 22_000,
    holiday_price_minor: 26_500,
    description: 'Three bedrooms around a private saltwater pool, ten minutes on foot from Ao Nang beach.',
    property_type_group: 'houses', property_type: 'house',
    bedrooms: 3,
    beds: 4,
    bathrooms: 3,
    amenities: ['wireless_internet', 'ac', 'pool', 'kitchen', 'washer', 'free_parking', 'patio_or_belcony', 'bbq_area', 'hot_water', 'essentials', 'smoke_detector', 'first_aid_kit'],
    cancellation_policy: 'moderate',
    check_in_method: 'in_person',
    check_in_instructions: 'Collect your keys from the Saltleaf guest desk on Ao Nang Beach Road between 15:00 and 21:00. The villa gate code is sent the morning you arrive.',
    blocked: [[20, 23], [61, 64]],
  },
  {
    key: 'canggu',
    name: 'Saltleaf Canggu Rice-Field Loft',
    timezone: 'Asia/Makassar',
    address: 'Jalan Pantai Batu Bolong',
    city: 'Canggu',
    state: 'Bali',
    country: 'ID',
    zip_code: '80361',
    check_in_time: '14:00',
    check_out_time: '11:00',
    max_guests: 2,
    min_nights: 3,
    base_price_minor: 9_500,
    weekend_price_minor: 11_500,
    holiday_price_minor: 14_000,
    description: 'A one-bedroom loft with a desk, fast Wi-Fi and a balcony over the rice fields, a short ride from Batu Bolong beach.',
    property_type_group: 'apartments', property_type: 'apartment',
    bedrooms: 1,
    beds: 1,
    bathrooms: 1,
    amenities: ['wireless_internet', 'laptop_friendly_workspace', 'ac', 'kitchen', 'coffee_maker', 'long_term_stays_allowed', 'hot_water', 'essentials', 'smoke_detector'],
    cancellation_policy: 'flexible',
    check_in_method: 'lockbox',
    check_in_instructions: 'Self check-in: the lockbox is beside the blue door at the top of the stairs. Its code arrives by message on your arrival day.',
    blocked: [[30, 34]],
  },
  {
    key: 'tulum',
    name: 'Saltleaf Tulum Jungle Casita',
    timezone: 'America/Cancun',
    address: 'Avenida Tulum',
    city: 'Tulum',
    state: 'Quintana Roo',
    country: 'MX',
    zip_code: '77760',
    check_in_time: '16:00',
    check_out_time: '10:00',
    max_guests: 4,
    min_nights: 2,
    base_price_minor: 14_000,
    weekend_price_minor: 16_500,
    holiday_price_minor: 21_000,
    description: 'Two bedrooms and a plunge pool under the palms, with bikes for the ride to the beach.',
    property_type_group: 'secondary_units', property_type: 'guesthouse',
    bedrooms: 2,
    beds: 2,
    bathrooms: 2,
    amenities: ['wireless_internet', 'ac', 'pool', 'kitchen', 'alfresco_shower', 'alfresco_dining', 'beach_access', 'hot_water', 'essentials', 'smoke_detector', 'fire_extinguisher'],
    cancellation_policy: 'firm',
    check_in_method: 'keypad',
    check_in_instructions: 'The casita door has a keypad. Its code arrives by message on your arrival day; send your arrival time through your booking messages a day ahead.',
    blocked: [[45, 49]],
  },
]

/** Nights reset and priced ahead of today: past every far-future smoke test. */
const CALENDAR_DAYS = 500
const WEEKEND_WEEKS = 26

class StepError extends Error {}

const { values } = parseArgs({ options: { staging: { type: 'boolean' }, production: { type: 'boolean' } }, strict: true })
if (values.staging === values.production) throw new StepError('Pass exactly one of --staging or --production.')
const TARGET = values.production
  ? { base: 'https://krabiclaw.com', site: `https://${DEMO.slug}.krabiclaw.com`, email: 'CANARY_LOGIN_EMAIL', password: 'CANARY_LOGIN_PASSWORD', owner: 'the production app-review account' }
  : { base: 'https://staging.krabiclaw.com', site: `https://${DEMO.slug}-staging.krabiclaw.com`, email: 'KRABICLAW_DEV_EMAIL', password: 'KRABICLAW_DEV_PASSWORD', owner: 'the staging development owner' }
const BASE = TARGET.base
const email = process.env[TARGET.email]
const password = process.env[TARGET.password]
if (!email || !password) throw new StepError(`Set ${TARGET.email} and ${TARGET.password} to ${TARGET.owner}.`)

const cookies = new Map<string, string>()

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, expected: number[] = [200]): Promise<{ status: number; data: T }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      origin: BASE,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';')
    const index = pair!.indexOf('=')
    cookies.set(pair!.slice(0, index), pair!.slice(index + 1))
  }
  const text = await response.text()
  const data = (text ? JSON.parse(text) : null) as T
  if (!expected.includes(response.status)) throw Object.assign(new StepError(`${method} ${path} returned ${response.status}: ${text.slice(0, 600)}`), { status: response.status, data })
  return { status: response.status, data }
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function today(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

interface Home { product_id: string; name: string; location_id: string; base_price_minor: number | null }
interface Location { id: string; title: string; status: string }
interface Stay { id: string; product_id: string; status: string; version: number; check_in_date: string; check_out_date: string }

async function organization(): Promise<{ id: string; slug: string }> {
  const listed = await call<{ organizations: Array<{ id: string; slug: string; onboarding_status: string }> }>('GET', '/api/organizations')
  let found = listed.data.organizations.find(row => row.slug === DEMO.slug)
  if (!found) {
    const created = await call<{ id: string; slug: string }>('POST', '/api/auth/organization/create', {
      name: DEMO.name, slug: DEMO.slug, default_currency: DEMO.currency, timezone: DEMO.timezone, keepCurrentActiveOrganization: true,
    })
    console.log(`Created organization ${created.data.id}`)
    found = { id: created.data.id, slug: created.data.slug, onboarding_status: 'pending' }
  }
  if (found.onboarding_status !== 'active') {
    await call('POST', '/api/organizations', { organizationId: found.id, name: DEMO.name, subdomain: DEMO.slug, vertical: 'lodging', sourceLocale: DEMO.sourceLocale })
    console.log(`Provisioned ${DEMO.slug} as a lodging site`)
  }
  return { id: found.id, slug: found.slug }
}

async function main() {
  await call('POST', '/api/auth/sign-in/email', { email, password, rememberMe: false })
  const org = await organization()
  const q = `org=${encodeURIComponent(org.slug)}`
  console.log(`Organization ${DEMO.name}: ${org.id}`)

  const homes = new Map<string, Home>()
  for (const home of (await call<{ homes: Home[] }>('GET', `/api/dashboard/stay-homes?${q}`)).data.homes) homes.set(home.name, home)
  // Only active locations take a plan location. The site's own location, made
  // with the organization, holds no home, so it goes inactive before the homes
  // are added; each home's location is titled after its home.
  const homeLocations = new Set([...homes.values()].map(home => home.location_id))
  for (const location of (await call<{ locations: Location[] }>('GET', `/api/dashboard/locations?organization=true&status=all&${q}`)).data.locations) {
    if (homeLocations.has(location.id) || location.status !== 'active') continue
    await call('PATCH', `/api/dashboard/locations/${location.id}?${q}`, { status: 'inactive' })
    console.log(`Set ${location.title} inactive: it holds no home`)
  }
  // A plan short of four locations stops new homes; the ones that exist still get their details.
  let planShort: { name: string; refusal: unknown } | null = null
  for (const spec of HOMES) {
    if (homes.has(spec.name)) continue
    const created = await call<{ home: Home }>('POST', `/api/dashboard/stay-homes?${q}`, {
      idempotency_key: `lodging-demo:${org.id}:${spec.key}`,
      name: spec.name, timezone: spec.timezone, address: spec.address, city: spec.city, state: spec.state, country: spec.country, zip_code: spec.zip_code,
      phone: null, email: null, check_in_time: spec.check_in_time, check_out_time: spec.check_out_time,
      max_guests: spec.max_guests, min_nights: spec.min_nights, base_price_minor: spec.base_price_minor,
    }, [201, 402])
    if (created.status === 402) {
      planShort = { name: spec.name, refusal: created.data }
      break
    }
    homes.set(spec.name, created.data.home)
    console.log(`Added ${spec.name}`)
  }

  for (const spec of HOMES) {
    const home = homes.get(spec.name)
    if (!home) continue
    await call('PATCH', `/api/dashboard/stay-homes/${home.product_id}?${q}`, {
      description: spec.description, timezone: spec.timezone, check_in_time: spec.check_in_time, check_out_time: spec.check_out_time,
      max_guests: spec.max_guests, min_nights: spec.min_nights, base_price_minor: spec.base_price_minor,
      address: { address: spec.address, city: spec.city, state: spec.state, country: spec.country, zip_code: spec.zip_code },
      property_type_group: spec.property_type_group, property_type: spec.property_type, bedrooms: spec.bedrooms, beds: spec.beds, bathrooms: spec.bathrooms, amenities: spec.amenities,
      cancellation_policy: spec.cancellation_policy, check_in_method: spec.check_in_method, check_in_instructions: spec.check_in_instructions,
      checkout_instructions: [{ task: 'gather_towels', details: null }, { task: 'turn_off', details: 'Air conditioning and lights' }, { task: 'lock_up', details: null }],
    })
    const location = (await call<{ location: Location }>('GET', `/api/dashboard/locations/${home.location_id}?${q}`)).data.location
    if (location.title !== spec.name) {
      await call('PATCH', `/api/dashboard/locations/${home.location_id}?${q}`, { title: spec.name })
      console.log(`Titled ${location.title} location ${spec.name}`)
    }

    const start = today(spec.timezone)
    const end = addDays(start, CALENDAR_DAYS)
    // A stay list spans at most 400 days, and stays can be booked up to 500 ahead.
    const stays = new Map<string, Stay>()
    for (const [from, to] of [[start, addDays(start, 400)], [addDays(start, 400), end]]) {
      for (const stay of (await call<{ stays: Stay[] }>('GET', `/api/dashboard/stays?${q}&from=${from}&to=${to}&product_id=${home.product_id}`)).data.stays) stays.set(stay.id, stay)
    }
    for (const stay of [...stays.values()].filter(row => row.status !== 'cancelled')) {
      await call('POST', `/api/dashboard/stays/${stay.id}/cancel?${q}`, { expected_version: stay.version, reason: 'Lodging demo reset' })
      console.log(`Cancelled stay ${stay.id} (${stay.check_in_date} to ${stay.check_out_date}) at ${spec.name}`)
    }

    const nights = (body: Record<string, unknown>) => call('PUT', `/api/dashboard/stay-homes/${home.product_id}/nights?${q}`, body)
    await nights({ from: start, to: end, reset: true })
    // Friday and Saturday nights cost more for the next six months, starting
    // with this weekend's Saturday when the reset runs on one.
    const friday = addDays(start, -((new Date(`${start}T00:00:00Z`).getUTCDay() + 2) % 7))
    for (let week = 0; week < WEEKEND_WEEKS; week++) {
      const weekend = addDays(friday, week * 7)
      const from = weekend < start ? start : weekend
      const to = addDays(weekend, 2)
      if (from < to) await nights({ from, to, price_minor: spec.weekend_price_minor })
    }
    // Every year-end holiday in the window, the current one included: a higher
    // price and a five-night minimum on arrival.
    for (let year = Number(start.slice(0, 4)) - 1; year <= Number(end.slice(0, 4)); year++) {
      const from = `${year}-12-20` < start ? start : `${year}-12-20`
      const to = `${year + 1}-01-03` > end ? end : `${year + 1}-01-03`
      if (from < to) await nights({ from, to, price_minor: spec.holiday_price_minor, min_stay_arrival: 5 })
    }
    for (const [from, to] of spec.blocked) await nights({ from: addDays(start, from), to: addDays(start, to), closed: true })
    console.log(`Reset ${spec.name}: ${start} to ${end}, weekends ${spec.weekend_price_minor / 100}, holidays ${spec.holiday_price_minor / 100}, ${spec.blocked.length} blocked run(s)`)
  }

  if (planShort) {
    throw new StepError(`Adding ${planShort.name} needs a plan that covers four locations (the four homes): ${JSON.stringify(planShort.refusal)}. Choose Commerce for 4 locations at ${BASE}/dashboard/${DEMO.slug}/payments?tab=plan, then run this again.`)
  }
  const unpublished: Array<{ name: string; missing: unknown }> = []
  for (const spec of HOMES) {
    const home = homes.get(spec.name)!
    const published = await call<{ data?: { missing?: unknown } }>('PATCH', `/api/dashboard/stay-homes/${home.product_id}?${q}`, { published: true }, [200, 409])
    if (published.status === 409) unpublished.push({ name: spec.name, missing: published.data })
  }
  if (unpublished.length) {
    throw new StepError(`Homes are ready but not published, because online payments are not ready: ${JSON.stringify(unpublished[0]!.missing)}. Finish Payments setup (docs/operations/lodging-demo.md), then run this again.`)
  }
  console.log(`Published ${HOMES.length} homes. Site: ${TARGET.site}`)
}

try {
  await main()
} catch (error) {
  // A step that cannot go on says which and why; the script is safe to run again.
  if (!(error instanceof StepError)) throw error
  console.error(error.message)
  process.exitCode = 1
}
