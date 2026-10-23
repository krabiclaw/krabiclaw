import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { AirbnbConnection, type ImportContentReport } from '../../server/integrations/channex/airbnb-connection.ts'
import { createStayHome, readStayHome, stayHomeInput, updateStayHome } from '../../server/domain/stays.ts'
import { deleteMediaAsset, getMediaAsset } from '../../server/utils/media-asset-manager.ts'
import { getProduct } from '../../server/utils/product-management.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import { countActiveHomes } from '../../server/utils/billing.ts'
import contentRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/imports/[productId]/content.post.ts'
import syncPostRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/sync.post.ts'
import syncGetRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/sync.get.ts'
import { requestAirbnbSync, runAirbnbSyncJobs } from '../../server/integrations/channex/airbnb-sync.ts'
import listingsRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/listings.get.ts'

// An Airbnb listing imported as a home, through every stage, against a fake
// Channex: the location, the stay product and its price, the imported nights,
// the listing's content (photos, texts, counts, amenities) and the Channex ids
// all land, and Channex holds exactly the calendar pushed. An import stops as
// a draft, free and not synced; Activate checks the plan before Channex maps
// the listing, and the import then runs to complete.

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
  mappingIds = 0
  rateProperties = new Map<string, string>()
  channel = { title: '', active: false, properties: ['setup-1'], ratePlans: [] as Array<{ id: string; rate_plan_id: string; settings: { listing_id: string } }> }
  availability: Record<string, number> = {}
  restrictions: Record<string, Record<string, unknown>> = {}
  token = ''
  channelId = 'chan-1'
  listings = [LISTING]
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
  /** The listing settings writes Channex received, in order. */
  settings: Array<Record<string, unknown>> = []

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace('/api/v1', '').replace(`/channels/${this.channelId}`, '/channels/chan-1')
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
      return json({ data: { id, type: 'property', attributes: {} } })
    }
    if (method === 'POST' && path === '/meta/airbnb/connection_link') {
      this.token = body!.connection_link.token
      this.channel.title = body!.connection_link.title
      return json({ data: { type: 'connection_link', attributes: { url: 'https://www.airbnb.com/oauth2/auth?x=1' } } })
    }
    if (method === 'GET' && path === '/channels/chan-1') {
      return json({ data: { id: this.channelId, type: 'channel', attributes: { channel: 'AirBNB', title: this.channel.title, is_active: this.channel.active, properties: this.channel.properties, rate_plans: this.channel.ratePlans }, relationships: { group: { data: { id: 'grp-1' } } } } })
    }
    if (method === 'GET' && path === '/channels/chan-1/action/listings') return json({ data: { listing_id_dictionary: { values: this.listings.map(id => ({ id, title: 'Cliff Cabin', city: 'Moab', country_code: 'US' })) } } })
    if (method === 'GET' && path === '/channels/chan-1/action/listing_details') {
      const listingId = url.searchParams.get('listing_id')!
      const content = this.content ? {
        images: [...PHOTOS, ...Array.from({ length: this.extraPhotos }, (_, i) => ({ id: `${LISTING}_x${i + 1}`, caption: null, sort_order: PHOTOS.length + i + 1 }))].map(photo => ({ ...photo, listing_id: listingId, category: 'LISTING', thumbnail_url: `${CDN}/photos/${photo.id}.jpg?aki_policy=x_small`, small_url: `${CDN}/photos/${photo.id}.jpg?aki_policy=small`, extra_medium_url: `${CDN}/photos/${photo.id}.jpg?aki_policy=x_medium` })),
        descriptions: { summary: 'A cabin on the cliff.', description: 'A cabin on the cliff.\n\nTwo bedrooms.', space: 'Two bedrooms and a deck.', access: 'The whole cabin is yours.', interaction: 'We live next door.', neighborhood_overview: 'Quiet, ten minutes from town.', transit: 'Bus 4 stops outside.', notes: 'No parties.', house_rules: 'No smoking inside.', name: 'Cliff Cabin', locale: 'en' },
        amenities: { WIRELESS_INTERNET: { instruction: '', is_present: true }, SMOKE_DETECTOR: { instruction: '', is_present: true }, HOVERBOARD_DOCK: { instruction: '', is_present: true }, CRIB: { instruction: '', is_present: false } },
        listing_views: ['MOUNTAIN_VIEW'],
        rooms: [{ id: 'r1', listing_id: listingId, room_type: 'bedroom', is_private: true, beds: [{ quantity: 1, type: 'queen_bed' }], accessibility_features: [] }, { id: 'r2', listing_id: listingId, room_type: 'bedroom', is_private: true, beds: [{ quantity: 2, type: 'queen_bed' }], accessibility_features: [] }],
        bedrooms: 2, beds: 3, bathrooms: 1, house_manual: 'Unit 63A. Shoes off, please.', directions: 'Behind the capitol.', wifi_network: '5 Star', wifi_password: 'open sesame',
        check_in_option: { category: 'smartlock', instruction: 'Door code 0126' },
        quiet_hours: [{ start_time: '23', end_time: '7' }],
      } : { rooms: [] }
      return json({ data: { listing: { id: listingId, name: 'Cliff Cabin', person_capacity: 4, lat: 38.5733, lng: -109.5498, country_code: 'US', state: 'UT', city: 'Moab', street: '1 Cliff Rd', zipcode: '84532', property_type_category: 'holiday_home', booking_settings: this.booking, pricing_settings: { listing_currency: this.currency, guests_included: 2, default_daily_price: 189.5 }, ...content } } })
    }
    if (method === 'GET' && path === '/channels/chan-1/action/get_listing_calendar') {
      const from = url.searchParams.get('date_from')!
      const days = Array.from({ length: 500 }, (_, i) => ({ date: addDays(from, i), availability: i === 3 ? 'unavailable' : 'available', daily_price: i === 0 ? 210 : 189.5, min_nights: 2, max_nights: 30, closed_to_arrival: false, closed_to_departure: i === 5 }))
      return json({ data: { calendar: { listing_id: url.searchParams.get('listing_id'), start_date: from, end_date: url.searchParams.get('date_to'), days } } })
    }
    // The room type and rate plan the inventory reads are about are the last ones created.
    if (method === 'POST' && path === '/room_types') {
      this.roomTypes.push((JSON.parse(String(init.body)) as { room_type: Record<string, unknown> }).room_type)
      this.roomType = `room_type-${this.ids + 1}`
      return resource('room_type')
    }
    if (method === 'POST' && path === '/rate_plans') {
      this.ratePlan = `rate_plan-${this.ids + 1}`
      this.rateProperties.set(this.ratePlan, (JSON.parse(String(init.body)) as { rate_plan: { property_id: string } }).rate_plan.property_id)
      return resource('rate_plan')
    }
    if (method === 'PUT' && path === '/channels/chan-1/execute/update_booking_setting') { this.settings.push({ booking: (JSON.parse(String(init.body)) as Record<string, unknown>) }); return json({ data: {} }) }
    if (method === 'PUT' && /^\/channels\/chan-1\/mappings\/[^/]+\/(availability|pricing)_settings$/.test(path)) { this.settings.push({ [path.split('/').pop()!]: JSON.parse(String(init.body)) }); return json({ data: {} }) }
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
      const id = `map-${++this.mappingIds}`
      // Channex's Airbnb mapping endpoint attaches this rate plan's property automatically.
      const property = this.rateProperties.get(body!.mapping.rate_plan_id)
      assert.ok(property)
      if (!this.channel.properties.includes(property)) this.channel.properties.push(property)
      this.channel.ratePlans.push({ id, rate_plan_id: body!.mapping.rate_plan_id, settings: { listing_id: body!.mapping.settings.listing_id } })
      return json({ data: { id, type: 'channel_rate_plan', attributes: {} } })
    }
    if (method === 'PUT' && path === '/channels/chan-1') { this.channel.properties = body!.channel.properties; return json({ data: {} }) }
    if (method === 'DELETE' && path === '/properties/setup-1') return json({ meta: { message: 'Success' } })
    if (method === 'POST' && path === '/channels/chan-1/activate') { this.channel.active = true; return json({ meta: { message: 'Success' } }) }
    if (method === 'POST' && path === '/channels/chan-1/deactivate') { this.channel.active = false; return json({ meta: { message: 'Success' } }) }
    if (method === 'DELETE' && path === '/channels/chan-1') return json({ meta: { message: 'Success' } })
    if (method === 'DELETE' && path.startsWith('/channels/chan-1/mappings/')) {
      this.channel.ratePlans = this.channel.ratePlans.filter(entry => entry.id !== path.split('/').pop())
      return json({ meta: { message: 'Success' } })
    }
    if (method === 'DELETE' && path === '/applications/messages-app/uninstall') { this.messagesProperty = null; return json({ meta: { message: 'Success' } }) }
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

