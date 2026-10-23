import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { AirbnbConnection, type ImportContentReport } from '../../server/integrations/channex/airbnb-connection.ts'
import { createStayHome, readStayHome, stayHomeInput } from '../../server/domain/stays.ts'
import { deleteMediaAsset, getMediaAsset } from '../../server/utils/media-asset-manager.ts'
import { getProduct } from '../../server/utils/product-management.ts'
import importRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/listings/[listingId]/import.post.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import contentRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/imports/[productId]/content.post.ts'
import listingsRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/listings.get.ts'

// An Airbnb listing imported as a home, through every stage, against a fake
// Channex: the location, the stay product and its price, the imported nights,
// the listing's content (photos, texts, counts, amenities) and the Channex ids
// all land, and Channex holds exactly the calendar pushed.

const ORG = 'org'
const OWNER = 'owner-user'
const LISTING = 'listing-77'
const TZ = 'America/Denver'
const BASE = 'https://proof.example'
const PASSWORD = 'AirbnbImport123!'
const CDN = 'https://cdn.airbnb.test'
// A 1×1 PNG; what Airbnb's CDN serves for every photo here.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
const PHOTOS = [
  { id: `${LISTING}_1`, caption: 'The deck at sunset', sort_order: 1 },
  { id: `${LISTING}_2`, caption: null, sort_order: 2 },
  { id: `${LISTING}_3`, caption: 'Bedroom one', sort_order: 3 },
]

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

interface FakeBody {
  property: { title: string }
  connection_link: { token: string; title: string }
  values: Array<{ date: string; availability: number; rate: number; min_stay_arrival: number; max_stay: number; closed_to_arrival: boolean; closed_to_departure: boolean; stop_sell: boolean; rate_plan_id: string }>
  mapping: { rate_plan_id: string; settings: { listing_id: string } }
  channel: { properties: string[] }
}

