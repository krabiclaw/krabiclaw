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
import { getLocation, updateLocation } from '../../server/utils/location-management.ts'
import { getProduct } from '../../server/utils/product-management.ts'
import { createStayHome, readStayHome, stayHomeInput } from '../../server/domain/stays.ts'
import { STAY_HOME_ACCESSIBILITY_FEATURES } from '../../shared/stay-accessibility.ts'

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

test('a home added by hand is a new location and an unpublished stay, checked, replayable, and billed once live', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stay-home-create-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'stay-home-create-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
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

    const unspecifiedPropertyDetails = { listing_type: null, total_floors: null, listing_floor: null, year_built: null, property_size: null, property_size_unit: null }
    const home = {
      name: 'Cliff Cabin', timezone: 'America/Denver', currency: 'USD', base_price_minor: 189_50, base_price_tax_behavior: 'unspecified', check_in_time: '15:00', check_in_end_time: null, check_out_time: '11:00', max_guests: 4, min_nights: 2, check_in_instructions: null, assigned_member_id: null, assigned_team_id: null, channel: null, photos: [], photo_rooms: [], stay_map_sharing: 'general',
      accessibility: Object.keys(STAY_HOME_ACCESSIBILITY_FEATURES).map(feature => ({ feature, available: null, photo_ids: [] })),
      address: { address: '1 Cliff Rd', city: 'Moab', state: 'UT', country: 'US', zip_code: '84532' }, latitude: null, longitude: null,
      description: '', published: false, live: false, airbnb_listing_id: null, airbnb_editor_url: null, property_type_group: null, property_type: null, ...unspecifiedPropertyDetails, bedrooms: null, beds: null, bathrooms: null, amenities: [], amenity_answers: [], smoke_detector_details: null, carbon_monoxide_detector_details: null, cancellation_policy: 'flexible', long_term_cancellation_policy: 'firm', check_in_method: null, wifi_network: null, wifi_password: null, directions: null, house_manual: null, checkout_instructions: [],
    }
    const keyedCabin = { ...cabin, idempotency_key: 'a'.repeat(200) }
    const created = await call(owner, 'POST', keyedCabin)
    assert.equal(created.status, 201)
    const made = created.body.home as { product_id: string; location_id: string }
    assert.deepEqual(created.body, { home: { product_id: made.product_id, product_updated_at: (await getProduct(db, ORG, made.product_id)).updated_at, location_id: made.location_id, ...home } })
    // The same key returns the same home; nothing new is made.
    assert.deepEqual(await call(owner, 'POST', keyedCabin), created)
    assert.deepEqual(await call(owner, 'POST', { ...keyedCabin, idempotency_key: ` ${keyedCabin.idempotency_key} ` }), created)
    assert.deepEqual([await count('business_locations'), await count('products')], [1, 1])
    // A new home starts on Airbnb's own policies; an explicit empty one is refused and nothing is made.
    for (const field of ['cancellation_policy', 'long_term_cancellation_policy'] as const) {
      const refused = await call(owner, 'POST', { ...cabin, name: 'No policy', [field]: null })
      assert.deepEqual([refused.status, (refused.body.data as { code?: string; field?: string } | undefined)], [422, { code: 'INVALID_DETAIL', field }])
    }
    assert.deepEqual([await count('business_locations'), await count('products')], [1, 1])

    // Read back through other paths: the homes list, the location and the stay's publication.
    assert.deepEqual((await call(owner, 'GET')).body.homes, [created.body.home])
    assert.partialDeepStrictEqual((await getProduct(db, ORG, made.product_id)).stay, unspecifiedPropertyDetails)
    assert.deepEqual(await db.prepare('SELECT listing_type, total_floors, listing_floor, year_built, property_size, property_size_unit FROM product_stay_configs WHERE product_id = ?').bind(made.product_id).first(), unspecifiedPropertyDetails)
    await assert.rejects(readStayHome(db, { organizationId: ORG, actorId: 'owner', manage: true }, ''), {
      status: 404, data: { code: 'HOME_NOT_FOUND' },
    })
    const location = (await getLocation(db, ORG, made.location_id))!
    assert.deepEqual({ title: location.title, timezone: location.timezone, phone: location.phone, email: location.email, address: location.address }, {
      title: 'Cliff Cabin', timezone: 'America/Denver', phone: '+14355550100', email: 'host@example.test',
      address: { regionCode: 'US', addressLines: ['1 Cliff Rd'], locality: 'Moab', administrativeArea: 'UT', postalCode: '84532' },
    })
    // On the site unpublished, like a product added in the editor: it can carry photos and a page before it is published.
    assert.deepEqual(await db.prepare('SELECT published FROM product_publications WHERE product_id = ?').bind(made.product_id).all().then(result => result.results), [{ published: 0 }])

    // Without a price the home has no base price.
    const second = await call(owner, 'POST', { ...cabin, idempotency_key: 'loft', name: 'River Loft', base_price_minor: undefined, state: undefined, zip_code: undefined })
    assert.equal(second.status, 201)
    assert.equal((second.body.home as { base_price_minor: number | null }).base_price_minor, null)
    assert.deepEqual([await count('business_locations'), await count('products')], [2, 2])

    // Editing: each problem names its field and changes nothing.
    const edit = (cookie: string, body: Record<string, unknown>) => call(cookie, 'PATCH', body, made.product_id)
    assert.deepEqual(refusal(await edit(owner, { address: '2 Other Rd' })), { status: 422, code: 'INVALID_DETAIL', field: 'address' })
    assert.deepEqual(refusal(await edit(owner, { address: { address: '2 Other Rd', city: 'Moab', country: 'USA' } })), { status: 422, code: 'INVALID_DETAIL', field: 'address.country' })
    assert.deepEqual(refusal(await edit(owner, { name: null })), { status: 422, code: 'INVALID_DETAIL', field: 'name' })
    assert.deepEqual(refusal(await edit(owner, { name: 'Renamed', timezone: 'Mars/Olympus' })), { status: 422, code: 'INVALID_DETAIL', field: 'timezone' })
    assert.deepEqual(refusal(await edit(owner, { name: '  ' })), { status: 422, code: 'INVALID_DETAIL', field: 'name' })
    // The check-in window's end is a time other than its start, or null for a flexible end.
    assert.deepEqual(refusal(await edit(owner, { check_in_end_time: '9pm' })), { status: 422, code: 'INVALID_DETAIL', field: 'check_in_end_time' })
    assert.deepEqual(refusal(await edit(owner, { check_in_end_time: '  ' })), { status: 422, code: 'INVALID_DETAIL', field: 'check_in_end_time' })
    assert.deepEqual(refusal(await edit(owner, { check_in_end_time: '15:00' })), { status: 400, code: 'INVALID_STAY_FIELD', field: 'stay.check_in_end_time' })
    assert.deepEqual(refusal(await edit(owner, { assigned_member_id: 'nobody' })), { status: 422, code: 'INVALID_RESPONSIBILITY', field: 'assigned_member_id' })
    assert.deepEqual(refusal(await edit(await cookieFor('helper'), { name: 'Mine' })), { status: 403, code: 'STAY_ROLE_REQUIRED' })
    assert.deepEqual((await call(owner, 'GET')).body.homes, [created.body.home, second.body.home])

    const edited = await edit(owner, {
      name: 'Cliff Cabin North', timezone: 'America/Los_Angeles', check_in_time: '16:00', check_in_end_time: '21:00', check_out_time: '10:00',
      max_guests: 6, min_nights: 3, base_price_minor: 210_00, assigned_member_id: 'm-helper',
    })
    assert.equal(edited.status, 200)
    const changed = {
      product_id: made.product_id, product_updated_at: (await getProduct(db, ORG, made.product_id)).updated_at, location_id: made.location_id, name: 'Cliff Cabin North', timezone: 'America/Los_Angeles', currency: 'USD', base_price_minor: 210_00, base_price_tax_behavior: 'unspecified',
      check_in_time: '16:00', check_in_end_time: '21:00', check_out_time: '10:00', max_guests: 6, min_nights: 3, check_in_instructions: null, assigned_member_id: 'm-helper', assigned_team_id: null, channel: null, photos: [], photo_rooms: [], stay_map_sharing: 'general',
      accessibility: home.accessibility,
      address: home.address, latitude: null, longitude: null, description: '', published: false, live: false, airbnb_listing_id: null, airbnb_editor_url: null, property_type_group: null, property_type: null, ...unspecifiedPropertyDetails, bedrooms: null, beds: null, bathrooms: null, amenities: [], amenity_answers: [], smoke_detector_details: null, carbon_monoxide_detector_details: null, cancellation_policy: 'flexible', long_term_cancellation_policy: 'firm', check_in_method: null, wifi_network: null, wifi_password: null, directions: null, house_manual: null, checkout_instructions: [],
    }
    assert.deepEqual(edited.body, { home: changed, channel_push: null, airbnb_unsynced: [] })
    // Read back through other paths: the homes list, the location, and the member now assigned seeing it.
    assert.deepEqual(((await call(owner, 'GET')).body.homes as Array<{ product_id: string }>).find(home => home.product_id === made.product_id), changed)
    assert.equal((await getLocation(db, ORG, made.location_id))!.timezone, 'America/Los_Angeles')
    assert.deepEqual(((await call(await cookieFor('helper'), 'GET')).body.homes as Array<{ product_id: string }>).map(home => home.product_id), [made.product_id])
    // The price is the one it had, changed in place; null removes it. Fields left out keep their value.
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM prices WHERE organization_id = ?').bind(ORG).first('n'), 1)
    const unpriced = await edit(owner, { base_price_minor: null, assigned_member_id: null })
    assert.deepEqual(unpriced.body, { home: { ...changed, product_updated_at: (await getProduct(db, ORG, made.product_id)).updated_at, base_price_minor: null, base_price_tax_behavior: null, assigned_member_id: null }, channel_push: null, airbnb_unsynced: [] })

    // What the home is and offers, and its private arrival guide: each refused value names its field and changes nothing.
    assert.deepEqual(refusal(await edit(owner, { property_type_group: 'apartments', property_type: 'castle' })), { status: 400, code: 'INVALID_STAY_FIELD', field: 'stay.property_type' })
    assert.deepEqual(refusal(await edit(owner, { property_type: 'cabin' })), { status: 400, code: 'INVALID_STAY_FIELD', field: 'stay.property_type' })
    assert.deepEqual(refusal(await edit(owner, { bathrooms: 1.25 })), { status: 400, code: 'INVALID_STAY_FIELD', field: 'stay.bathrooms' })
    assert.deepEqual(refusal(await edit(owner, { amenities: ['wireless_internet', 'jetpack'] })), { status: 400, code: 'INVALID_STAY_FIELD', field: 'stay.amenities' })
    assert.deepEqual(refusal(await edit(owner, { check_in_method: 'drone' })), { status: 422, code: 'INVALID_DETAIL', field: 'check_in_method' })
    assert.deepEqual(refusal(await edit(owner, { check_in_method: ['keypad'] })), { status: 422, code: 'INVALID_DETAIL', field: 'check_in_method' })
    assert.deepEqual(refusal(await edit(owner, { checkout_instructions: [{ task: 'lock_up', details: null }, { task: 'lock_up', details: null }] })), { status: 422, code: 'INVALID_DETAIL', field: 'checkout_instructions[1].task' })
    assert.deepEqual(refusal(await edit(owner, { latitude: 38.57 })), { status: 422, code: 'INVALID_DETAIL', field: 'longitude' })
    assert.deepEqual(refusal(await edit(owner, { latitude: 91, longitude: -109.55 })), { status: 422, code: 'INVALID_DETAIL', field: 'latitude' })
    const beforeInvalidProperties = await getProduct(db, ORG, made.product_id)
    for (const [patch, field] of [
      [{ listing_type: 'hotel' }, 'listing_type'],
      [{ total_floors: 0 }, 'total_floors'],
      [{ total_floors: 1.5 }, 'total_floors'],
      [{ total_floors: Number.MAX_SAFE_INTEGER + 1 }, 'total_floors'],
      [{ listing_floor: 0 }, 'listing_floor'],
      [{ listing_floor: 1.5 }, 'listing_floor'],
      [{ total_floors: 2, listing_floor: 3 }, 'listing_floor'],
      [{ year_built: 0 }, 'year_built'],
      [{ year_built: 1999.5 }, 'year_built'],
      [{ year_built: Number.MAX_SAFE_INTEGER + 1 }, 'year_built'],
      [{ property_size: 0, property_size_unit: 'square_meters' }, 'property_size'],
      [{ property_size: '72.25', property_size_unit: 'square_meters' }, 'property_size'],
      [{ property_size: 72.25 }, 'property_size_unit'],
      [{ property_size_unit: 'square_meters' }, 'property_size'],
      [{ property_size: 72.25, property_size_unit: 'acres' }, 'property_size_unit'],
    ] as const) {
      assert.deepEqual(refusal(await edit(owner, { name: 'Must not be saved', ...patch })), { status: 400, code: 'INVALID_STAY_FIELD', field: `stay.${field}` })
      assert.deepEqual(await getProduct(db, ORG, made.product_id), beforeInvalidProperties)
    }
    assert.deepEqual(await db.prepare('SELECT listing_type, total_floors, listing_floor, year_built, property_size, property_size_unit FROM product_stay_configs WHERE product_id = ?').bind(made.product_id).first(), unspecifiedPropertyDetails)
    const propertyDetails = { listing_type: 'private_room', total_floors: 3, listing_floor: 2, year_built: 1999, property_size: 72.25, property_size_unit: 'square_meters' }
    const described = await edit(owner, {
      description: '  A cabin above the canyon.  ', property_type_group: 'houses', property_type: 'cabin', ...propertyDetails, bedrooms: 2, beds: 3, bathrooms: 1.5, amenities: ['wireless_internet', 'ac', 'kitchen'],
      cancellation_policy: 'firm', long_term_cancellation_policy: 'strict', check_in_method: 'keypad', check_in_instructions: 'Code is on the booking.',
      wifi_network: 'Cliff', wifi_password: ' pass word ', directions: 'Second gravel road on the left.', house_manual: 'Heater is in the hall.',
      checkout_instructions: [{ task: 'lock_up', details: null }, { task: 'additional', details: 'Leave keys on the table.' }],
      address: { address: '3 Rim Rd', city: 'Moab', state: 'UT', country: 'US', zip_code: '84532' }, latitude: 38.57, longitude: -109.55,
    })
    const listed = {
      ...changed, product_updated_at: (await getProduct(db, ORG, made.product_id)).updated_at, base_price_minor: null, base_price_tax_behavior: null, assigned_member_id: null,
      description: 'A cabin above the canyon.', property_type_group: 'houses', property_type: 'cabin', ...propertyDetails, bedrooms: 2, beds: 3, bathrooms: 1.5,
      // Amenities read in catalog order, whatever order they were sent in.
      amenities: ['ac', 'kitchen', 'wireless_internet'], amenity_answers: [{ code: 'ac', available: true }, { code: 'kitchen', available: true }, { code: 'wireless_internet', available: true }], cancellation_policy: 'firm', long_term_cancellation_policy: 'strict',
      check_in_method: 'keypad', check_in_instructions: 'Code is on the booking.', wifi_network: 'Cliff', wifi_password: ' pass word ',
      directions: 'Second gravel road on the left.', house_manual: 'Heater is in the hall.',
      checkout_instructions: [{ task: 'lock_up', details: null }, { task: 'additional', details: 'Leave keys on the table.' }],
      address: { address: '3 Rim Rd', city: 'Moab', state: 'UT', country: 'US', zip_code: '84532' }, latitude: 38.57, longitude: -109.55,
    }
    assert.equal(described.status, 200)
    assert.deepEqual(described.body, { home: listed, channel_push: null, airbnb_unsynced: [] })
    assert.deepEqual(((await call(owner, 'GET')).body.homes as Array<{ product_id: string }>).find(home => home.product_id === made.product_id), listed)
    // The location holds the address and the pin; the product holds what the home is; private arrival columns stay out of the product.
    const moved = (await getLocation(db, ORG, made.location_id))!
    assert.deepEqual(await db.prepare('SELECT latitude, longitude FROM business_locations WHERE id = ?').bind(made.location_id).first(), { latitude: 38.57, longitude: -109.55 })
    assert.deepEqual(moved.address, { regionCode: 'US', addressLines: ['3 Rim Rd'], locality: 'Moab', administrativeArea: 'UT', postalCode: '84532' })
    const product = await getProduct(db, ORG, made.product_id)
    assert.equal(product.description, 'A cabin above the canyon.')
    assert.partialDeepStrictEqual(product.stay, propertyDetails)
    assert.deepEqual(await db.prepare('SELECT listing_type, total_floors, listing_floor, year_built, property_size, property_size_unit FROM product_stay_configs WHERE product_id = ?').bind(made.product_id).first(), propertyDetails)
    assert.deepEqual(Object.keys(product.stay!).filter(key => ['wifi_network', 'wifi_password', 'house_manual', 'directions', 'check_in_method', 'checkout_instructions', 'check_in_instructions'].includes(key)), [])
    // A partial edit validates the merged state and preserves every omitted fact.
    for (const [patch, field] of [
      [{ total_floors: 1 }, 'listing_floor'],
      [{ listing_floor: 4 }, 'listing_floor'],
      [{ property_size: null }, 'property_size'],
      [{ property_size_unit: null }, 'property_size_unit'],
    ] as const) {
      assert.deepEqual(refusal(await edit(owner, { name: 'Must not be saved', ...patch })), { status: 400, code: 'INVALID_STAY_FIELD', field: `stay.${field}` })
      assert.deepEqual(await getProduct(db, ORG, made.product_id), product)
    }
    assert.deepEqual(await db.prepare('SELECT listing_type, total_floors, listing_floor, year_built, property_size, property_size_unit FROM product_stay_configs WHERE product_id = ?').bind(made.product_id).first(), propertyDetails)
    const resized = await edit(owner, { property_size: 80.5 })
    assert.equal(resized.status, 200)
    assert.deepEqual(resized.body, { home: { ...listed, product_updated_at: (await getProduct(db, ORG, made.product_id)).updated_at, property_size: 80.5 }, channel_push: null, airbnb_unsynced: [] })
    assert.partialDeepStrictEqual((await getProduct(db, ORG, made.product_id)).stay, { ...propertyDetails, property_size: 80.5 })
    const changedUnit = await edit(owner, { property_size_unit: 'square_feet' })
    assert.equal(changedUnit.status, 200)
    assert.deepEqual(changedUnit.body, { home: { ...listed, product_updated_at: (await getProduct(db, ORG, made.product_id)).updated_at, property_size: 80.5, property_size_unit: 'square_feet' }, channel_push: null, airbnb_unsynced: [] })
    assert.partialDeepStrictEqual((await getProduct(db, ORG, made.product_id)).stay, { ...propertyDetails, property_size: 80.5, property_size_unit: 'square_feet' })
    const partialProperties = { ...propertyDetails, total_floors: null, listing_floor: 4, property_size: 80.5, property_size_unit: 'square_feet' }
    const unknownTotal = await edit(owner, { total_floors: null, listing_floor: 4 })
    assert.equal(unknownTotal.status, 200)
    assert.deepEqual(unknownTotal.body, { home: { ...listed, product_updated_at: (await getProduct(db, ORG, made.product_id)).updated_at, ...partialProperties }, channel_push: null, airbnb_unsynced: [] })
    assert.deepEqual(((await call(owner, 'GET')).body.homes as Array<{ product_id: string }>).find(home => home.product_id === made.product_id), unknownTotal.body.home)
    assert.partialDeepStrictEqual((await getProduct(db, ORG, made.product_id)).stay, partialProperties)
    assert.deepEqual(await db.prepare('SELECT listing_type, total_floors, listing_floor, year_built, property_size, property_size_unit FROM product_stay_configs WHERE product_id = ?').bind(made.product_id).first(), partialProperties)
    // Clearing: null removes a value, an empty list offers nothing.
    const cleared = await edit(owner, { ...unspecifiedPropertyDetails, wifi_password: null, amenities: [], bedrooms: null, checkout_instructions: [] })
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.body, { home: { ...listed, product_updated_at: (await getProduct(db, ORG, made.product_id)).updated_at, ...unspecifiedPropertyDetails, wifi_password: null, amenities: [], amenity_answers: [], bedrooms: null, checkout_instructions: [] }, channel_push: null, airbnb_unsynced: [] })
    assert.deepEqual(((await call(owner, 'GET')).body.homes as Array<{ product_id: string }>).find(home => home.product_id === made.product_id), cleared.body.home)
    assert.deepEqual(await db.prepare('SELECT wifi_password, amenities, bedrooms, checkout_instructions FROM product_stay_configs WHERE product_id = ?').bind(made.product_id).first(),
      { wifi_password: null, amenities: '[]', bedrooms: null, checkout_instructions: '[]' })
    assert.partialDeepStrictEqual((await getProduct(db, ORG, made.product_id)).stay, unspecifiedPropertyDetails)
    assert.deepEqual(await db.prepare('SELECT listing_type, total_floors, listing_floor, year_built, property_size, property_size_unit FROM product_stay_configs WHERE product_id = ?').bind(made.product_id).first(), unspecifiedPropertyDetails)
    // The native adapter writes the same answers and Product.details text as
    // the CMS. Read the result independently through Product and SQL.
    const alarmsSaved = await edit(owner, { amenity_answers: [{ code: 'smoke_detector', available: true }, { code: 'carbon_monoxide_detector', available: false }], smoke_detector_details: 'Outside both bedrooms.' })
    assert.equal(alarmsSaved.status, 200)
    const alarmAnswers = [{ code: 'carbon_monoxide_detector', available: false }, { code: 'smoke_detector', available: true }]
    const alarmProduct = await getProduct(db, ORG, made.product_id)
    assert.deepEqual(alarmProduct.stay!.amenity_answers, alarmAnswers)
    assert.deepEqual(alarmProduct.stay!.amenities, ['smoke_detector'])
    assert.equal(alarmProduct.details.smoke_detector_details, 'Outside both bedrooms.')
    assert.deepEqual(JSON.parse((await db.prepare('SELECT amenities FROM product_stay_configs WHERE product_id = ?').bind(made.product_id).first<string>('amenities'))!), alarmAnswers)
    assert.equal((alarmsSaved.body.home as { smoke_detector_details: string }).smoke_detector_details, 'Outside both bedrooms.')
    assert.equal((await edit(owner, { amenities: ['smoke_detector'] })).status, 200)
    assert.deepEqual((await getProduct(db, ORG, made.product_id)).stay!.amenity_answers, alarmAnswers)
    assert.deepEqual(refusal(await edit(owner, { amenities: null })), { status: 400, code: 'INVALID_STAY_FIELD', field: 'stay.amenities' })
    assert.equal((await edit(owner, { amenity_answers: [{ code: 'smoke_detector', available: null }] })).status, 200)
    const unknownSmoke = await getProduct(db, ORG, made.product_id)
    assert.deepEqual(unknownSmoke.stay!.amenity_answers, [{ code: 'carbon_monoxide_detector', available: false }])
    assert.equal(unknownSmoke.details.smoke_detector_details, undefined)
    assert.equal((await readStayHome(db, { organizationId: ORG, actorId: 'owner', manage: true }, made.product_id)).smoke_detector_details, null)
    // Listing the home is its product's publication, refused until it can take bookings.
    assert.deepEqual(refusal(await edit(owner, { published: 'yes' })), { status: 422, code: 'INVALID_DETAIL', field: 'published' })
    assert.deepEqual(refusal(await edit(owner, { published: true, description: 'Half saved?' })), { status: 422, code: 'INVALID_DETAIL', field: 'published' })
    assert.equal((await getProduct(db, ORG, made.product_id)).description, 'A cabin above the canyon.')
    assert.equal((await edit(owner, { published: true })).status, 409)
    assert.equal(((await call(owner, 'GET')).body.homes as Array<{ product_id: string; published: boolean }>).find(home => home.product_id === made.product_id)!.published, false)
    // Priced, it is listed though the business has no online payments: guests send an enquiry until it does.
    assert.equal((await edit(owner, { base_price_minor: 210_00 })).status, 200)
    // Guests see who hosts it: a home is listed only with a host whose profile is published.
    assert.deepEqual(refusal(await edit(owner, { published: true })), { status: 409, code: 'HOST_REQUIRED', field: 'host' })
    await db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, windows_json, windows_until, public_name, public_bio, public_approved, calendar_revision, updated_at, updated_by)
      VALUES ('m-helper', ?, 'America/Denver', '[]', '[]', '[]', '2026-10-15T00:00:00.000Z', 'Helper Host', NULL, 1, 'revision', '2026-10-15T00:00:00.000Z', 'owner')`).bind(ORG).run()
    assert.equal((await edit(owner, { assigned_member_id: 'm-helper' })).status, 200)
    assert.equal((await edit(owner, { published: true })).status, 200)
    assert.equal(((await call(owner, 'GET')).body.homes as Array<{ product_id: string; published: boolean }>).find(home => home.product_id === made.product_id)!.published, true)
    assert.deepEqual(await db.prepare('SELECT published FROM product_publications WHERE product_id = ?').bind(made.product_id).all().then(result => result.results), [{ published: 1 }])

    // Adding homes is never refused on Basic: new homes are drafts. The plan covers live homes,
    // and publishing a third is refused as a home while two are live.
    const hosted = async (key: string) => {
      const added = await call(owner, 'POST', { ...cabin, idempotency_key: key, name: key })
      assert.equal(added.status, 201)
      const productId = (added.body.home as { product_id: string; live: boolean }).product_id
      assert.equal((added.body.home as { live: boolean }).live, false)
      assert.equal((await call(owner, 'PATCH', { assigned_member_id: 'm-helper' }, productId)).status, 200)
      return added.body.home as { product_id: string; location_id: string }
    }
    const barn = await hosted('Barn')
    const shed = await hosted('Shed')
    const published = await call(owner, 'PATCH', { published: true }, barn.product_id)
    assert.deepEqual([published.status, (published.body.home as { live: boolean }).live], [200, true])
    const homeLimit = { status: 402, error: 'Basic includes 2 homes. Choose Growth or Business in Billing to add more.', code: 'HOME_LIMIT', homes: { used: 2, covered: 2 } }
    assert.deepEqual(refusal(await call(owner, 'PATCH', { published: true }, shed.product_id)), homeLimit)
    assert.deepEqual(await db.prepare('SELECT published FROM product_publications WHERE product_id = ?').bind(shed.product_id).first('published'), 0)
    // A live home whose location is taken off the site frees its slot, and putting it back is refused as a home while every slot is in use.
    assert.equal((await updateLocation(db, ORG, barn.location_id, { status: 'inactive' }, 'owner', env)).status, 200)
    assert.equal((await call(owner, 'PATCH', { published: true }, shed.product_id)).status, 200)
    assert.deepEqual(await updateLocation(db, ORG, barn.location_id, { status: 'active' }, 'owner', env), {
      status: 402, data: { error: homeLimit.error, code: 'HOME_LIMIT', homes: { used: 2, covered: 2 } },
    })
    assert.equal((await getLocation(db, ORG, barn.location_id))!.status, 'inactive')
    // The check-in window's end: leaving the key out keeps it; null makes it flexible again, read back through the product.
    assert.equal(((await edit(owner, { max_guests: 6 })).body.home as { check_in_end_time: string | null }).check_in_end_time, '21:00')
    assert.equal(((await edit(owner, { check_in_end_time: null })).body.home as { check_in_end_time: string | null }).check_in_end_time, null)
    assert.equal((await getProduct(db, ORG, made.product_id)).stay!.check_in_end_time, null)
  } finally {
    await runtime.dispose()
  }
})
