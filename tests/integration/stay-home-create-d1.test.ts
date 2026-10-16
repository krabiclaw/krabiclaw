import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import createHomeRoute from '../../server/api/dashboard/stay-homes/index.post.ts'
import listHomesRoute from '../../server/api/dashboard/stay-homes/index.get.ts'
import editHomeRoute from '../../server/api/dashboard/stay-homes/[productId].patch.ts'
import { getLocation } from '../../server/utils/location-management.ts'
import { getProduct } from '../../server/utils/product-management.ts'
import { createStayHome, stayHomeInput } from '../../server/domain/stays.ts'

// A home added by hand through the native app's route: its details are
// checked field by field, it becomes a new location and an unpublished stay,
// its key replays it, plan location billing applies, and only managers add one.
// Its details, time zone and who looks after it are then changed the same way.

const ORG = 'org'
const BASE = 'https://proof.example'
const PASSWORD = 'StayHomeProof123!'

const cabin = {
  idempotency_key: 'cabin', name: 'Cliff Cabin', timezone: 'America/Denver', address: '1 Cliff Rd', city: 'Moab', state: 'UT', country: 'US', zip_code: '84532',
  phone: '+14355550100', email: 'host@example.test', check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2, base_price_minor: 189_50,
}

test('a home added by hand is a new location and an unpublished stay, checked, replayable and billed', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stay-home-create-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'stay-home-create-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    for (const [id, role] of [['owner', 'owner'], ['helper', 'member']] as const) {
      await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(id, id, `${id}@proof.example`).run()
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(`m-${id}`, ORG, id, role).run()
      await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, 0, 0)").bind(`a-${id}`, id, id, await hashPassword(PASSWORD)).run()
    }
    const env = {
      ...await runtime.getBindings<CloudflareEnv>(), DB: db, BETTER_AUTH_SECRET: 'stay-home-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: BASE, NUXT_PUBLIC_PLATFORM_DOMAIN: BASE,
      STRIPE_SECRET_KEY: 'sk_test_stay_home_no_provider_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as CloudflareEnv
    const cookieFor = async (id: string) => {
      const login = await createAuth(env).api.signInEmail({ body: { email: `${id}@proof.example`, password: PASSWORD }, asResponse: true })
      assert.equal(login.status, 200)
      return login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    }
    const app = new H3()
    app.post('/api/dashboard/stay-homes', createHomeRoute)
    app.get('/api/dashboard/stay-homes', listHomesRoute)
    app.patch('/api/dashboard/stay-homes/:productId', editHomeRoute)
    const call = async (cookie: string, method: 'GET' | 'POST' | 'PATCH', body?: Record<string, unknown>, productId?: string) => {
      const response = await app.request(Object.assign(new Request(`${BASE}/api/dashboard/stay-homes${productId ? `/${productId}` : ''}?org=org`, {
        method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, ...(body ? { body: JSON.stringify(body) } : {}),
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    const refusal = (result: { status: number; body: Record<string, unknown> }) => ({ status: result.status, ...(result.body.data as Record<string, unknown>) })
    const count = async (table: string) => await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = ?`).bind(ORG).first('n')
    const owner = await cookieFor('owner')

    assert.deepEqual(await call('', 'GET'), {
      status: 401,
      body: { status: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } },
    })

    // Each problem names its field, and nothing is written.
    assert.deepEqual(refusal(await call(owner, 'POST', { ...cabin, city: ' ' })), { status: 422, code: 'MISSING_DETAIL', field: 'city' })
    assert.deepEqual(refusal(await call(owner, 'POST', { ...cabin, country: 'us' })), { status: 422, code: 'INVALID_DETAIL', field: 'country' })
    assert.deepEqual(refusal(await call(owner, 'POST', { ...cabin, check_in_time: '3pm' })), { status: 422, code: 'INVALID_DETAIL', field: 'check_in_time' })
    assert.deepEqual(refusal(await call(owner, 'POST', { ...cabin, max_guests: 0 })), { status: 422, code: 'INVALID_DETAIL', field: 'max_guests' })
    for (const idempotency_key of ['a'.repeat(201), '   ']) {
      assert.deepEqual(await call(owner, 'POST', { ...cabin, idempotency_key }), {
        status: 400, body: { error: 'idempotency_key must be 1 to 200 characters', code: 'VALIDATION_ERROR', field: 'idempotency_key' },
      })
    }
    // The canonical location error reaches another domain caller intact too.
    await assert.rejects(createStayHome(env, db, { organizationId: ORG, actorId: 'owner', manage: true }, stayHomeInput(cabin), 'a'.repeat(201)), {
      status: 400, data: { error: 'idempotency_key must be 1 to 200 characters.', code: 'INVALID_LOCATION_FIELD', field: 'idempotency_key' },
    })
    assert.deepEqual([await count('business_locations'), await count('products')], [0, 0])

    // A member who looks after homes does not add them.
    assert.deepEqual(refusal(await call(await cookieFor('helper'), 'POST', cabin)), { status: 403, code: 'STAY_ROLE_REQUIRED' })

    const home = {
      name: 'Cliff Cabin', timezone: 'America/Denver', currency: 'USD', base_price_minor: 189_50, base_price_tax_behavior: 'unspecified', check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2, check_in_instructions: null, assigned_member_id: null, assigned_team_id: null, channel: null, photos: [],
      address: { address: '1 Cliff Rd', city: 'Moab', state: 'UT', country: 'US', zip_code: '84532' }, latitude: null, longitude: null,
      description: '', published: false, property_type: null, bedrooms: null, beds: null, bathrooms: null, amenities: [], cancellation_policy: null, long_term_cancellation_policy: null, check_in_method: null, wifi_network: null, wifi_password: null, directions: null, house_manual: null, checkout_instructions: [],
    }
    const keyedCabin = { ...cabin, idempotency_key: 'a'.repeat(200) }
    const created = await call(owner, 'POST', keyedCabin)
    assert.equal(created.status, 201)
    const made = created.body.home as { product_id: string; location_id: string }
    assert.deepEqual(created.body, { home: { product_id: made.product_id, location_id: made.location_id, ...home } })
    // The same key returns the same home; nothing new is made.
    assert.deepEqual(await call(owner, 'POST', keyedCabin), created)
    assert.deepEqual(await call(owner, 'POST', { ...keyedCabin, idempotency_key: ` ${keyedCabin.idempotency_key} ` }), created)
    assert.deepEqual([await count('business_locations'), await count('products')], [1, 1])

    // Read back through other paths: the homes list, the location and the stay's publication.
    assert.deepEqual((await call(owner, 'GET')).body.homes, [created.body.home])
    const location = (await getLocation(db, ORG, made.location_id))!
    assert.deepEqual({ title: location.title, timezone: location.timezone, phone: location.phone, email: location.email, address: location.address }, {
      title: 'Cliff Cabin', timezone: 'America/Denver', phone: '+14355550100', email: 'host@example.test',
      address: { regionCode: 'US', addressLines: ['1 Cliff Rd'], locality: 'Moab', administrativeArea: 'UT', postalCode: '84532' },
    })
    // On the site unpublished, like a product added in the editor: it can carry photos and a page before it is published.
    assert.deepEqual(await db.prepare('SELECT published FROM product_publications WHERE product_id = ?').bind(made.product_id).all().then(result => result.results), [{ published: 0 }])

    // Without a price the home has no base price; the plan's second location is the last it covers.
    const second = await call(owner, 'POST', { ...cabin, idempotency_key: 'loft', name: 'River Loft', base_price_minor: undefined, state: undefined, zip_code: undefined })
    assert.equal(second.status, 201)
    assert.equal((second.body.home as { base_price_minor: number | null }).base_price_minor, null)
    assert.deepEqual(refusal(await call(owner, 'POST', { ...cabin, idempotency_key: 'barn', name: 'Barn' })), {
      status: 402, error: 'Basic includes 2 locations. Choose Growth or Business in Billing to add more.', code: 'LOCATION_LIMIT', locations: { used: 2, covered: 2 },
    })
    assert.deepEqual([await count('business_locations'), await count('products')], [2, 2])

    // Editing: each problem names its field and changes nothing.
    const edit = (cookie: string, body: Record<string, unknown>) => call(cookie, 'PATCH', body, made.product_id)
    assert.deepEqual(refusal(await edit(owner, { address: '2 Other Rd' })), { status: 422, code: 'INVALID_DETAIL', field: 'address' })
    assert.deepEqual(refusal(await edit(owner, { address: { address: '2 Other Rd', city: 'Moab', country: 'USA' } })), { status: 422, code: 'INVALID_DETAIL', field: 'address.country' })
    assert.deepEqual(refusal(await edit(owner, { name: null })), { status: 422, code: 'INVALID_DETAIL', field: 'name' })
    assert.deepEqual(refusal(await edit(owner, { name: 'Renamed', timezone: 'Mars/Olympus' })), { status: 422, code: 'INVALID_DETAIL', field: 'timezone' })
    assert.deepEqual(refusal(await edit(owner, { name: '  ' })), { status: 422, code: 'INVALID_DETAIL', field: 'name' })
    assert.deepEqual(refusal(await edit(owner, { assigned_member_id: 'nobody' })), { status: 422, code: 'INVALID_DETAIL', field: 'assigned_member_id' })
    assert.deepEqual(refusal(await edit(await cookieFor('helper'), { name: 'Mine' })), { status: 403, code: 'STAY_ROLE_REQUIRED' })
    assert.deepEqual((await call(owner, 'GET')).body.homes, [created.body.home, second.body.home])

    const edited = await edit(owner, {
      name: 'Cliff Cabin North', timezone: 'America/Los_Angeles', check_in_time: '16:00', check_out_time: '10:00',
      max_guests: 6, min_nights: 3, base_price_minor: 210_00, assigned_member_id: 'm-helper',
    })
    assert.equal(edited.status, 200)
    const changed = {
      product_id: made.product_id, location_id: made.location_id, name: 'Cliff Cabin North', timezone: 'America/Los_Angeles', currency: 'USD', base_price_minor: 210_00, base_price_tax_behavior: 'unspecified',
      check_in_time: '16:00', check_out_time: '10:00', max_guests: 6, min_nights: 3, check_in_instructions: null, assigned_member_id: 'm-helper', assigned_team_id: null, channel: null, photos: [],
      address: home.address, latitude: null, longitude: null, description: '', published: false, property_type: null, bedrooms: null, beds: null, bathrooms: null, amenities: [], cancellation_policy: null, long_term_cancellation_policy: null, check_in_method: null, wifi_network: null, wifi_password: null, directions: null, house_manual: null, checkout_instructions: [],
    }
    assert.deepEqual(edited.body, { home: changed, channel_push: null })
    // Read back through other paths: the homes list, the location, and the member now assigned seeing it.
    assert.deepEqual(((await call(owner, 'GET')).body.homes as Array<{ product_id: string }>).find(home => home.product_id === made.product_id), changed)
    assert.equal((await getLocation(db, ORG, made.location_id))!.timezone, 'America/Los_Angeles')
    assert.deepEqual(((await call(await cookieFor('helper'), 'GET')).body.homes as Array<{ product_id: string }>).map(home => home.product_id), [made.product_id])
    // The price is the one it had, changed in place; null removes it. Fields left out keep their value.
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM prices WHERE organization_id = ?').bind(ORG).first('n'), 1)
    const unpriced = await edit(owner, { base_price_minor: null, assigned_member_id: null })
    assert.deepEqual(unpriced.body, { home: { ...changed, base_price_minor: null, base_price_tax_behavior: null, assigned_member_id: null }, channel_push: null })

    // What the home is and offers, and its private arrival guide: each refused value names its field and changes nothing.
    assert.deepEqual(refusal(await edit(owner, { property_type: 'castle' })), { status: 400, code: 'INVALID_STAY_FIELD', field: 'stay.property_type' })
    assert.deepEqual(refusal(await edit(owner, { bathrooms: 1.25 })), { status: 400, code: 'INVALID_STAY_FIELD', field: 'stay.bathrooms' })
    assert.deepEqual(refusal(await edit(owner, { amenities: ['wifi', 'jetpack'] })), { status: 400, code: 'INVALID_STAY_FIELD', field: 'stay.amenities' })
    assert.deepEqual(refusal(await edit(owner, { check_in_method: 'drone' })), { status: 422, code: 'INVALID_DETAIL', field: 'check_in_method' })
    assert.deepEqual(refusal(await edit(owner, { checkout_instructions: [{ task: 'lock_up', details: null }, { task: 'lock_up', details: null }] })), { status: 422, code: 'INVALID_DETAIL', field: 'checkout_instructions[1].task' })
    assert.deepEqual(refusal(await edit(owner, { latitude: 38.57 })), { status: 422, code: 'INVALID_DETAIL', field: 'longitude' })
    assert.deepEqual(refusal(await edit(owner, { latitude: 91, longitude: -109.55 })), { status: 422, code: 'INVALID_DETAIL', field: 'latitude' })
    const described = await edit(owner, {
      description: '  A cabin above the canyon.  ', property_type: 'house', bedrooms: 2, beds: 3, bathrooms: 1.5, amenities: ['wifi', 'air_conditioning', 'kitchen'],
      cancellation_policy: 'firm', long_term_cancellation_policy: 'strict', check_in_method: 'keypad', check_in_instructions: 'Code is on the booking.',
      wifi_network: 'Cliff', wifi_password: ' pass word ', directions: 'Second gravel road on the left.', house_manual: 'Heater is in the hall.',
      checkout_instructions: [{ task: 'lock_up', details: null }, { task: 'additional', details: 'Leave keys on the table.' }],
      address: { address: '3 Rim Rd', city: 'Moab', state: 'UT', country: 'US', zip_code: '84532' }, latitude: 38.57, longitude: -109.55,
    })
    const listed = {
      ...changed, base_price_minor: null, base_price_tax_behavior: null, assigned_member_id: null,
      description: 'A cabin above the canyon.', property_type: 'house', bedrooms: 2, beds: 3, bathrooms: 1.5,
      // Amenities read in catalog order, whatever order they were sent in.
      amenities: ['air_conditioning', 'wifi', 'kitchen'], cancellation_policy: 'firm', long_term_cancellation_policy: 'strict',
      check_in_method: 'keypad', check_in_instructions: 'Code is on the booking.', wifi_network: 'Cliff', wifi_password: ' pass word ',
      directions: 'Second gravel road on the left.', house_manual: 'Heater is in the hall.',
      checkout_instructions: [{ task: 'lock_up', details: null }, { task: 'additional', details: 'Leave keys on the table.' }],
      address: { address: '3 Rim Rd', city: 'Moab', state: 'UT', country: 'US', zip_code: '84532' }, latitude: 38.57, longitude: -109.55,
    }
    assert.deepEqual(described.body, { home: listed, channel_push: null })
    assert.deepEqual(((await call(owner, 'GET')).body.homes as Array<{ product_id: string }>).find(home => home.product_id === made.product_id), listed)
    // The location holds the address and the pin; the product holds what the home is; private arrival columns stay out of the product.
    const moved = (await getLocation(db, ORG, made.location_id))!
    assert.deepEqual(await db.prepare('SELECT latitude, longitude FROM business_locations WHERE id = ?').bind(made.location_id).first(), { latitude: 38.57, longitude: -109.55 })
    assert.deepEqual(moved.address, { regionCode: 'US', addressLines: ['3 Rim Rd'], locality: 'Moab', administrativeArea: 'UT', postalCode: '84532' })
    const product = await getProduct(db, ORG, made.product_id)
    assert.equal(product.description, 'A cabin above the canyon.')
    assert.deepEqual(Object.keys(product.stay!).filter(key => ['wifi_network', 'wifi_password', 'house_manual', 'directions', 'check_in_method', 'checkout_instructions', 'check_in_instructions'].includes(key)), [])
    // Clearing: null removes a value, an empty list offers nothing.
    const cleared = await edit(owner, { wifi_password: null, amenities: [], bedrooms: null, checkout_instructions: [] })
    assert.deepEqual(cleared.body, { home: { ...listed, wifi_password: null, amenities: [], bedrooms: null, checkout_instructions: [] }, channel_push: null })
    // Listing the home is its product's publication, refused until it can take bookings.
    assert.deepEqual(refusal(await edit(owner, { published: 'yes' })), { status: 422, code: 'INVALID_DETAIL', field: 'published' })
    assert.equal((await edit(owner, { published: true })).status, 409)
    assert.equal(((await call(owner, 'GET')).body.homes as Array<{ product_id: string; published: boolean }>).find(home => home.product_id === made.product_id)!.published, false)
  } finally {
    await runtime.dispose()
  }
})