class FakeChannex {
  seen: Array<{ method: string; path: string }> = []
  currency = 'USD'
  ids = 0
  channel = { title: '', active: false, properties: ['setup-1'], ratePlans: [] as Array<{ id: string; rate_plan_id: string; settings: { listing_id: string } }> }
  availability: Record<string, number> = {}
  restrictions: Record<string, Record<string, unknown>> = {}
  token = ''
  messagesProperty: string | null = null
  failMessages = false
  /** Whether listing_details carries the listing's content; off, it is the record as the import read it before the content stage existed. */
  content = true
  /** An Airbnb image id whose CDN fetch answers 503. */
  failPhoto: string | null = null
  /** Extra uncaptioned photos after PHOTOS, for a listing with more photos than a home holds. */
  extraPhotos = 0
  photoFetches = 0
  /** Every photo URL asked of Airbnb's image server. */
  photoUrls: string[] = []
  /** Airbnb's booking settings for the listing. */
  booking: Record<string, unknown> = {
    check_in_time_start: '16', check_in_time_end: '21', check_out_time: 10,
    guest_controls: { allows_children_as_host: true, allows_infants_as_host: true, allows_pets_as_host: true, allows_events_as_host: false, allows_smoking_as_host: false, children_not_allowed_details: null, pet_capacity: 1 },
  }
  /** The room types Channex was asked to create. */
  roomTypes: Array<Record<string, unknown>> = []

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace('/api/v1', '')
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as FakeBody : null
    if (url.origin === CDN) {
      const id = url.pathname.slice('/photos/'.length).replace(/\.jpg$/, '')
      this.photoFetches += 1
      this.photoUrls.push(url.toString())
      if (this.failPhoto === id) return new Response('upstream unavailable', { status: 503 })
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    this.seen.push({ method, path })
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
    const resource = (type: string, attributes: Record<string, unknown> = {}) => json({ data: { id: `${type}-${++this.ids}`, type, attributes } })
    if (method === 'POST' && path === '/groups') return json({ data: { id: 'grp-1', type: 'group', attributes: {} } })
    if (method === 'POST' && path === '/properties') {
      if (body!.property.title === 'KrabiClaw connection setup') return json({ data: { id: 'setup-1', type: 'property', attributes: {} } })
      const id = `prop-${++this.ids}`
      this.channel.properties.push(id)
      return json({ data: { id, type: 'property', attributes: {} } })
    }
    if (method === 'POST' && path === '/meta/airbnb/connection_link') {
      this.token = body!.connection_link.token
      this.channel.title = body!.connection_link.title
      return json({ data: { type: 'connection_link', attributes: { url: 'https://www.airbnb.com/oauth2/auth?x=1' } } })
    }
    if (method === 'GET' && path === '/channels/chan-1') {
      return json({ data: { id: 'chan-1', type: 'channel', attributes: { channel: 'AirBNB', title: this.channel.title, is_active: this.channel.active, properties: this.channel.properties, rate_plans: this.channel.ratePlans }, relationships: { group: { data: { id: 'grp-1' } } } } })
    }
    if (method === 'GET' && path === '/channels/chan-1/action/listings') return json({ data: { listing_id_dictionary: { values: [{ id: LISTING, title: 'Cliff Cabin', city: 'Moab', country_code: 'US' }] } } })
    if (method === 'GET' && path === '/channels/chan-1/action/listing_details') {
      const content = this.content ? {
        images: [...PHOTOS, ...Array.from({ length: this.extraPhotos }, (_, i) => ({ id: `${LISTING}_x${i + 1}`, caption: null, sort_order: PHOTOS.length + i + 1 }))].map(photo => ({ ...photo, listing_id: LISTING, category: 'LISTING', thumbnail_url: `${CDN}/photos/${photo.id}.jpg?aki_policy=x_small`, small_url: `${CDN}/photos/${photo.id}.jpg?aki_policy=small`, extra_medium_url: `${CDN}/photos/${photo.id}.jpg?aki_policy=x_medium` })),
        descriptions: { summary: 'A cabin on the cliff.', description: 'A cabin on the cliff.\n\nTwo bedrooms.', space: 'Two bedrooms and a deck.', access: 'The whole cabin is yours.', interaction: 'We live next door.', neighborhood_overview: 'Quiet, ten minutes from town.', transit: 'Bus 4 stops outside.', notes: 'No parties.', house_rules: 'No smoking inside.', name: 'Cliff Cabin', locale: 'en' },
        amenities: { WIRELESS_INTERNET: { instruction: '', is_present: true }, SMOKE_DETECTOR: { instruction: '', is_present: true }, HOVERBOARD_DOCK: { instruction: '', is_present: true }, CRIB: { instruction: '', is_present: false } },
        listing_views: ['MOUNTAIN_VIEW'],
        rooms: [{ id: 'r1', listing_id: LISTING, room_type: 'bedroom', is_private: true, beds: [{ quantity: 1, type: 'queen_bed' }], accessibility_features: [] }, { id: 'r2', listing_id: LISTING, room_type: 'bedroom', is_private: true, beds: [{ quantity: 2, type: 'queen_bed' }], accessibility_features: [] }],
        bedrooms: 2, beds: 3, bathrooms: 1, house_manual: 'Unit 63A. Shoes off, please.', directions: 'Behind the capitol.', wifi_network: '5 Star', wifi_password: 'open sesame',
        check_in_option: { category: 'smartlock', instruction: 'Door code 0126' },
        quiet_hours: [{ start_time: '23', end_time: '7' }],
      } : { rooms: [] }
      return json({ data: { listing: { id: LISTING, name: 'Cliff Cabin', person_capacity: 4, lat: 38.5733, lng: -109.5498, country_code: 'US', state: 'UT', city: 'Moab', street: '1 Cliff Rd', zipcode: '84532', property_type_category: 'holiday_home', booking_settings: this.booking, pricing_settings: { listing_currency: this.currency, guests_included: 2, default_daily_price: 189.5 }, ...content } } })
    }
    if (method === 'GET' && path === '/channels/chan-1/action/get_listing_calendar') {
      const from = url.searchParams.get('date_from')!
      const days = Array.from({ length: 500 }, (_, i) => ({ date: addDays(from, i), availability: i === 3 ? 'unavailable' : 'available', daily_price: i === 0 ? 210 : 189.5, min_nights: 2, max_nights: 30, closed_to_arrival: false, closed_to_departure: i === 5 }))
      return json({ data: { calendar: { listing_id: LISTING, start_date: from, end_date: url.searchParams.get('date_to'), days } } })
    }
    if (method === 'POST' && path === '/room_types') {
      this.roomTypes.push((JSON.parse(String(init.body)) as { room_type: Record<string, unknown> }).room_type)
      return resource('room_type')
    }
    if (method === 'POST' && path === '/rate_plans') return resource('rate_plan')
    if (method === 'POST' && path === '/restrictions') {
      for (const value of body!.values) this.restrictions[value.date] = { rate: value.rate, min_stay_arrival: value.min_stay_arrival, max_stay: value.max_stay, closed_to_arrival: value.closed_to_arrival, closed_to_departure: value.closed_to_departure, stop_sell: value.stop_sell, rate_plan_id: value.rate_plan_id }
      return json({ meta: { message: 'Success' } })
    }
    if (method === 'POST' && path === '/availability') {
      for (const value of body!.values) this.availability[value.date] = value.availability
      return json({ meta: { message: 'Success' } })
    }
    if (method === 'GET' && path === '/availability') return json({ data: { [Object.keys(this.availability).length ? this.roomType : 'none']: this.availability } })
    if (method === 'GET' && path === '/restrictions') return json({ data: { [this.ratePlan]: Object.fromEntries(Object.entries(this.restrictions).map(([date, rule]) => [date, { ...rule, rate: String(rule.rate) }])) } })
    if (method === 'POST' && path === '/channels/chan-1/mappings') {
      this.channel.ratePlans.push({ id: 'map-1', rate_plan_id: body!.mapping.rate_plan_id, settings: { listing_id: body!.mapping.settings.listing_id } })
      return json({ data: { id: 'map-1', type: 'channel_rate_plan', attributes: {} } })
    }
    if (method === 'PUT' && path === '/channels/chan-1') { this.channel.properties = body!.channel.properties; return json({ data: {} }) }
    if (method === 'DELETE' && path === '/properties/setup-1') return json({ meta: { message: 'Success' } })
    if (method === 'POST' && path === '/channels/chan-1/activate') { this.channel.active = true; return json({ meta: { message: 'Success' } }) }
    if (method === 'GET' && path === '/applications/installed') return json({ data: this.messagesProperty === null ? [] : [{ id: 'messages-app', type: 'application_installation', attributes: { id: 'messages-app', property_id: this.messagesProperty, application_code: 'channex_messages' } }] })
    if (method === 'POST' && path === '/applications/install') {
      this.messagesProperty = (JSON.parse(String(init.body)) as { application_installation: { property_id: string } }).application_installation.property_id
      return json({ data: { id: 'messages-app', type: 'application_installation', attributes: { id: 'messages-app', property_id: this.messagesProperty, application_code: 'channex_messages' } } })
    }
    if (method === 'GET' && path === '/message_threads') return this.failMessages ? new Response('Provider message read unavailable', { status: 503 }) : json({ data: [], meta: { total: 0 } })
    if (method === 'POST' && path === '/channels/chan-1/execute/load_future_reservations') return json({ meta: { message: 'Success' } })
    return new Response(`unexpected ${method} ${path}`, { status: 404 })
  }