/** Tell the fake which Channex room type and rate plan the import's reads are about. */
async function track(db: D1Database, channex: FakeChannex, productId: string): Promise<void> {
  const mapping = await db.prepare('SELECT room_type_id, rate_plan_id FROM product_channel_mappings WHERE product_id = ?').bind(productId).first<{ room_type_id: string | null; rate_plan_id: string | null }>()
  channex.roomType = mapping?.room_type_id ?? ''
  channex.ratePlan = mapping?.rate_plan_id ?? ''
}

/** Advance until the import rests at `until`. */
async function advanceTo(connection: AirbnbConnection, db: D1Database, channex: FakeChannex, productId: string, until: 'draft' | 'complete'): Promise<void> {
  for (let step = 0; step < 14; step++) {
    await track(db, channex, productId)
    if ((await connection.advance(productId)).stage === until) return
  }
  throw new Error(`The import did not reach ${until}`)
}

async function importAll(connection: AirbnbConnection, db: D1Database, channex: FakeChannex, productId: string): Promise<void> {
  await advanceTo(connection, db, channex, productId, 'draft')
  await connection.activate(productId)
  await advanceTo(connection, db, channex, productId, 'complete')
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
      await track(db, channex, productId)
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
      if (result.stage === 'draft') {
        const report = result.content!
        assert.deepEqual(report, {
          photos_imported: [PHOTOS[1]!.id, PHOTOS[2]!.id], photos_skipped: [PHOTOS[0]!.id], photos_upgraded: [], photos_removed: [], photos_unplaced: [], unmatched_amenities: ['HOVERBOARD_DOCK'],
          unmapped_check_in_category: null, truncated_fields: [], photo_rooms_skipped: 2, kept_host_edits: [],
        } satisfies ImportContentReport)
        // A draft: built, not mapped, not synced, not live. Advancing it again changes nothing.
        assert.deepEqual(channex.channel.ratePlans, [])
        assert.equal(channex.channel.active, false)
        assert.equal(channex.seen.some(request => request.path === '/channels/chan-1/mappings' || request.path === '/channels/chan-1/activate'), false)
        assert.equal(await db.prepare('SELECT enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first('enabled'), 0)
        assert.equal((await readStayHome(db, manager, productId)).live, false)
        assert.deepEqual((await readStayHome(db, manager, productId)).channel, { provider: 'channex', status: 'importing' })
        const requests = channex.seen.length
        assert.deepEqual(await connection.advance(productId), { product_id: productId, stage: 'draft', waiting: false, content: report })
        assert.equal(channex.seen.filter(request => request.method !== 'GET').length, channex.seen.slice(0, requests).filter(request => request.method !== 'GET').length)
        assert.deepEqual(await connection.activate(productId), { product_id: productId, stage: 'mapping', waiting: false })
        stages.push('activated')
      }
      if (result.stage === 'messages') {
        assert.equal((await readStayHome(db, manager, productId)).live, true)
        channex.failMessages = true
        await assert.rejects(connection.advance(productId), /503/)
        assert.equal(await db.prepare('SELECT import_stage FROM product_channel_mappings WHERE product_id = ?').bind(productId).first('import_stage'), 'messages')
        assert.equal(channex.seen.filter(request => request.path === '/channels/chan-1/execute/load_future_reservations').length, 1)
        channex.failMessages = false
      }
      if (result.stage === 'complete') break
    }
    assert.deepEqual(stages, ['room', 'rate', 'inventory', 'verify_inventory', 'content', 'draft', 'activated', 'activate', 'reservations', 'messages', 'complete'])
    // Activating a home past its draft answers where it is, unchanged.
    assert.deepEqual(await connection.activate(productId), { product_id: productId, stage: 'complete', waiting: false })
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
    const report = JSON.parse(String(mapping!.import_content)) as ImportContentReport
    assert.deepEqual((await connection.listings())[0]!.import, { status: 'imported', product_id: productId, stage: 'complete', syncing: true, content: report })

    // Every syncing home names its Airbnb listing and that listing's editor.
    assert.deepEqual([filled.airbnb_listing_id, filled.airbnb_editor_url], [LISTING, `https://www.airbnb.com/hosting/listings/editor/${LISTING}/details`])
    // Editing what Airbnb takes through Channex sends it: the check-in window in whole hours (after midnight is past 24),
    // the house rules, the cancellation policy as Airbnb's own, and the minimum stay.
    channex.settings = []
    const edited = await updateStayHome(env, db, manager, productId, { check_in_time: '17:00', check_in_end_time: '01:00', check_out_time: '10:00', cancellation_policy: 'limited', min_nights: 3 })
    assert.deepEqual([edited.channel_push, edited.airbnb_unsynced], [{ state: 'pushed', detail: null }, []])
    assert.deepEqual(channex.settings, [
      { booking: { channel_rate_plan_id: 'map-1', data: { check_in_time_start: '17', check_in_time_end: '25', check_out_time: 10,
        guest_controls: { allows_pets_as_host: true, allows_smoking_as_host: false, allows_events_as_host: false }, cancellation_policy_settings: { cancellation_policy_category: 'firm_14' } } } },
      { availability_settings: { availability_settings: { default_min_nights: 3 } } },
    ])
    // A value Airbnb cannot take is refused before the home changes.
    await assert.rejects(updateStayHome(env, db, manager, productId, { check_in_time: '16:30' }), (error: { status?: number; data?: Record<string, unknown> }) =>
      error.status === 422 && error.data?.code === 'AIRBNB_UNSUPPORTED_VALUE' && error.data.field === 'check_in_time' && !Object.hasOwn(error.data, 'committed'))
    assert.equal((await readStayHome(db, manager, productId)).check_in_time, '17:00')
    // Airbnb offers no Strict: a home syncing with it is refused one before anything is written.
    await assert.rejects(updateStayHome(env, db, manager, productId, { cancellation_policy: 'strict' }), { status: 422, data: { code: 'AIRBNB_UNSUPPORTED_VALUE', field: 'cancellation_policy' } })
    assert.equal((await readStayHome(db, manager, productId)).cancellation_policy, 'limited')
    // What Airbnb does not take is kept here and named, with where to change it on Airbnb.
    channex.settings = []
    const described = await updateStayHome(env, db, manager, productId, { description: 'Our own words.', wifi_network: 'Cliff 5G', wifi_password: 'cliffside' })
    assert.deepEqual(described.airbnb_unsynced, [
      { field: 'description', airbnb_url: `https://www.airbnb.com/hosting/listings/editor/${LISTING}/details/description` },
      { field: 'wifi', airbnb_url: `https://www.airbnb.com/hosting/listings/editor/${LISTING}/arrival/wifi-details` },
    ])
    assert.deepEqual(channex.settings, [])

    // Stop syncing: the listing's mapping is removed from the channel and its Messages app uninstalled, the channel stays
    // active, and the home is a free draft again with everything it had.
    assert.equal(channex.messagesProperty, mapping!.property_id)
    assert.deepEqual(await connection.deactivate(productId), { product_id: productId, stage: 'draft', waiting: false })
    assert.deepEqual([channex.channel.ratePlans, channex.messagesProperty, channex.channel.active], [[], null, true])
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled, import_content FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { import_stage: 'draft', enabled: 0, import_content: mapping!.import_content })
    const drafted = await readStayHome(db, manager, productId)
    assert.deepEqual([drafted.live, drafted.photos.length, drafted.description, drafted.base_price_minor], [false, 3, 'Our own words.', filled.base_price_minor])
    // A draft is not syncing: an edit names nothing for Airbnb.
    assert.deepEqual((await updateStayHome(env, db, manager, productId, { description: 'Our own words, again.' })).airbnb_unsynced, [])
    assert.deepEqual((await connection.listings())[0]!.import, { status: 'imported', product_id: productId, stage: 'draft', syncing: false, content: report })
    assert.deepEqual(await db.prepare('SELECT operation_id, pending_step FROM channex_connections').first(), { operation_id: null, pending_step: null })
    // Again on a draft: answered as it is, nothing sent.
    const sent = channex.seen.filter(request => request.method !== 'GET').length
    assert.deepEqual(await connection.deactivate(productId), { product_id: productId, stage: 'draft', waiting: false })
    assert.equal(channex.seen.filter(request => request.method !== 'GET').length, sent)
    // Activate syncs it again, through the same stages.
    assert.deepEqual(await connection.activate(productId), { product_id: productId, stage: 'mapping', waiting: false })
    await advanceTo(connection, db, channex, productId, 'complete')
    assert.deepEqual([channex.channel.ratePlans.length, channex.messagesProperty, (await readStayHome(db, manager, productId)).live], [1, mapping!.property_id, true])
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
    assert.deepEqual((listedBefore.body.listings as Array<{ import: unknown }>)[0]!.import, { status: 'imported', product_id: productId, stage: 'complete', syncing: true, content: null })

    channex.content = true
    const filled = await call('POST', `/imports/${productId}/content`)
    assert.equal(filled.status, 200)
    assert.deepEqual(filled.body, { product_id: productId, stage: 'complete', content: {
      photos_imported: PHOTOS.map(photo => photo.id), photos_skipped: [], photos_upgraded: [], photos_removed: [], photos_unplaced: [], unmatched_amenities: ['HOVERBOARD_DOCK'], unmapped_check_in_category: null, truncated_fields: [], photo_rooms_skipped: 2, kept_host_edits: [],
    } satisfies ImportContentReport })
    const after = await readStayHome(db, manager, productId)
    assert.deepEqual({ captions: after.photos.map(photo => photo.alt_text), bedrooms: after.bedrooms, beds: after.beds, bathrooms: after.bathrooms, amenities: after.amenities, method: after.check_in_method, manual: after.house_manual },
      { captions: ['The deck at sunset', null, 'Bedroom one'], bedrooms: 2, beds: 3, bathrooms: 1, amenities: ['wireless_internet', 'smoke_detector', 'mountain_view'], method: 'smart_lock', manual: 'Unit 63A. Shoes off, please.' })
    assert.equal(after.description, 'A cabin on the cliff.')
    // The check-in window is Airbnb's on a home imported before it was read.
    assert.deepEqual([after.check_in_time, after.check_in_end_time, after.check_out_time], ['16:00', '21:00', '10:00'])
    assert.deepEqual([(await getProduct(db, ORG, productId)).details.guest_access, (await getProduct(db, ORG, productId)).details.quiet_hours_start], ['The whole cabin is yours.', '23:00'])
    // Run again: every photo is already stored, nothing is stored twice, and the listings carry the report.
    // The host's own description since the last run is kept; the other texts still holding Airbnb's take Airbnb's again.
    await updateStayHome(env, db, manager, productId, { description: 'The host wrote this.' })
    const again = await call('POST', `/imports/${productId}/content`)
    assert.deepEqual((again.body.content as ImportContentReport).kept_host_edits, ['description'])
    assert.equal((await readStayHome(db, manager, productId)).description, 'The host wrote this.')
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

test('a sync request is checked against the plan once, then KrabiClaw imports, activates and stops listings in the background', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    await connected(db, env, channex)
    // The owner hosts with a published profile, so the two homes added by hand can be published.
    await db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, windows_json, windows_until, public_name, public_bio, public_approved, calendar_revision, updated_at, updated_by)
      VALUES ('m-owner', ?, ?, '[]', '[]', '[]', '2026-10-15T00:00:00.000Z', 'Owner Host', NULL, 1, 'revision', '2026-10-15T00:00:00.000Z', ?)`).bind(ORG, TZ, OWNER).run()
    for (const name of ['Dune Hut', 'Reef Hut']) {
      const made = await createStayHome(env, db, manager, stayHomeInput({ name, timezone: TZ, address: `1 ${name} Rd`, city: 'Moab', country: 'US', check_in_time: '15:00', check_out_time: '11:00', max_guests: 2, min_nights: 1, base_price_minor: 100_00 }), name)
      await updateStayHome(env, db, manager, made.product_id, { assigned_member_id: 'm-owner' })
      assert.equal((await updateStayHome(env, db, manager, made.product_id, { published: true })).home.live, true)
    }

    const app = new H3()
    app.post('/api/organizations/:organizationId/integrations/airbnb/sync', syncPostRoute)
    app.get('/api/organizations/:organizationId/integrations/airbnb/sync', syncGetRoute)
    const login = await createAuth(env).api.signInEmail({ body: { email: 'owner@example.test', password: PASSWORD }, asResponse: true })
    const token = login.headers.get('set-auth-token')
    assert.ok(token, 'Better Auth answers a bearer token for the app')
    // The first slice a request starts runs after the answer, as the Worker's waitUntil runs it.
    const background: Array<Promise<unknown>> = []
    // As the iPhone app calls: a bearer session and no browser origin.
    const call = async (method: string, body?: unknown) => {
      const response = await app.request(Object.assign(new Request(`${BASE}/api/organizations/${ORG}/integrations/airbnb/sync`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }),
        { runtime: { name: 'cloudflare', cloudflare: { env, context: { waitUntil: (promise: Promise<unknown>) => background.push(promise) } } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    const settle = async () => { await Promise.all(background.splice(0)) }
    // The cron task's run: as many as it takes, each a slice of its own.
    const cron = async () => { for (let run = 0; run < 6; run++) await runAirbnbSyncJobs(env, Date.now() + 60_000) }
    const job = () => db.prepare('SELECT action, state, product_id, last_error_code, attempts FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first<Record<string, unknown>>()

    // Basic with two live homes: syncing a third is refused before anything is queued, with the quote.
    const writesBefore = channex.seen.filter(request => request.method !== 'GET').length
    const refused = await call('POST', { sync: [{ listing_id: LISTING }] })
    assert.equal(refused.status, 402)
    const data = (refused.body as { data: Record<string, unknown> }).data
    assert.deepEqual({ ...data, quote: (data.quote as { adding: unknown }).adding }, {
      error: 'Basic includes 2 homes. Choose Growth or Business in Billing to add more.', code: 'HOME_LIMIT', homes: { used: 2, covered: 2 },
      quote: { count: 1, additional_homes: 1, amount_minor: 900, allowed: false },
    })
    assert.equal(await job(), null)
    assert.equal(channex.seen.filter(request => request.method !== 'GET').length, writesBefore)

    // On Growth it is queued and runs in the background. The organization has no contact email or phone and the
    // request names none: the listing fails with the field, and nothing is made.
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, periodEnd) VALUES ('sub-org', 'growth', ?, 'active', 1, ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86_400).run()
    const queued = await call('POST', { sync: [{ listing_id: LISTING }] })
    assert.equal(queued.status, 202)
    assert.deepEqual((queued.body.listings as Array<Record<string, unknown>>).map(listing => [listing.listing_id, listing.action, listing.status]), [[LISTING, 'sync', 'queued']])
    await settle()
    assert.deepEqual(await job(), { action: 'sync', state: 'failed', product_id: null, last_error_code: 'MISSING_DETAIL', attempts: 1 })
    const failedRow = ((await call('GET')).body.listings as Array<{ status: string; error: { code: string } }>)[0]!
    assert.deepEqual([failedRow.status, failedRow.error.code], ['failed', 'MISSING_DETAIL'])
    assert.equal(await count(db, 'product_channel_mappings'), 0)

    // With the missing contact in the request's details, the same listing imports, a few photos per step, and goes live.
    channex.extraPhotos = 8
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING, details: form.missingDetails }] })).status, 202)
    await settle()
    await cron()
    const done = await job()
    assert.deepEqual({ ...done, product_id: null }, { action: 'sync', state: 'done', product_id: null, last_error_code: null, attempts: 0 })
    const productId = done!.product_id as string
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { import_stage: 'complete', enabled: 1 })
    assert.deepEqual(((await call('GET')).body.listings as Array<Record<string, unknown>>).map(listing => [listing.product_id, listing.action, listing.status, listing.stage, listing.error]), [[productId, 'sync', 'done', 'complete', null]])
    assert.equal(channex.photoFetches, 11)
    assert.equal((await readStayHome(db, manager, productId)).photos.length, 11)
    assert.equal(await countActiveHomes(db, ORG), 3)
    assert.equal(channex.channel.ratePlans.length, 1)

    // Unchecked: the job stops it, and it is a free draft again.
    const stopped = await call('POST', { stop: [productId] })
    assert.deepEqual([stopped.status, (stopped.body.listings as Array<Record<string, unknown>>)[0]!.action], [202, 'stop'])
    await settle()
    assert.deepEqual(await job(), { action: 'stop', state: 'done', product_id: productId, last_error_code: null, attempts: 0 })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { import_stage: 'draft', enabled: 0 })
    assert.deepEqual([channex.channel.ratePlans, await countActiveHomes(db, ORG)], [[], 2])
    // A home found partway through activation (as one interrupted at `messages`) is carried to complete. A provider
    // failure on the way is retried on its own: the listing shows its attempts and when the next one runs.
    const connection = new AirbnbConnection(db, env, ORG, OWNER)
    await connection.activate(productId)
    for (let step = 0; step < 6 && (await connection.advance(productId)).stage !== 'messages'; step++);
    assert.equal(await db.prepare('SELECT import_stage FROM product_channel_mappings WHERE product_id = ?').bind(productId).first('import_stage'), 'messages')
    channex.failMessages = true
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    await settle()
    assert.deepEqual(await job(), { action: 'sync', state: 'error', product_id: productId, last_error_code: 'CHANNEX_REQUEST_FAILED', attempts: 1 })
    const retrying = ((await call('GET')).body.listings as Array<Record<string, unknown>>)[0]!
    assert.deepEqual([retrying.status, retrying.stage, retrying.attempts, typeof retrying.next_attempt_at, (retrying.error as { code: string }).code], ['running', 'messages', 1, 'string', 'CHANNEX_REQUEST_FAILED'])
    channex.failMessages = false
    await db.prepare("UPDATE airbnb_sync_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE listing_id = ?").bind(LISTING).run()
    await cron()
    assert.deepEqual(await job(), { action: 'sync', state: 'done', product_id: productId, last_error_code: null, attempts: 1 })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { import_stage: 'complete', enabled: 1 })
    assert.equal(((await call('GET')).body.listings as Array<Record<string, unknown>>)[0]!.next_attempt_at, null)
    assert.equal((await call('POST', { stop: [productId] })).status, 202)
    await settle()

    // On Basic again, making it live once more would be the third: refused at the request.
    await db.prepare("DELETE FROM subscription WHERE id = 'sub-org'").run()
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 402)
    // A request naming nothing, an unknown listing or a home not from Airbnb is refused.
    assert.equal((await call('POST', {})).status, 422)
    assert.equal((await call('POST', { sync: [{ listing_id: 'listing-404' }] })).status, 404)
    assert.equal((await call('POST', { stop: ['not-a-home'] })).status, 404)
    // Details may only hold what the listing's details report missing, each non-empty.
    const extra = await call('POST', { sync: [{ listing_id: LISTING, details: { city: 'Elsewhere' } }] })
    assert.deepEqual([extra.status, (extra.body as { data: Record<string, unknown> }).data.code, (extra.body as { data: Record<string, unknown> }).data.field], [422, 'ONLY_MISSING_DETAILS', 'details.city'])
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING, details: { email: ' ' } }] })).status, 422)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a full-plan sync swap stops its old home before activation and reconnects the same home on a new channel', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    channex.listings.push('listing-88', 'listing-99')
    const first = await connection.prepare(LISTING, form)
    await importAll(connection, db, channex, first.product_id)
    const second = await connection.prepare('listing-88', { missingDetails: {} })
    await importAll(connection, db, channex, second.product_id)
    const replacement = await connection.prepare('listing-99', { missingDetails: {} })
    await advanceTo(connection, db, channex, replacement.product_id, 'draft')
    assert.equal(await countActiveHomes(db, ORG), 2)
    const queued = await requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: 'listing-99' }], stop: [first.product_id] })
    assert.equal(queued.length, 2)
    await db.prepare('UPDATE airbnb_sync_jobs SET next_attempt_at = ? WHERE action = ?').bind(new Date(Date.now() + 60_000).toISOString(), 'stop').run()
    assert.deepEqual(await runAirbnbSyncJobs(env, Date.now() + 1_000), { stepped: 0, done: 0, failed: 0 })
    assert.equal((await readStayHome(db, manager, replacement.product_id)).live, false, 'a delayed stop retains the home allowance until it finishes')
    await db.prepare("UPDATE airbnb_sync_jobs SET next_attempt_at = NULL WHERE action = 'stop'").run()
    const totals = await runAirbnbSyncJobs(env, Date.now() + 60_000)
    assert.equal(totals.done, 2)
    assert.equal(totals.failed, 0)
    assert.deepEqual(await db.prepare('SELECT listing_id, action, state, last_error_code FROM airbnb_sync_jobs ORDER BY listing_id').all().then(result => result.results), [
      { listing_id: LISTING, action: 'stop', state: 'done', last_error_code: null },
      { listing_id: 'listing-99', action: 'sync', state: 'done', last_error_code: null },
    ])
    assert.deepEqual([(await readStayHome(db, manager, first.product_id)).live, (await readStayHome(db, manager, replacement.product_id)).live, await countActiveHomes(db, ORG)], [false, true, 2])

    while (!(await connection.disconnect()).disconnected);
    channex.channelId = 'chan-2'
    channex.channel.properties = ['setup-1']
    await connection.start()
    await connection.complete(channex.token, 'chan-2')
    const photosBefore = (await readStayHome(db, manager, replacement.product_id)).photos.map(photo => photo.id)
    await requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: 'listing-99' }] })
    const reconnected = await runAirbnbSyncJobs(env, Date.now() + 60_000)
    assert.equal(reconnected.done, 1, JSON.stringify(await db.prepare('SELECT state, last_error_code, last_error FROM airbnb_sync_jobs WHERE listing_id = ?').bind('listing-99').first()))
    assert.deepEqual(await db.prepare('SELECT channel_id, import_stage, enabled FROM product_channel_mappings WHERE product_id = ?').bind(replacement.product_id).first(), { channel_id: 'chan-2', import_stage: 'complete', enabled: 1 })
    assert.equal(await count(db, 'products'), 3, 'reconnection retains the existing home')
    assert.deepEqual((await readStayHome(db, manager, replacement.product_id)).photos.map(photo => photo.id), photosBefore)
    assert.equal((await connection.listings()).find(listing => listing.id === 'listing-99')!.import.status, 'imported')
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('slice deadlines cancel provider reads and photo bodies, and uncertain writes stay failed without duplicate mutations', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const prepared = await connection.prepare(LISTING, form)
    const job = () => db.prepare('SELECT state, last_error_code, attempts, lease_token, lease_until FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first()
    const stalled = (matches: (url: URL, init: RequestInit) => boolean, body = false) => {
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
        if (!matches(url, init)) return channex.fetch(input, init)
        assert.ok(init.signal, 'the provider boundary receives the current slice deadline')
        if (body) return new Response(new ReadableStream({ start(controller) { init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }) } }))
        return new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }) })
      }
    }
    await requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: LISTING }] })
    stalled(url => url.pathname === '/api/v1/channels/chan-1')
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 1_000)).failed, 1)
    assert.deepEqual(await job(), { state: 'error', last_error_code: 'SYNC_SLICE_ENDED', attempts: 1, lease_token: null, lease_until: null })
    assert.deepEqual(await db.prepare('SELECT status, operation_id, pending_step FROM channex_connections').first(), { status: 'connected', operation_id: null, pending_step: null })

    globalThis.fetch = channex.fetch as typeof fetch
    for (let step = 0; step < 6; step++) { if ((await connection.advance(prepared.product_id)).stage === 'content') break }
    assert.equal(await db.prepare('SELECT import_stage FROM product_channel_mappings').first('import_stage'), 'content')
    await requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: LISTING }] })
    stalled(url => url.origin === CDN, true)
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 1_000)).failed, 1)
    assert.deepEqual(await job(), { state: 'error', last_error_code: 'SYNC_SLICE_ENDED', attempts: 1, lease_token: null, lease_until: null })
    assert.equal(await count(db, 'media_assets'), 0)
    assert.deepEqual(await db.prepare('SELECT operation_id, pending_step FROM channex_connections').first(), { operation_id: null, pending_step: null })

    globalThis.fetch = channex.fetch as typeof fetch
    await requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: LISTING }] })
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 60_000)).done, 1)
    assert.equal((await readStayHome(db, manager, prepared.product_id)).photos.length, 3)
    await requestAirbnbSync(env, db, ORG, OWNER, { stop: [prepared.product_id] })
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 60_000)).done, 1)
    await requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: LISTING }] })
    let sent = 0
    stalled((url, init) => { if (url.pathname === '/api/v1/channels/chan-1/mappings' && init.method === 'POST') { sent++; return true } return false })
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 1_000)).failed, 1)
    assert.deepEqual(await job(), { state: 'failed', last_error_code: 'SYNC_SLICE_ENDED', attempts: 1, lease_token: null, lease_until: null })
    assert.equal(await db.prepare('SELECT status FROM channex_connections').first('status'), 'needs_review')
    assert.equal(await db.prepare('SELECT pending_step FROM channex_connections').first('pending_step'), 'map_airbnb_listing')
    assert.deepEqual(await runAirbnbSyncJobs(env, Date.now() + 1_000), { stepped: 0, done: 0, failed: 0 })
    assert.equal(sent, 1)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a paid home retains a failed meter report and retries terminal billing before completing', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const prepared = await connection.prepare(LISTING, form)
    await advanceTo(connection, db, channex, prepared.product_id, 'draft')
    await db.prepare('UPDATE organization SET stripeCustomerId = ? WHERE id = ?').bind('cus_paid_host', ORG).run()
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, stripeCustomerId, stripeSubscriptionId, status, seats, periodEnd) VALUES ('sub-paid', 'growth', ?, 'cus_paid_host', 'sub-paid', 'active', 1, ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86_400).run()
    let stalled = true
    let requests = 0
    const receipts: Array<{ event: string; customer: string; value: string }> = []
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.origin !== 'https://api.stripe.com') return channex.fetch(input, init)
      assert.equal(url.pathname, '/v1/billing/meter_events')
      requests++
      if (stalled) {
        assert.ok(init.signal, 'the real Stripe SDK transport receives the operation deadline')
        return new Promise<Response>((_resolve, reject) => {
          if (init.signal!.aborted) reject(init.signal!.reason)
          else init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        })
      }
      const data = new URLSearchParams(String(init.body))
      receipts.push({ event: data.get('event_name')!, customer: data.get('payload[stripe_customer_id]')!, value: data.get('payload[value]')! })
      return new Response(JSON.stringify({ object: 'billing.meter_event', identifier: `meter-${requests}`, event_name: data.get('event_name'), created: Math.floor(Date.now() / 1000), livemode: false }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': `req-${requests}` } })
    }
    const job = () => db.prepare('SELECT state, last_error_code, attempts, lease_token, lease_until FROM airbnb_sync_jobs').first()
    const retry = async () => { await db.prepare("UPDATE airbnb_sync_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run() }
    await requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: LISTING }] })
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 2_000)).failed, 1)
    assert.deepEqual(await job(), { state: 'error', last_error_code: 'SYNC_SLICE_ENDED', attempts: 1, lease_token: null, lease_until: null })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings').first(), { import_stage: 'reservations', enabled: 1 })
    assert.equal(requests, 1, 'the SDK does not retry beyond the operation deadline')
    await retry()
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 2_000)).failed, 1)
    assert.deepEqual(await job(), { state: 'error', last_error_code: 'SYNC_SLICE_ENDED', attempts: 2, lease_token: null, lease_until: null })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings').first(), { import_stage: 'complete', enabled: 1 })
    assert.equal(requests, 2)
    const providerWrites = channex.seen.filter(entry => entry.method !== 'GET').length
    stalled = false
    await retry()
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 60_000)).done, 1)
    assert.deepEqual(await job(), { state: 'done', last_error_code: null, attempts: 2, lease_token: null, lease_until: null })
    assert.deepEqual(receipts, [{ event: 'krabiclaw_locations', customer: 'cus_paid_host', value: '0' }, { event: 'krabiclaw_homes', customer: 'cus_paid_host', value: '1' }])
    assert.equal(channex.seen.filter(entry => entry.method !== 'GET').length, providerWrites, 'billing recovery does not repeat provider mutations')
    assert.equal((await readStayHome(db, manager, prepared.product_id)).live, true)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a failed verification read retains the completed provider write for review', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const prepared = await connection.prepare(LISTING, form)
    await advanceTo(connection, db, channex, prepared.product_id, 'draft')
    await requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: LISTING }] })
    let mappings = 0
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (init.method === 'POST' && url.pathname.endsWith('/mappings')) mappings++
      if (mappings && (!init.method || init.method === 'GET') && url.pathname === '/api/v1/channels/chan-1') return new Response('verification unavailable', { status: 503 })
      return channex.fetch(input, init)
    }
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 60_000)).failed, 1)
    assert.deepEqual(await db.prepare('SELECT state, last_error_code, lease_token, lease_until FROM airbnb_sync_jobs').first(), { state: 'failed', last_error_code: 'CHANNEX_REQUEST_FAILED', lease_token: null, lease_until: null })
    assert.deepEqual(await db.prepare('SELECT status, pending_step FROM channex_connections').first(), { status: 'needs_review', pending_step: 'map_airbnb_listing' })
    assert.equal(channex.channel.ratePlans.length, 1, 'the provider applied the write whose verification failed')
    assert.deepEqual(await runAirbnbSyncJobs(env, Date.now() + 1_000), { stepped: 0, done: 0, failed: 0 })
    assert.equal(mappings, 1)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('an in-flight stop cannot mark a newer sync request done', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const prepared = await connection.prepare(LISTING, form)
    await importAll(connection, db, channex, prepared.product_id)
    await requestAirbnbSync(env, db, ORG, OWNER, { stop: [prepared.product_id] })
    let listingsEntered!: () => void
    const listingsReady = new Promise<void>(resolve => { listingsEntered = resolve })
    let returnListings!: () => void
    const listingsHeld = new Promise<void>(resolve => { returnListings = resolve })
    let stopEntered!: () => void
    const stopReady = new Promise<void>(resolve => { stopEntered = resolve })
    let returnStop!: () => void
    const stopHeld = new Promise<void>(resolve => { returnStop = resolve })
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.pathname.endsWith('/action/listings')) { listingsEntered(); await listingsHeld }
      if (init.method === 'DELETE' && url.pathname.includes('/mappings/')) { stopEntered(); await stopHeld }
      return channex.fetch(input, init)
    }
    // The newer request read a connected account before the old run locked it.
    const newer = requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: LISTING }] })
    await listingsReady
    const older = runAirbnbSyncJobs(env, Date.now() + 60_000)
    await stopReady
    const oldId = await db.prepare('SELECT id FROM airbnb_sync_jobs').first('id')
    returnListings()
    await newer
    assert.notEqual(await db.prepare('SELECT id FROM airbnb_sync_jobs').first('id'), oldId)
    returnStop()
    assert.equal((await older).done, 0)
    assert.deepEqual(await db.prepare('SELECT action, state, lease_token, lease_until FROM airbnb_sync_jobs').first(), { action: 'sync', state: 'pending', lease_token: null, lease_until: null })
    assert.equal((await readStayHome(db, manager, prepared.product_id)).live, false)
    globalThis.fetch = channex.fetch as typeof fetch
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 60_000)).done, 1)
    assert.deepEqual(await db.prepare('SELECT action, state FROM airbnb_sync_jobs').first(), { action: 'sync', state: 'done' })
    assert.equal((await readStayHome(db, manager, prepared.product_id)).live, true)

    // An expired lease can be reclaimed while its old provider call is still
    // returning. Only the new holder may complete the durable job.
    await requestAirbnbSync(env, db, ORG, OWNER, { stop: [prepared.product_id] })
    let reclaimed = false
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (!reclaimed && init.method === 'DELETE' && url.pathname.includes('/mappings/')) {
        reclaimed = true
        await db.prepare("UPDATE airbnb_sync_jobs SET lease_until = '2000-01-01T00:00:00.000Z'").run()
        assert.deepEqual(await runAirbnbSyncJobs(env, Date.now() + 1_000), { stepped: 0, done: 0, failed: 0 })
      }
      return channex.fetch(input, init)
    }
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 60_000)).done, 0)
    assert.equal(reclaimed, true)
    assert.deepEqual(await db.prepare('SELECT action, state, lease_token, lease_until FROM airbnb_sync_jobs').first(), { action: 'stop', state: 'pending', lease_token: null, lease_until: null })
    assert.equal((await readStayHome(db, manager, prepared.product_id)).live, false)
    globalThis.fetch = channex.fetch as typeof fetch
    await db.prepare("UPDATE airbnb_sync_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run()
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 60_000)).done, 1)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('the import asks only for what Airbnb leaves out, and stops when Airbnb has no check-in start or checkout', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    // Only the fields Airbnb left out may be supplied.
    await assert.rejects(connection.prepare(LISTING, { missingDetails: { ...form.missingDetails, city: 'Elsewhere' } }), { status: 422, data: { code: 'ONLY_MISSING_DETAILS' } })
    // "FLEXIBLE" or "NOT_SELECTED" is no start: the import stops naming Airbnb's field, and nothing is made.
    for (const [setting, field] of [[{ check_in_time_start: 'NOT_SELECTED' }, 'booking_settings.check_in_time_start'], [{ check_out_time: null }, 'booking_settings.check_out_time']] as const) {
      channex.booking = { ...channex.booking, check_in_time_start: '16', check_out_time: 10, ...setting }
      await assert.rejects(connection.prepare(LISTING, form), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 422 && error.data?.code === 'MISSING_AIRBNB_FIELD' && error.data.field === field)
      assert.deepEqual([await count(db, 'business_locations'), await count(db, 'products'), await count(db, 'product_channel_mappings')], [0, 0, 0])
    }
    // A flexible end is a home whose check-in window has no end; an hour after midnight is that hour.
    channex.booking = { ...channex.booking, check_in_time_start: '16', check_in_time_end: 'FLEXIBLE', check_out_time: 10 }
    assert.equal((await connection.details(LISTING)).checkInEndTime, null)
    channex.booking = { ...channex.booking, check_in_time_end: '25' }
    assert.equal((await connection.details(LISTING)).checkInEndTime, '01:00')
    // The home has Airbnb's window; Channex's child-only beds and infant cots are 0, as Airbnb counts neither.
    const started = await connection.prepare(LISTING, form)
    assert.deepEqual(await db.prepare('SELECT check_in_time, check_in_end_time, check_out_time FROM product_stay_configs WHERE product_id = ?').bind(started.product_id).first(), { check_in_time: '16:00', check_in_end_time: '01:00', check_out_time: '10:00' })
    assert.deepEqual(channex.roomTypes, [])
    const property = JSON.parse(String(await db.prepare('SELECT import_property FROM product_channel_mappings WHERE product_id = ?').bind(started.product_id).first('import_property'))) as Record<string, unknown>
    assert.deepEqual(['child_beds', 'infant_cots'].filter(key => key in property), [])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

async function count(db: D1Database, table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n
}