  roomType = ''
  ratePlan = ''
}

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'airbnb-import-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'airbnb-import-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const env = {
      ...await runtime.getBindings<CloudflareEnv>(), DB: db, CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
      BETTER_AUTH_URL: BASE, BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test', GOOGLE_CLIENT_ID: 'test-google-client',
      GOOGLE_CLIENT_SECRET: 'test-google-secret', APPLE_APP_BUNDLE_ID: 'com.krabiclaw.app', MEDIA_BASE_URL: 'https://media.proof.example', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as unknown as CloudflareEnv
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', ?)`).bind(ORG, TZ).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('a-owner', ?, 'credential', ?, ?, 0, 0)").bind(OWNER, OWNER, await hashPassword(PASSWORD)).run()
    return { runtime, db, env }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

async function connected(db: D1Database, env: CloudflareEnv, channex: FakeChannex) {
  const connection = new AirbnbConnection(db, env, ORG, OWNER)
  await connection.start()
  await connection.complete(channex.token, 'chan-1')
  return connection
}

const form = { missingDetails: { email: 'Stay@Example.test', phone: '+1 435 555 0100' } }
const manager = { organizationId: ORG, actorId: OWNER, manage: true } as const

async function importAll(connection: AirbnbConnection, db: D1Database, channex: FakeChannex, productId: string): Promise<void> {
  for (let step = 0; step < 14; step++) {
    const mapping = await db.prepare('SELECT room_type_id, rate_plan_id FROM product_channel_mappings WHERE product_id = ?').bind(productId).first<{ room_type_id: string | null; rate_plan_id: string | null }>()
    channex.roomType = mapping?.room_type_id ?? ''
    channex.ratePlan = mapping?.rate_plan_id ?? ''
    if ((await connection.advance(productId)).stage === 'complete') return
  }
  throw new Error('The import did not complete')
}

test('a listing imports through every stage into a home Channex and KrabiClaw agree on', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const details = await connection.details(LISTING)
    // The organization has no contact details yet, so the import asks for them once.
    // Children and infants are not asked: Airbnb counts neither.
    assert.deepEqual(details.missingFields, ['email', 'phone'])
    assert.deepEqual({ timezone: details.fields.timezone, checkIn: details.checkInTime, checkInEnd: details.checkInEndTime, checkOut: details.checkOutTime }, { timezone: TZ, checkIn: '16:00', checkInEnd: '21:00', checkOut: '10:00' })

    const started = await connection.prepare(LISTING, form)
    assert.equal(started.stage, 'property')
    // Asking again returns the same import; nothing is created twice.
    assert.deepEqual(await connection.prepare(LISTING, form), started)
    // What the host typed is now the organization's contact, so the next listing will not ask.
    assert.deepEqual(await db.prepare('SELECT contact_email, contact_phone FROM organization WHERE id = ?').bind(ORG).first(), { contact_email: 'stay@example.test', contact_phone: '+1 435 555 0100' })
    assert.deepEqual((await connection.details(LISTING)).missingFields, [])
    const productId = started.product_id

    const home = await db.prepare(`SELECT p.kind, p.name, c.check_in_time, c.check_in_end_time, c.check_out_time, c.max_guests, c.min_nights, l.title AS location, l.timezone, l.email, pr.unit_amount, pr.currency
      FROM products p JOIN product_stay_configs c ON c.product_id = p.id JOIN business_locations l ON l.id = c.location_id
      JOIN product_variants v ON v.product_id = p.id JOIN prices pr ON pr.product_variant_id = v.id WHERE p.id = ?`).bind(productId).first()
    // Check-in and checkout are Airbnb's window, not anything the client sent.
    assert.deepEqual(home, { kind: 'stay', name: 'Cliff Cabin', check_in_time: '16:00', check_in_end_time: '21:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, location: 'Cliff Cabin', timezone: TZ, email: 'Stay@Example.test', unit_amount: 18_950, currency: 'USD' })
    const nights = await db.prepare("SELECT COUNT(*) AS total, SUM(closed) AS closed, SUM(closed_to_departure) AS ctd, MAX(price_minor) AS top FROM product_nights WHERE product_id = ? AND source = 'import'").bind(productId).first()
    assert.deepEqual(nights, { total: 500, closed: 1, ctd: 1, top: 21_000 })
    const first = await db.prepare('SELECT date, price_minor, max_stay FROM product_nights WHERE product_id = ? ORDER BY date LIMIT 1').bind(productId).first()
    assert.deepEqual(first, { date: today(), price_minor: 21_000, max_stay: 30 })

    const stages: string[] = []
    for (let step = 0; step < 14; step++) {
      const mapping = await db.prepare('SELECT room_type_id, rate_plan_id FROM product_channel_mappings WHERE product_id = ?').bind(productId).first<{ room_type_id: string | null; rate_plan_id: string | null }>()
      channex.roomType = mapping?.room_type_id ?? ''
      channex.ratePlan = mapping?.rate_plan_id ?? ''
      const result = await connection.advance(productId)
      stages.push(result.stage)
      if (result.stage === 'content') {
        // A photo Airbnb cannot serve stops the stage naming the image; the retry keeps the photo already stored.
        channex.failPhoto = PHOTOS[1]!.id
        await assert.rejects(connection.advance(productId), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 502 && error.data?.code === 'PHOTO_FETCH_FAILED'
          && error.data.image_id === PHOTOS[1]!.id && error.data.url === `${CDN}/photos/${PHOTOS[1]!.id}.jpg?im_w=2560`)
        assert.deepEqual(await db.prepare('SELECT import_stage, import_content FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { import_stage: 'content', import_content: null })
        assert.equal((await readStayHome(db, manager, productId)).photos.length, 0)
        channex.failPhoto = null
      }
      if (result.stage === 'messages') {
        const report = result.content!
        assert.deepEqual(report, {
          photos_imported: [PHOTOS[1]!.id, PHOTOS[2]!.id], photos_skipped: [PHOTOS[0]!.id], photos_upgraded: [], photos_removed: [], photos_unplaced: [], unmatched_amenities: ['HOVERBOARD_DOCK'],
          unmapped_check_in_category: null, truncated_fields: [], photo_rooms_skipped: 2,
        } satisfies ImportContentReport)
        channex.failMessages = true
        await assert.rejects(connection.advance(productId), /503/)
        assert.equal(await db.prepare('SELECT import_stage FROM product_channel_mappings WHERE product_id = ?').bind(productId).first('import_stage'), 'messages')
        assert.equal(channex.seen.filter(request => request.path === '/channels/chan-1/execute/load_future_reservations').length, 1)
        channex.failMessages = false
      }
      if (result.stage === 'complete') break
    }
    assert.deepEqual(stages, ['room', 'rate', 'inventory', 'verify_inventory', 'mapping', 'activate', 'reservations', 'content', 'messages', 'complete'])
    const filled = await readStayHome(db, manager, productId)
    assert.deepEqual(filled.photos.map(photo => ({ kind: photo.kind, alt_text: photo.alt_text, position: photo.position, hosted: photo.url.startsWith('https://media.proof.example/') })), [
      { kind: 'image', alt_text: 'The deck at sunset', position: 0, hosted: true }, { kind: 'image', alt_text: null, position: 1, hosted: true }, { kind: 'image', alt_text: 'Bedroom one', position: 2, hosted: true },
    ])
    assert.deepEqual(await db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE organization_id = ? AND source = 'external' AND provider = 'cloudflare_r2' AND status = 'active'").bind(ORG).first(), { n: 3 })
    // Every photo is asked for at 2560 px, never at a rendition Channex names, and its size is recorded.
    assert.ok(channex.photoUrls.length && channex.photoUrls.every(url => url.endsWith('.jpg?im_w=2560')))
    assert.deepEqual(await Promise.all(filled.photos.map(async photo => (await getMediaAsset(db, photo.id, ORG))!.width)), [1, 1, 1])
    // One to one: Airbnb's Listing description is the description; its other texts are the sections of the same names. Its concatenation is not used.
    assert.equal(filled.description, 'A cabin on the cliff.')
    const product = await getProduct(db, ORG, productId)
    assert.deepEqual(Object.fromEntries(Object.entries(product.details).filter(([key]) => key !== 'featured')), {
      your_property: 'Two bedrooms and a deck.', guest_access: 'The whole cabin is yours.', interaction_with_guests: 'We live next door.', other_details_to_note: 'No parties.',
      neighborhood_description: 'Quiet, ten minutes from town.', getting_around: 'Bus 4 stops outside.', house_rules: 'No smoking inside.',
      pets_allowed: true, events_allowed: false, smoking_allowed: false, quiet_hours: true, quiet_hours_start: '23:00', quiet_hours_end: '07:00',
    })
    assert.deepEqual({ start: filled.check_in_time, end: filled.check_in_end_time, checkout: filled.check_out_time }, { start: '16:00', end: '21:00', checkout: '10:00' })
    // Channex's child-only beds and infant cots are 0: Airbnb counts neither.
    assert.deepEqual(channex.roomTypes.map(room => [room.occ_adults, room.occ_children, room.occ_infants]), [[4, 0, 0]])
    assert.deepEqual({ bedrooms: filled.bedrooms, beds: filled.beds, bathrooms: filled.bathrooms, amenities: filled.amenities }, { bedrooms: 2, beds: 3, bathrooms: 1, amenities: ['wireless_internet', 'smoke_detector', 'mountain_view'] })
    assert.deepEqual({ method: filled.check_in_method, check_in: filled.check_in_instructions, manual: filled.house_manual, directions: filled.directions, wifi: filled.wifi_network, password: filled.wifi_password, rooms: filled.photo_rooms }, {
      method: 'smart_lock', check_in: 'Door code 0126', manual: 'Unit 63A. Shoes off, please.', directions: 'Behind the capitol.', wifi: '5 Star', password: 'open sesame', rooms: [],
    })
    assert.equal(channex.seen.filter(request => request.path === '/channels/chan-1/execute/load_future_reservations').length, 1)
    const mapping = await db.prepare('SELECT property_id, room_type_id, rate_plan_id, enabled, import_property, import_calendar, import_content FROM product_channel_mappings WHERE product_id = ?').bind(productId).first<Record<string, unknown>>()
    assert.ok(mapping!.property_id && mapping!.room_type_id && mapping!.rate_plan_id)
    assert.deepEqual([mapping!.enabled, mapping!.import_property, mapping!.import_calendar], [1, null, null])
    assert.deepEqual((JSON.parse(String(mapping!.import_content)) as ImportContentReport).photos_skipped, [PHOTOS[0]!.id])
    assert.equal(Object.keys(channex.availability).length, 500)
    assert.equal(channex.availability[addDays(today(), 3)], 0)
    assert.deepEqual(channex.channel.properties, [mapping!.property_id])
    assert.equal(channex.channel.active, true)
    const connectionRow = await db.prepare('SELECT setup_property_id, operation_id, pending_step FROM channex_connections').first()
    assert.deepEqual(connectionRow, { setup_property_id: null, operation_id: null, pending_step: null })
    assert.deepEqual((await connection.listings())[0]!.import, { status: 'imported', product_id: productId, stage: 'complete', content: JSON.parse(String(mapping!.import_content)) as ImportContentReport })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a listing priced in another currency stops before anything is created', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  channex.currency = 'EUR'
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    await assert.rejects(connection.prepare(LISTING, form), (error: unknown) => (error as { data?: { code?: string } }).data?.code === 'CURRENCY_MISMATCH')
    for (const table of ['business_locations', 'products', 'product_nights', 'product_channel_mappings']) {
      assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n, 0, table)
    }
    assert.deepEqual(await db.prepare('SELECT operation_id, status FROM channex_connections').first(), { operation_id: null, status: 'connected' })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('the backfill route fills a home imported without content and the listings report it', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  channex.content = false
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const productId = (await connection.prepare(LISTING, form)).product_id
    await importAll(connection, db, channex, productId)
    // Imported before Airbnb's content was read: a home with no photos, texts or counts, as the two existing imports are.
    await db.prepare('UPDATE product_channel_mappings SET import_content = NULL WHERE product_id = ?').bind(productId).run()
    const before = await readStayHome(db, manager, productId)
    assert.deepEqual({ photos: before.photos, description: before.description, bedrooms: before.bedrooms, amenities: before.amenities, method: before.check_in_method }, { photos: [], description: '', bedrooms: null, amenities: [], method: null })

    const app = new H3()
    app.get('/api/organizations/:organizationId/integrations/airbnb/listings', listingsRoute)
    app.post('/api/organizations/:organizationId/integrations/airbnb/imports/:productId/content', contentRoute)
    const login = await createAuth(env).api.signInEmail({ body: { email: 'owner@example.test', password: PASSWORD }, asResponse: true })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const call = async (method: string, path: string) => {
      const response = await app.request(Object.assign(new Request(`${BASE}/api/organizations/${ORG}/integrations/airbnb${path}`, { method, headers: { cookie, origin: BASE } }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    const listedBefore = await call('GET', '/listings')
    assert.deepEqual((listedBefore.body.listings as Array<{ import: unknown }>)[0]!.import, { status: 'imported', product_id: productId, stage: 'complete', content: null })

    channex.content = true
    const filled = await call('POST', `/imports/${productId}/content`)
    assert.equal(filled.status, 200)
    assert.deepEqual(filled.body, { product_id: productId, stage: 'complete', content: {
      photos_imported: PHOTOS.map(photo => photo.id), photos_skipped: [], photos_upgraded: [], photos_removed: [], photos_unplaced: [], unmatched_amenities: ['HOVERBOARD_DOCK'], unmapped_check_in_category: null, truncated_fields: [], photo_rooms_skipped: 2,
    } satisfies ImportContentReport })
    const after = await readStayHome(db, manager, productId)
    assert.deepEqual({ captions: after.photos.map(photo => photo.alt_text), bedrooms: after.bedrooms, beds: after.beds, bathrooms: after.bathrooms, amenities: after.amenities, method: after.check_in_method, manual: after.house_manual },
      { captions: ['The deck at sunset', null, 'Bedroom one'], bedrooms: 2, beds: 3, bathrooms: 1, amenities: ['wireless_internet', 'smoke_detector', 'mountain_view'], method: 'smart_lock', manual: 'Unit 63A. Shoes off, please.' })
    assert.equal(after.description, 'A cabin on the cliff.')
    // The check-in window is Airbnb's on a home imported before it was read.
    assert.deepEqual([after.check_in_time, after.check_in_end_time, after.check_out_time], ['16:00', '21:00', '10:00'])
    assert.deepEqual([(await getProduct(db, ORG, productId)).details.guest_access, (await getProduct(db, ORG, productId)).details.quiet_hours_start], ['The whole cabin is yours.', '23:00'])
    // Run again: every photo is already stored, nothing is stored twice, and the listings carry the report.
    const again = await call('POST', `/imports/${productId}/content`)
    assert.deepEqual((again.body.content as ImportContentReport).photos_skipped, PHOTOS.map(photo => photo.id))
    assert.equal((await readStayHome(db, manager, productId)).photos.length, 3)
    assert.deepEqual(await db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE organization_id = ? AND status = 'active'").bind(ORG).first(), { n: 3 })
    const listedAfter = await call('GET', '/listings')
    assert.deepEqual(((listedAfter.body.listings as Array<{ import: { content: ImportContentReport } }>)[0]!.import.content).photos_skipped, PHOTOS.map(photo => photo.id))
    // Photos an earlier import stored at 450 px record no size: the backfill fetches each again at 2560 px into the same
    // photo, so its place, its asset id and its caption stay, and only its file and size change.
    const legacy = await readStayHome(db, manager, productId)
    await db.prepare("UPDATE media_assets SET width = NULL, height = NULL, alt_text = CASE WHEN id = ? THEN 'Host words' ELSE alt_text END WHERE organization_id = ?").bind(legacy.photos[2]!.id, ORG).run()
    const filesBefore = await Promise.all(legacy.photos.map(async photo => (await getMediaAsset(db, photo.id, ORG))!.r2_key))
    channex.failPhoto = PHOTOS[1]!.id
    const refused = await call('POST', `/imports/${productId}/content`)
    assert.deepEqual({ status: refused.status, code: (refused.body.data as Record<string, unknown>).code, image: (refused.body.data as Record<string, unknown>).image_id, url: (refused.body.data as Record<string, unknown>).url },
      { status: 502, code: 'PHOTO_FETCH_FAILED', image: PHOTOS[1]!.id, url: `${CDN}/photos/${PHOTOS[1]!.id}.jpg?im_w=2560` })
    channex.failPhoto = null
    const upgraded = await call('POST', `/imports/${productId}/content`)
    assert.deepEqual({ upgraded: (upgraded.body.content as ImportContentReport).photos_upgraded, skipped: (upgraded.body.content as ImportContentReport).photos_skipped }, { upgraded: [PHOTOS[1]!.id, PHOTOS[2]!.id], skipped: [PHOTOS[0]!.id] })
    const afterUpgrade = await readStayHome(db, manager, productId)
    assert.deepEqual(afterUpgrade.photos.map(photo => [photo.id, photo.alt_text]), legacy.photos.map((photo, index) => [photo.id, index === 2 ? 'Host words' : photo.alt_text]))
    const assetsAfter = await Promise.all(afterUpgrade.photos.map(photo => getMediaAsset(db, photo.id, ORG)))
    assert.deepEqual(assetsAfter.map(asset => asset!.width), [1, 1, 1])
    assert.deepEqual(assetsAfter.map((asset, index) => asset!.r2_key !== filesBefore[index]), [true, true, true])
    assert.equal(await env.MEDIA_BUCKET!.get(filesBefore[1]!), null)
    await db.prepare("UPDATE media_assets SET alt_text = 'Bedroom one' WHERE id = ?").bind(legacy.photos[2]!.id).run()
    // A caption write that did not land is resumed; a caption the host edited is kept.
    await db.prepare('UPDATE media_assets SET alt_text = NULL WHERE id = ?').bind(after.photos[0]!.id).run()
    await db.prepare("UPDATE media_assets SET alt_text = 'Our bedroom' WHERE id = ?").bind(after.photos[2]!.id).run()
    await call('POST', `/imports/${productId}/content`)
    assert.deepEqual((await readStayHome(db, manager, productId)).photos.map(photo => photo.alt_text), ['The deck at sunset', null, 'Our bedroom'])
    // The host deleted one imported photo from the library and Airbnb now has more photos than a home holds:
    // the deleted one stays out, the photos past the limit are never fetched, and both are reported.
    await deleteMediaAsset(db, env, after.photos[1]!.id, ORG, OWNER)
    channex.extraPhotos = 49
    // The run is interrupted after it stored photo x40, so that asset exists without a place on the home.
    channex.failPhoto = `${LISTING}_x41`
    await assert.rejects(call('POST', `/imports/${productId}/content`).then(result => { if (result.status !== 200) throw Object.assign(new Error('refused'), result.body.data) }), (error: { code?: string; image_id?: string }) => error.code === 'PHOTO_FETCH_FAILED' && error.image_id === `${LISTING}_x41`)
    assert.equal((await readStayHome(db, manager, productId)).photos.length, 2)
    channex.failPhoto = null
    const fetchedBefore = channex.photoFetches
    const crowded = await call('POST', `/imports/${productId}/content`)
    assert.equal(crowded.status, 200)
    const crowdedReport = crowded.body.content as ImportContentReport
    assert.deepEqual({ removed: crowdedReport.photos_removed, unplaced: crowdedReport.photos_unplaced, skipped: crowdedReport.photos_skipped.length, imported: crowdedReport.photos_imported.length },
      { removed: [PHOTOS[1]!.id], unplaced: [`${LISTING}_x49`], skipped: 42, imported: 8 })
    assert.equal((await readStayHome(db, manager, productId)).photos.length, 50)
    assert.equal(channex.photoFetches - fetchedBefore, 8)
    assert.deepEqual(await db.prepare('SELECT operation_id, pending_step FROM channex_connections').first(), { operation_id: null, pending_step: null })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a third home on Basic is refused as a home, nothing is saved, and the same form imports after a plan is chosen', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const access = { organizationId: ORG, actorId: OWNER, manage: true }
    const homeEnv = { ...env, DB: db, STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth' } as unknown as CloudflareEnv
    for (const name of ['Dune Hut', 'Reef Hut']) {
      await createStayHome(homeEnv, db, access, stayHomeInput({ name, timezone: TZ, address: `1 ${name} Rd`, city: 'Moab', country: 'US', check_in_time: '15:00', check_out_time: '11:00', max_guests: 2, min_nights: 1, base_price_minor: 100_00 }), name)
    }
    // Basic includes two homes: the import is refused as a home before anything is made, and the contact the host typed is not kept.
    await assert.rejects(connection.prepare(LISTING, form), { status: 402, data: { error: 'Basic includes 2 homes. Choose Growth or Business in Billing to add more.', code: 'HOME_LIMIT', homes: { used: 2, covered: 2 } } })
    assert.deepEqual([await count(db, 'business_locations'), await count(db, 'products'), await count(db, 'product_channel_mappings')], [2, 2, 0])
    assert.deepEqual(await db.prepare('SELECT contact_email, contact_phone FROM organization WHERE id = ?').bind(ORG).first(), { contact_email: null, contact_phone: null })
    assert.deepEqual((await connection.details(LISTING)).missingFields, ['email', 'phone'])
    // On Growth the same form, with the same details, imports; the contact is kept once the home is made.
    // A phone set in Brand › Contact meanwhile is no longer missing: the form no longer carries it, and the import keeps it.
    await db.prepare("UPDATE organization SET contact_phone = '+1 435 555 0199' WHERE id = ?").bind(ORG).run()
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, periodEnd) VALUES ('sub-org', 'growth', ?, 'active', 1, ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86_400).run()
    const { phone: _phone, ...withoutPhone } = form.missingDetails
    const started = await connection.prepare(LISTING, { ...form, missingDetails: withoutPhone })
    assert.equal(started.stage, 'property')
    assert.deepEqual([await count(db, 'business_locations'), await count(db, 'products'), await count(db, 'product_channel_mappings')], [3, 3, 1])
    assert.deepEqual(await db.prepare('SELECT contact_email, contact_phone FROM organization WHERE id = ?').bind(ORG).first(), { contact_email: 'stay@example.test', contact_phone: '+1 435 555 0199' })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('the import asks only for what Airbnb leaves out and stops when Airbnb has no check-in start or checkout', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const app = new H3()
    app.post('/api/organizations/:organizationId/integrations/airbnb/listings/:listingId/import', importRoute)
    const login = await createAuth(env).api.signInEmail({ body: { email: 'owner@example.test', password: PASSWORD }, asResponse: true })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const start = async (body: Record<string, unknown>) => {
      const response = await app.request(Object.assign(new Request(`${BASE}/api/organizations/${ORG}/integrations/airbnb/listings/${LISTING}/import`, {
        method: 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    // Times are Airbnb's and children and infants are not asked: a client still sending them is refused, not ignored.
    assert.deepEqual(await start({ ...form, checkInTime: '15:00', checkOutTime: '11:00' }), { status: 400, body: { error: 'checkInTime is not accepted; the import takes it from Airbnb', code: 'VALIDATION_ERROR', field: 'checkInTime' } })
    assert.deepEqual((await start({ missingDetails: { ...form.missingDetails, childBeds: '1' } })).body.data, { code: 'ONLY_MISSING_DETAILS' })
    // "FLEXIBLE" or "NOT_SELECTED" is no start: the import stops naming Airbnb's field, and nothing is made.
    for (const [setting, field] of [[{ check_in_time_start: 'NOT_SELECTED' }, 'booking_settings.check_in_time_start'], [{ check_out_time: null }, 'booking_settings.check_out_time']] as const) {
      channex.booking = { ...channex.booking, check_in_time_start: '16', check_out_time: 10, ...setting }
      const refused = await start(form)
      assert.deepEqual({ status: refused.status, data: refused.body.data }, { status: 422, data: { code: 'MISSING_AIRBNB_FIELD', field } })
      assert.deepEqual([await count(db, 'business_locations'), await count(db, 'products'), await count(db, 'product_channel_mappings')], [0, 0, 0])
    }
    // A flexible end is a home whose check-in window has no end; an hour after midnight is that hour.
    channex.booking = { ...channex.booking, check_in_time_start: '16', check_in_time_end: 'FLEXIBLE', check_out_time: 10 }
    assert.equal((await connection.details(LISTING)).checkInEndTime, null)
    channex.booking = { ...channex.booking, check_in_time_end: '25' }
    assert.equal((await connection.details(LISTING)).checkInEndTime, '01:00')
    const started = await start(form)
    assert.equal(started.status, 202)
    assert.deepEqual(await db.prepare('SELECT check_in_time, check_in_end_time, check_out_time FROM product_stay_configs WHERE product_id = ?').bind(started.body.product_id).first(), { check_in_time: '16:00', check_in_end_time: '01:00', check_out_time: '10:00' })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

async function count(db: D1Database, table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n
}
