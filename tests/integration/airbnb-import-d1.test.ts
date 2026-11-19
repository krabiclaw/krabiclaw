import assert from 'node:assert/strict'
import type Stripe from 'stripe'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { bindDatabaseEvents } from '../../server/db/index.ts'
import { landBookingRevision } from '../../server/integrations/channex/booking-revisions.ts'
import { ChannexConnection, type ImportContentReport } from '../../server/integrations/channex/channel-connection.ts'
import { applyChannelBooking, createStayHome, getStay, readStayHome, stayHomeInput, updateStayHome } from '../../server/domain/stays.ts'
import { getMediaAsset } from '../../server/utils/media-asset-manager.ts'
import { createProduct, getProduct } from '../../server/utils/product-management.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import { countActiveHomes } from '../../server/utils/billing.ts'
import { publishedCatalogResponse } from './support/stripe-published-catalog.ts'
import { returnExtrasToDraftsForPlanEnd } from '../../server/utils/billing-plan-end.ts'
import syncPostRoute from '../../server/api/organizations/[organization_id]/integrations/airbnb/sync.post.ts'
import syncGetRoute from '../../server/api/organizations/[organization_id]/integrations/airbnb/sync.get.ts'
import listingsRoute from '../../server/api/organizations/[organization_id]/integrations/airbnb/listings.get.ts'
import { captureEvents } from './support/events.ts'
import type { AirbnbSyncMessage } from '../../server/events.ts'

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
const AIRBNB_AVAILABILITY = { booking_lead_time: 24, max_days_notice: 90, allow_rtb_beyond_max_days_notice: false, default_max_nights: 700, allow_rtb_above_max_nights: false, turnover_days: 1, day_of_week_check_in: [true, true, true, true, true, false, false], day_of_week_check_out: [false, true, true, true, true, true, true] }
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
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

interface FakeBody {
  property: { title?: string; settings?: Record<string, unknown> }
  connection_link: { token: string; title: string }
  values: Array<{ date_from: string; date_to: string; availability: number; rate: string; min_stay_arrival: number; max_stay: number; closed_to_arrival: boolean; closed_to_departure: boolean; stop_sell: boolean; rate_plan_id: string }>
  mapping: { rate_plan_id: string; settings: { listing_id: string } }
  channel: { properties?: string[]; settings?: Record<string, unknown> }
}

class FakeChannex {
  seen: Array<{ method: string; path: string }> = []
  currency = 'USD'
  ids = 0
  mappingIds = 0
  rateProperties = new Map<string, string>()
  ratePlans = new Map<string, Record<string, unknown>>()
  availabilityRules: Record<string, unknown> = { ...AIRBNB_AVAILABILITY, default_min_nights: 5 }
  channel = { title: '', active: false, settings: { min_stay_type: 'Arrival' } as Record<string, unknown>, properties: ['setup-1'], ratePlans: [] as Array<{ id: string; rate_plan_id: string; settings: { listing_id?: string } }> }
  availability: Record<string, number> = {}
  restrictions: Record<string, Record<string, unknown>> = {}
  token = ''
  channelId = 'chan-1'
  listingId = LISTING
  nightlyRate = 189.5
  restrictionsByRate = new Map<string, Map<string, unknown>>()
  messagesProperty: string | null = null
  failMessages = false
  failMappingRemoval = false
  /** Airbnb failing behind Channex: Channex answers 422 carrying Airbnb's own 500, as it did on production 2026-10-23. */
  airbnbDown = false
  listingPresent = true
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
    // Firm and Strict Long Term, as a live listing reported them on 2026-10-29.
    cancellation_policy_settings: { cancellation_policy_category: 'better_strict_with_grace_period', lts_cancellation_policy_id: 'CANCEL_LONG_TERM_WITH_GRACE_PERIOD', non_refundable_price_factor: null },
    instant_booking_allowed_category: 'everyone', instant_book_welcome_message: null,
    listing_expectations_for_guests: [{ type: 'requires_stairs', added_details: null }],
  }
  /** Airbnb's `property_type_category` for the listing. */
  category = 'townhouse'
  /** The properties created in Channex, including their current settings. */
  properties: Array<Record<string, unknown>> = []
  /** The room types Channex was asked to create. */
  roomTypes: Array<Record<string, unknown>> = []
  /** The listing settings writes Channex received, in order. */
  settings: Array<Record<string, unknown>> = []

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace('/api/v1', '').replace(`/channels/${this.channelId}`, '/channels/chan-1')
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as FakeBody : null
    // Basic's homes quote reads the published price from Stripe's catalog.
    if (url.origin === 'https://api.stripe.com') {
      const catalog = publishedCatalogResponse(url)
      if (catalog) return catalog
    }
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
    if (method === 'GET' && path === '/groups') return json({ data: [], meta: { total: 0 } })
    if (method === 'POST' && path === '/groups') return json({ data: { id: 'grp-1', type: 'group', attributes: {} } })
    if (method === 'POST' && path === '/properties') {
      if (body!.property.title.startsWith('Blawby connection setup')) return json({ data: { id: 'setup-1', type: 'property', attributes: {} } })
      const id = `prop-${++this.ids}`
      const property: Record<string, unknown> = { ...body!.property, id }
      this.properties.push(property)
      return json({ data: { id, type: 'property', attributes: property } })
    }
    // Exact-title and per-property lists, which a create stage reads before creating.
    if (method === 'GET' && path === '/properties') {
      const rows = this.properties.filter(property => property.title === url.searchParams.get('filter[title]'))
      return json({ data: rows.map(({ group_id: group, ...property }) => ({ id: property.id, type: 'property', attributes: property, relationships: { groups: { data: [{ type: 'group', id: group }] } } })), meta: { total: rows.length } })
    }
    if (method === 'GET' && path === '/room_types') {
      const rows = this.roomTypes.filter(room => room.property_id === url.searchParams.get('filter[property_id]'))
      return json({ data: rows.map(room => ({ id: room.id, type: 'room_type', attributes: room, relationships: { property: { data: { type: 'property', id: room.property_id } } } })), meta: { total: rows.length } })
    }
    if (method === 'GET' && path === '/channels' && url.searchParams.get('filter[channel]') === 'VRB') return Response.json({ data: [], meta: { total: 0 } })
    if (method === 'GET' && path === '/rate_plans') {
      const rows = [...this.ratePlans].filter(([, plan]) => plan.property_id === url.searchParams.get('filter[property_id]'))
      return json({ data: rows.map(([id, plan]) => ({ id, type: 'rate_plan', attributes: plan,
        relationships: { room_type: { data: { id: plan.room_type_id } } } })), meta: { total: rows.length } })
    }
    if (method === 'GET' && path === '/rate_plans/options') {
      const rows = [...this.ratePlans].filter(([, plan]) => plan.property_id === url.searchParams.get('filter[property_id]'))
      return json({ data: rows.map(([id, plan]) => ({ id, type: 'rate_plan', attributes: { id, title: plan.title, property_id: plan.property_id, room_type_id: plan.room_type_id } })) })
    }
    if ((method === 'GET' || method === 'PUT') && /^\/properties\/[^/]+$/.test(path)) {
      const property = this.properties.find(property => property.id === path.split('/').pop())
      if (!property) return new Response('Property not found', { status: 404 })
      if (method === 'PUT') Object.assign(property, body!.property, { settings: { ...property.settings as Record<string, unknown>, ...body!.property.settings } })
      return json({ data: { id: property.id, type: 'property', attributes: property } })
    }
    if (method === 'POST' && path === '/meta/airbnb/connection_link') {
      this.token = body!.connection_link.token
      this.channel.title = body!.connection_link.title
      return json({ data: { type: 'connection_link', attributes: { url: 'https://www.airbnb.com/oauth2/auth?x=1' } } })
    }
    if (method === 'GET' && path === '/channels/chan-1') {
      return json({ data: { id: this.channelId, type: 'channel', attributes: { channel: 'AirBNB', title: this.channel.title, is_active: this.channel.active, properties: this.channel.properties, rate_plans: this.channel.ratePlans, settings: this.channel.settings }, relationships: { group: { data: { id: 'grp-1' } } } } })
    }
    if (method === 'GET' && path === '/channels/chan-1/action/listings' && this.airbnbDown) {
      return new Response(JSON.stringify({ errors: { error_code: 500, error_message: 'Unfortunately, a server error prevented your request from being completed. Airbnb may be undergoing maintenance or your connection may have timed out. Please try again.', error_type: 'unknown_error' } }), { status: 422, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'GET' && path === '/channels/chan-1/action/listings') return json({ data: { listing_id_dictionary: { values: this.listingPresent ? [{ id: this.listingId, title: 'Cliff Cabin', city: 'Moab', country_code: 'US' }] : [] } } })
    if (method === 'GET' && path === '/channels/chan-1/action/listing_details') {
      const listingId = url.searchParams.get('listing_id')!
      const content = {
        images: [...PHOTOS, ...Array.from({ length: this.extraPhotos }, (_, i) => ({ id: `${LISTING}_x${i + 1}`, caption: null, sort_order: PHOTOS.length + i + 1 }))].map(photo => ({ ...photo, listing_id: listingId, category: 'LISTING', thumbnail_url: `${CDN}/photos/${photo.id}.jpg?aki_policy=x_small`, small_url: `${CDN}/photos/${photo.id}.jpg?aki_policy=small`, extra_medium_url: `${CDN}/photos/${photo.id}.jpg?aki_policy=x_medium` })),
        descriptions: { summary: 'A cabin on the cliff.', description: 'A cabin on the cliff.\n\nTwo bedrooms.', space: 'Two bedrooms and a deck.', access: 'The whole cabin is yours.', interaction: 'We live next door.', neighborhood_overview: 'Quiet, ten minutes from town.', transit: 'Bus 4 stops outside.', notes: 'No parties.', house_rules: 'No smoking inside.', name: 'Cliff Cabin', locale: 'en' },
        amenities: { WIRELESS_INTERNET: { instruction: '', is_present: true }, SMOKE_DETECTOR: { instruction: '', is_present: true }, HOVERBOARD_DOCK: { instruction: '', is_present: true }, CRIB: { instruction: '', is_present: false } },
        listing_views: ['MOUNTAIN_VIEW'],
        rooms: [{ id: 'r1', listing_id: listingId, room_type: 'bedroom', is_private: true, beds: [{ quantity: 1, type: 'queen_bed' }], accessibility_features: [] }, { id: 'r2', listing_id: listingId, room_type: 'bedroom', is_private: true, beds: [{ quantity: 2, type: 'queen_bed' }], accessibility_features: [] }],
        bedrooms: 2, beds: 3, bathrooms: 1, house_manual: 'Unit 63A. Shoes off, please.', directions: 'Behind the capitol.', wifi_network: '5 Star', wifi_password: 'open sesame',
        check_in_option: { category: 'smartlock', instruction: 'Door code 0126' },
        quiet_hours: [{ start_time: '23', end_time: '7' }],
      }
      return json({ data: { listing: { id: listingId, name: 'Cliff Cabin', person_capacity: 4, lat: 38.5733, lng: -109.5498, country_code: 'US', state: 'UT', city: 'Moab', street: '1 Cliff Rd', zipcode: '84532', property_type_category: this.category, availability_rules: this.availabilityRules, booking_settings: this.booking, pricing_settings: { listing_currency: this.currency, guests_included: 2, default_daily_price: this.nightlyRate, weekend_price: null, standard_fees: [], weekly_price_factor: 0, monthly_price_factor: 0 }, ...content } } })
    }
    if (method === 'GET' && path === '/channels/chan-1/action/get_listing_calendar') {
      const from = url.searchParams.get('date_from')!
      const days = Array.from({ length: 500 }, (_, i) => ({ date: addDays(from, i), availability: i === 3 || i === 7 || i >= 400 ? 'unavailable' : 'available', availability_type: i === 3 ? 'busy' : i === 7 ? 'reservation' : i >= 400 ? 'rule' : 'available', daily_price: Number(this.restrictions[addDays(from, i)]?.rate ?? (i === 0 ? this.nightlyRate + 20.5 : this.nightlyRate)), min_nights: this.restrictions[addDays(from, i)]?.min_stay_arrival ?? 2, max_nights: 30, closed_to_arrival: false, closed_to_departure: i === 5 }))
      return json({ data: { calendar: { listing_id: url.searchParams.get('listing_id'), start_date: from, end_date: url.searchParams.get('date_to'), days } } })
    }
    // The room type and rate plan the inventory reads are about are the last ones created.
    if (method === 'POST' && path === '/room_types') {
      this.roomType = `room_type-${++this.ids}`
      this.roomTypes.push({ id: this.roomType, ...(JSON.parse(String(init.body)) as { room_type: Record<string, unknown> }).room_type })
      return json({ data: { id: this.roomType, type: 'room_type', attributes: {} } })
    }
    if (method === 'POST' && path === '/rate_plans') {
      this.ratePlan = `rate_plan-${this.ids + 1}`
      this.rateProperties.set(this.ratePlan, (JSON.parse(String(init.body)) as { rate_plan: { property_id: string } }).rate_plan.property_id)
      this.ratePlans.set(this.ratePlan, (JSON.parse(String(init.body)) as { rate_plan: Record<string, unknown> }).rate_plan)
      return resource('rate_plan')
    }
    if ((method === 'GET' || method === 'PUT') && /^\/rate_plans\/[^/]+$/.test(path)) {
      const id = path.split('/').at(-1)!
      const plan = this.ratePlans.get(id)
      if (!plan) return new Response('Rate plan not found', { status: 404 })
      if (method === 'PUT') Object.assign(plan, (JSON.parse(String(init.body)) as { rate_plan: Record<string, unknown> }).rate_plan)
      return json({ data: { id, type: 'rate_plan', attributes: plan } })
    }
    if (method === 'PUT' && path === '/channels/chan-1/execute/update_booking_setting') { this.settings.push({ booking: (JSON.parse(String(init.body)) as Record<string, unknown>) }); return json({ data: {} }) }
    // ARI arrives as inclusive date ranges; Channex keeps each date's values.
    const dates = (value: { date_from: string; date_to: string }) => Array.from({ length: daysBetween(value.date_from, value.date_to) + 1 }, (_, offset) => addDays(value.date_from, offset))
    if (method === 'POST' && path === '/restrictions') {
      for (const value of body!.values) for (const date of dates(value)) {
        const { date_from: _from, date_to: _to, ...rule } = value
        this.restrictions[date] = { ...this.restrictions[date], ...rule }
        const planNights = this.restrictionsByRate.get(value.rate_plan_id) ?? new Map<string, unknown>()
        if (value.rate !== undefined) planNights.set(date, value.rate)
        this.restrictionsByRate.set(value.rate_plan_id, planNights)
      }
      return json({ data: [{ id: 'task-restrictions', type: 'task' }], meta: { message: 'Success', warnings: [] } })
    }
    if (method === 'POST' && path === '/availability') {
      for (const value of body!.values) for (const date of dates(value)) this.availability[date] = value.availability
      return json({ data: [{ id: 'task-availability', type: 'task' }], meta: { message: 'Success', warnings: [] } })
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
    if (method === 'PUT' && path === '/channels/chan-1') { if (body!.channel.properties) this.channel.properties = body!.channel.properties; if (body!.channel.settings) this.channel.settings = body!.channel.settings; return json({ data: {} }) }
    if (method === 'DELETE' && path === '/properties/setup-1') return json({ meta: { message: 'Success' } })
    if (method === 'POST' && path === '/channels/chan-1/activate') { this.channel.active = true; return json({ meta: { message: 'Success' } }) }
    if (method === 'POST' && path === '/channels/chan-1/deactivate') { this.channel.active = false; return json({ meta: { message: 'Success' } }) }
    if (method === 'DELETE' && path === '/channels/chan-1') return json({ meta: { message: 'Success' } })
    if (method === 'DELETE' && path.startsWith('/channels/chan-1/mappings/')) {
      if (this.failMappingRemoval) return new Response('Airbnb is not answering', { status: 503 })
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
    const queue = captureEvents()
    const syncs = captureEvents<AirbnbSyncMessage>()
    const env = {
      ...await runtime.getBindings<CloudflareEnv>(), DB: db, EVENTS: queue.binding, AIRBNB_SYNC: syncs.binding, CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k', STRIPE_SECRET_KEY: 'sk_test_local_d1',
      BETTER_AUTH_URL: BASE, BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test', GOOGLE_CLIENT_ID: 'test-google-client',
      ZARAZ_ANALYTICS: 'absent',
      GOOGLE_CLIENT_SECRET: 'test-google-secret', APPLE_APP_BUNDLE_ID: 'com.krabiclaw.app', APPLE_SERVICES_ID: 'com.krabiclaw.web', MEDIA_BASE_URL: 'https://media.proof.example', EMAIL_REPLY_DOMAIN: 'reply.proof.example', EMAIL_REPLY_SECRET: 'local-airbnb-reply', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as unknown as CloudflareEnv
    bindDatabaseEvents(db, env)
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', ?)`).bind(ORG, TZ).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    // Airbnb sync is Business; a test about the plan lapsing cancels this subscription first.
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, periodEnd) VALUES ('sub-boot', 'business', ?, 'active', 1, ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86_400).run()
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('a-owner', ?, 'credential', ?, ?, 0, 0)").bind(OWNER, OWNER, await hashPassword(PASSWORD)).run()
    return { runtime, db, env, queue, syncs }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

async function connected(db: D1Database, env: CloudflareEnv, channex: FakeChannex) {
  const connection = new ChannexConnection(db, env, ORG, OWNER)
  await connection.start()
  await connection.complete(channex.token, 'chan-1')
  return connection
}

const form = { missingDetails: { email: 'Stay@Example.test', phone: '+1 435 555 0100', assigned_member_id: 'm-owner' } }
const manager = { organizationId: ORG, actorId: OWNER, manage: true } as const

/** Tell the fake which Channex room type and rate plan the import's reads are about. */
async function track(db: D1Database, channex: FakeChannex, productId: string): Promise<void> {
  const mapping = await db.prepare('SELECT room_type_id, rate_plan_id FROM product_channel_mappings WHERE product_id = ?').bind(productId).first<{ room_type_id: string | null; rate_plan_id: string | null }>()
  channex.roomType = mapping?.room_type_id ?? ''
  channex.ratePlan = mapping?.rate_plan_id ?? ''
}

/** Advance until the import rests at `until`. */
async function advanceTo(connection: ChannexConnection, db: D1Database, channex: FakeChannex, productId: string, until: 'draft' | 'complete'): Promise<void> {
  for (let step = 0; step < 14; step++) {
    await track(db, channex, productId)
    if ((await connection.advance(LISTING)).stage === until) return
  }
  throw new Error(`The import did not reach ${until}`)
}

test('a listing imports through every stage into a home Channex and Blawby agree on', { timeout: 120_000 }, async () => {
  const { runtime, db, env, syncs } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const details = await connection.details(LISTING)
    // The organization has no contact details yet, so the import asks for them once, and always for the member who looks after the home.
    // Children and infants are not asked: Airbnb counts neither.
    assert.deepEqual(details.missing_fields, ['email', 'phone', 'assigned_member_id'])
    assert.deepEqual({ timezone: details.fields.timezone, checkIn: details.check_in_time, checkInEnd: details.check_in_end_time, checkOut: details.check_out_time }, { timezone: TZ, checkIn: '16:00', checkInEnd: '21:00', checkOut: '10:00' })
    // Translate provider aliases without rejecting categories Channex can validate itself.
    assert.equal(details.fields.propertyType, 'holiday_home')
    channex.category = 'house'
    assert.equal((await connection.details(LISTING)).fields.propertyType, 'holiday_home')
    channex.category = 'treehouse'
    assert.equal((await connection.details(LISTING)).fields.propertyType, 'treehouse')
    channex.category = 'townhouse'

    const started = await connection.prepare(LISTING, form)
    assert.equal(started.stage, 'property')
    // Asking again returns the same import; nothing is created twice.
    assert.deepEqual(await connection.prepare(LISTING, form), started)
    // What the host typed is now the organization's contact, so the next listing asks only who looks after it.
    assert.deepEqual(await db.prepare('SELECT contact_email, contact_phone FROM organization WHERE id = ?').bind(ORG).first(), { contact_email: 'stay@example.test', contact_phone: '+1 435 555 0100' })
    assert.deepEqual((await connection.details(LISTING)).missing_fields, ['assigned_member_id'])
    const productId = started.product_id

    const home = await db.prepare(`SELECT p.kind, p.name, b.check_in_time, b.check_in_end_time, b.check_out_time, b.default_capacity AS max_guests, b.min_nights, l.title AS location, l.timezone, l.email, pr.unit_amount, pr.currency
      FROM products p JOIN product_stay_configs c ON c.product_id = p.id JOIN product_booking_configs b ON b.product_id = p.id JOIN business_locations l ON l.id = c.location_id
      JOIN product_variants v ON v.product_id = p.id JOIN prices pr ON pr.product_variant_id = v.id AND pr.stay_date IS NULL AND pr.weekend = 0 WHERE p.id = ?`).bind(productId).first()
    // Check-in and checkout are Airbnb's window, not anything the client sent.
    assert.deepEqual(home, { kind: 'stay', name: 'Cliff Cabin', check_in_time: '16:00', check_in_end_time: '21:00', check_out_time: '10:00', max_guests: 4, min_nights: 5, location: 'Cliff Cabin', timezone: TZ, email: 'Stay@Example.test', unit_amount: 18_950, currency: 'USD' })
    const nights = await db.prepare("SELECT COUNT(*) AS total, SUM(n.closed) AS closed, SUM(n.closed_to_departure) AS ctd, MAX(pr.unit_amount) AS top FROM product_nights n JOIN product_variants v ON v.organization_id = n.organization_id AND v.product_id = n.product_id LEFT JOIN prices pr ON pr.organization_id = v.organization_id AND pr.product_variant_id = v.id AND pr.stay_date = n.date WHERE n.product_id = ? AND n.source = 'import'").bind(productId).first()
    // The blocked night and the reserved night are closed; the nights past Airbnb's booking window are not.
    assert.deepEqual(nights, { total: 500, closed: 2, ctd: 1, top: 21_000 })
    const first = await db.prepare('SELECT n.date, pr.unit_amount AS price_minor, n.min_stay_arrival, n.max_stay FROM product_nights n JOIN product_variants v ON v.organization_id = n.organization_id AND v.product_id = n.product_id LEFT JOIN prices pr ON pr.organization_id = v.organization_id AND pr.product_variant_id = v.id AND pr.stay_date = n.date WHERE n.product_id = ? ORDER BY n.date LIMIT 1').bind(productId).first()
    assert.deepEqual(first, { date: today(), price_minor: 21_000, min_stay_arrival: 2, max_stay: 30 })

    const stages: string[] = []
    for (let step = 0; step < 14; step++) {
      await track(db, channex, productId)
      const at = await db.prepare("SELECT CASE WHEN l.import_stage = 'property' THEN m.import_stage ELSE l.import_stage END AS import_stage FROM product_airbnb_listings l JOIN product_channel_mappings m USING (product_id) WHERE product_id = ?").bind(productId).first<string>('import_stage')
      // Another listing's unsaved property with the same title but its own address: never adopted for this one.
      if (at === 'property') channex.properties.push({ id: 'prop-other-listing', title: 'Cliff Cabin', group_id: 'grp-1', address: '2 Cliff Rd', zip_code: '84532', city: 'Moab' })
      if (at === 'property' || at === 'room' || at === 'rate') {
        // The Worker ends after Channex created the resource and before its id is saved.
        await db.prepare(`CREATE TRIGGER lose_created_id BEFORE UPDATE OF import_stage ON product_channel_mappings BEGIN SELECT RAISE(ABORT, 'Worker ended'); END`).run()
        await assert.rejects(connection.advance(LISTING), (error: Error) => String(error.cause).includes('Worker ended'))
        await db.prepare('DROP TRIGGER lose_created_id').run()
        await track(db, channex, productId)
      }
      const result = await connection.advance(LISTING)
      if (at === 'property') {
        assert.notEqual(await db.prepare('SELECT property_id FROM product_channel_mappings WHERE product_id = ?').bind(productId).first('property_id'), 'prop-other-listing')
        channex.properties.splice(channex.properties.findIndex(property => property.id === 'prop-other-listing'), 1)
      }
      stages.push(result.stage)
      if (result.stage === 'content') {
        // A photo Airbnb cannot serve stops the stage naming the image; the retry keeps the photo already stored.
        channex.failPhoto = PHOTOS[1]!.id
        await assert.rejects(connection.advance(LISTING), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 502 && error.data?.code === 'PHOTO_FETCH_FAILED'
          && error.data.image_id === PHOTOS[1]!.id && error.data.url === `${CDN}/photos/${PHOTOS[1]!.id}.jpg?im_w=2560`)
        assert.deepEqual(await db.prepare('SELECT import_stage, import_content FROM product_airbnb_listings WHERE product_id = ?').bind(productId).first(), { import_stage: 'content', import_content: null })
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
        assert.deepEqual(await connection.advance(LISTING), { product_id: productId, stage: 'draft', waiting: false, content: report })
        assert.deepEqual(await connection.activate(LISTING), { product_id: productId, stage: 'mapping', waiting: false })
        stages.push('activated')
      }
      if (result.stage === 'messages') {
        assert.equal((await readStayHome(db, manager, productId)).live, true)
        channex.failMessages = true
        await assert.rejects(connection.advance(LISTING), /503/)
        assert.equal(await db.prepare('SELECT import_stage FROM product_airbnb_listings WHERE product_id = ?').bind(productId).first('import_stage'), 'messages')
        channex.failMessages = false
      }
      if (result.stage === 'complete') break
    }
    assert.deepEqual(stages, ['room', 'rate', 'inventory', 'verify_inventory', 'content', 'draft', 'activated', 'activate', 'reservations', 'messages', 'complete'])
    const importRequest = await db.prepare("SELECT actor_user_id, payload_json FROM activity_entries WHERE event_name = 'stay.reservations_import_requested' AND json_extract(payload_json, '$.entityId') = ?").bind(productId).first<{ actor_user_id: string; payload_json: string }>()
    assert.equal(importRequest!.actor_user_id, OWNER)
    assert.deepEqual(JSON.parse(importRequest!.payload_json).metadata, { provider: 'channex', channel: 'airbnb', listing_id: LISTING, channel_id: 'chan-1', property_id: 'prop-1', receipt: { meta: { message: 'Success' } } })
    // The Channex property carries the mapped type, never Airbnb's category.
    assert.deepEqual(channex.properties.filter(property => property.title === 'Cliff Cabin').map(property => property.property_type), ['holiday_home'])
    // Activating a home past its draft answers where it is, unchanged.
    assert.deepEqual(await connection.activate(LISTING), { product_id: productId, stage: 'complete', waiting: false })
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
    // A Worker that ended after Channex created the property, room type or rate plan and before its id was saved
    // left the stage to run again: that run found the resource in Channex and created nothing twice.
    assert.deepEqual([channex.properties.length, channex.roomTypes.length, channex.ratePlans.size], [1, 1, 1])
    assert.deepEqual({ bedrooms: filled.bedrooms, beds: filled.beds, bathrooms: filled.bathrooms, amenities: filled.amenities }, { bedrooms: 2, beds: 3, bathrooms: 1, amenities: ['wireless_internet', 'smoke_detector', 'mountain_view'] })
    assert.deepEqual({ method: filled.check_in_method, check_in: filled.check_in_instructions, manual: filled.house_manual, directions: filled.directions, wifi: filled.wifi_network, password: filled.wifi_password, rooms: filled.photo_rooms }, {
      method: 'smart_lock', check_in: 'Door code 0126', manual: 'Unit 63A. Shoes off, please.', directions: 'Behind the capitol.', wifi: '5 Star', password: 'open sesame', rooms: [],
    })
    const mapping = await db.prepare('SELECT m.property_id, m.room_type_id, m.rate_plan_id, m.enabled, m.import_property, l.import_content FROM product_channel_mappings m JOIN product_airbnb_listings l USING (product_id) WHERE product_id = ?').bind(productId).first<Record<string, unknown>>()
    assert.ok(mapping!.property_id && mapping!.room_type_id && mapping!.rate_plan_id)
    assert.deepEqual([mapping!.enabled, mapping!.import_property], [1, null])
    assert.deepEqual((JSON.parse(String(mapping!.import_content)) as ImportContentReport).photos_skipped, [PHOTOS[0]!.id])
    // The full sync carries the arrival-date minimum Airbnb supports on every night.
    // Airbnb's unavailable night is closed here: stop sell on the rate plan, with the unit's inventory untouched.
    assert.equal(Object.keys(channex.availability).length, 500)
    assert.equal(Object.keys(channex.restrictions).length, 500)
    assert.equal(channex.availability[addDays(today(), 3)], 1)
    assert.deepEqual(channex.restrictions[addDays(today(), 3)], { rate: '189.50', min_stay_arrival: 2, max_stay: 30, closed_to_arrival: false, closed_to_departure: false, stop_sell: true, property_id: mapping!.property_id, rate_plan_id: mapping!.rate_plan_id })
    assert.deepEqual(channex.restrictions[addDays(today(), 5)], { rate: '189.50', min_stay_arrival: 2, max_stay: 30, closed_to_arrival: false, closed_to_departure: true, stop_sell: false, property_id: mapping!.property_id, rate_plan_id: mapping!.rate_plan_id })
    assert.equal(channex.properties.at(-1)!.settings && (channex.properties.at(-1)!.settings as { min_stay_type: string }).min_stay_type, 'arrival')

    assert.deepEqual(channex.channel.properties, [mapping!.property_id])
    assert.equal(channex.channel.active, true)
    assert.equal(channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival, 5)
    assert.equal(channex.restrictions[today()]!.min_stay_arrival, 2)
    assert.equal(await db.prepare('SELECT setup_property_id FROM channex_connections').first('setup_property_id'), null)
    const report = JSON.parse(String(mapping!.import_content)) as ImportContentReport
    assert.deepEqual((await connection.listings()).listings[0]!.import, { status: 'imported', product_id: productId, stage: 'complete', syncing: true, content: report })

    // Every syncing home names its Airbnb listing and that listing's editor.
    assert.deepEqual([filled.airbnb_listing_id, filled.airbnb_editor_url], [LISTING, `https://www.airbnb.com/hosting/listings/editor/${LISTING}/details`])
    // Editing what Airbnb takes through Channex sends it: the check-in window in whole hours (after midnight is past 24),
    // and its house rules and cancellation policy. The mapped rate plan carries the minimum stay.
    channex.settings = []
    const edited = await updateStayHome(env, db, manager, productId, { check_in_time: '17:00', check_in_end_time: '01:00', check_out_time: '10:00', cancellation_policy: 'limited', min_nights: 3 })
    assert.deepEqual([edited.channel_push, edited.airbnb_unsynced], [{ state: 'pushed', detail: null }, []])
    assert.deepEqual(channex.settings, [
      { booking: { channel_rate_plan_id: 'map-1', data: { check_in_time_start: '17', check_in_time_end: '25', check_out_time: 10,
        // The listing's children, infant and pet-capacity controls are restated under ours.
        guest_controls: { allows_children_as_host: true, allows_infants_as_host: true, allows_pets_as_host: true, allows_events_as_host: false, allows_smoking_as_host: false, children_not_allowed_details: null, pet_capacity: 1 }, cancellation_policy_settings: { cancellation_policy_category: 'firm_14', lts_cancellation_policy_id: 'CANCEL_LONG_TERM_WITH_GRACE_PERIOD' }, instant_booking_allowed_category: 'everyone', listing_expectations_for_guests: [{ type: 'requires_stairs', added_details: null }] } } },
    ])
    assert.deepEqual([channex.availabilityRules.default_min_nights, channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival], [5, 3])
    assert.equal(channex.restrictions[today()]!.min_stay_arrival, 2)
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
    assert.deepEqual(await connection.deactivate(LISTING), { product_id: productId, stage: 'draft', waiting: false })
    assert.deepEqual([channex.channel.ratePlans, channex.messagesProperty, channex.channel.active], [[], null, true])
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled, import_content FROM product_airbnb_listings WHERE product_id = ?').bind(productId).first(), { import_stage: 'draft', enabled: 0, import_content: mapping!.import_content })
    const drafted = await readStayHome(db, manager, productId)
    assert.deepEqual([drafted.live, drafted.photos.length, drafted.description, drafted.base_price_minor], [false, 3, 'Our own words.', filled.base_price_minor])
    // A draft is not syncing: an edit names nothing for Airbnb.
    assert.deepEqual((await updateStayHome(env, db, manager, productId, { description: 'Our own words, again.' })).airbnb_unsynced, [])
    assert.deepEqual((await connection.listings()).listings[0]!.import, { status: 'imported', product_id: productId, stage: 'draft', syncing: false, content: report })
    // Again on a draft: answered as it is.
    assert.deepEqual(await connection.deactivate(LISTING), { product_id: productId, stage: 'draft', waiting: false })
    // Draft edits become the canonical provider defaults once the actual mapping is recreated, before the home goes live.
    await updateStayHome(env, db, manager, productId, { min_nights: 7, base_price_minor: 250_00 })
    assert.equal(channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival, 3)
    // Activate syncs it again, through the same stages.
    assert.deepEqual(await connection.activate(LISTING), { product_id: productId, stage: 'mapping', waiting: false })
    const property = channex.properties.find(property => property.id === mapping!.property_id)!
    const settings = property.settings as Record<string, unknown>
    delete settings.min_stay_type
    await assert.rejects(connection.advance(LISTING), { status: 502, data: { code: 'INVALID_PROVIDER_RESPONSE', field: 'calendar_defaults', provider_status: 502 } })
    settings.min_stay_type = 'unknown'
    await assert.rejects(connection.advance(LISTING), { status: 502, data: { code: 'INVALID_PROVIDER_RESPONSE', field: 'calendar_defaults', provider_status: 502 } })
    // A property created under the old through/both model is repaired before its full calendar is sent.
    settings.min_stay_type = 'both'
    await advanceTo(connection, db, channex, productId, 'complete')
    assert.deepEqual(property.settings, { ...settings, min_stay_type: 'arrival' })
    assert.equal(property.title, 'Cliff Cabin')
    assert.deepEqual(Object.keys(channex.restrictions).sort(), Array.from({ length: 500 }, (_, offset) => addDays(today(), offset)))
    assert.equal(Object.values(channex.restrictions).every(rule => rule.min_stay_arrival === 2 && !Object.hasOwn(rule, 'min_stay_through')), true)
    assert.deepEqual([channex.availabilityRules.default_min_nights, channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival], [5, 7])
    assert.equal((channex.ratePlans.get(channex.ratePlan)!.options as Array<{ rate: string }>)[0]!.rate, '250.00')
    assert.deepEqual([channex.channel.ratePlans.length, channex.messagesProperty, (await readStayHome(db, manager, productId)).live], [1, mapping!.property_id, true])
    // A content refresh keeps a field the host changed since Airbnb's value was last written.
    // The home's nights are Blawby's: a night priced differently on Airbnb is not read back over the home's own price.
    const nightPrice = () => db.prepare('SELECT pr.unit_amount FROM prices pr JOIN product_variants v ON v.id = pr.product_variant_id WHERE v.product_id = ? AND pr.stay_date = ?').bind(productId, today()).first('unit_amount')
    const ownPrice = await nightPrice()
    assert.equal(typeof ownPrice, 'number')
    channex.restrictions[today()] = { ...channex.restrictions[today()]!, rate: '999.00' }
    const refreshed = await connection.refreshContent(LISTING)
    assert(refreshed.content.kept_host_edits.includes('description'))
    assert.equal(await nightPrice(), ownPrice)
    assert.equal((await readStayHome(db, manager, productId)).description, 'Our own words, again.')

    // Disconnect: a mapping Airbnb fails to remove leaves its home syncing and the connection connected with the reason.
    const enabled = () => db.prepare('SELECT enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first('enabled')
    channex.failMappingRemoval = true
    assert.deepEqual(await connection.disconnect('chan-1'), { disconnected: false })
    const asked = syncs.take()!
    await syncs.deliver(env, asked)
    assert.deepEqual([await enabled(), await db.prepare('SELECT status, disconnect_error FROM channex_connections').first()],
      [1, { status: 'connected', disconnect_error: `Channex answered 503 to DELETE /channels/chan-1/mappings/${channex.channel.ratePlans[0]!.id}: Airbnb is not answering` }])
    // The same delivery again, for a disconnect no longer asked for, does nothing.
    const writes = channex.seen.filter(request => request.method !== 'GET').length
    await syncs.deliver(env, { ...asked, id: crypto.randomUUID() })
    assert.equal(channex.seen.filter(request => request.method !== 'GET').length, writes)
    channex.failMappingRemoval = false
    await assert.rejects(connection.disconnect('chan-1'), { status: 409, data: { code: 'DISCONNECT_FAILED' } })
    assert.equal(syncs.pending.length, 0)
    assert.deepEqual(await connection.disconnect('chan-1', true), { disconnected: false })
    await syncs.drain(env)
    assert.deepEqual([await enabled(), channex.channel.ratePlans, await db.prepare('SELECT status, channel_id, disconnect_error FROM channex_connections').first()],
      [0, [], null])
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
    assert.equal(await db.prepare('SELECT status FROM channex_connections').first('status'), 'connected')
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a sync request is checked against the plan once, then Blawby imports, activates and stops listings in the background', { timeout: 120_000 }, async () => {
  const { runtime, db, env, queue, syncs } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    await connected(db, env, channex)
    // The owner hosts with a published profile, so the two homes added by hand can be published.
    await db.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, public_name, public_bio, public_approved, updated_at, updated_by)
      VALUES ('m-owner', ?, ?, '[]', '[]', 'Owner Host', NULL, 1, '2026-10-15T00:00:00.000Z', ?)`).bind(ORG, TZ, OWNER).run()
    for (const name of ['Dune Hut', 'Reef Hut']) {
      const made = await createStayHome(env, db, manager, stayHomeInput({ name, timezone: TZ, address: `1 ${name} Rd`, city: 'Moab', country: 'US', check_in_time: '15:00', check_out_time: '11:00', max_guests: 2, min_nights: 1, base_price_minor: 100_00, assigned_member_id: 'm-owner' }), name)
      assert.equal((await updateStayHome(env, db, manager, made.product_id, { published: true })).home.live, true)
    }

    const app = new H3()
    app.post('/api/organizations/:organization_id/integrations/airbnb/sync', syncPostRoute)
    app.get('/api/organizations/:organization_id/integrations/airbnb/sync', syncGetRoute)
    app.get('/api/organizations/:organization_id/integrations/airbnb/listings', listingsRoute)
    const login = await createAuth(env).api.signInEmail({ body: { email: 'owner@example.test', password: PASSWORD }, asResponse: true })
    const token = login.headers.get('set-auth-token')
    assert.ok(token, 'Better Auth answers a bearer token for the app')
    // The iPhone app uses a bearer session without a browser origin. The Worker
    // consumer advances the job after the request returns.
    const call = async (method: string, body?: unknown, leaf = 'sync') => {
      const response = await app.request(Object.assign(new Request(`${BASE}/api/organizations/${ORG}/integrations/airbnb/${leaf}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }),
        { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    const runSyncs = () => syncs.drain(env)
    const failSync = async () => {
      await assert.rejects(runSyncs)
      await runSyncs()
    }
    const job = () => db.prepare('SELECT action, state, product_id, last_error_code FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first<Record<string, unknown>>()

    // Airbnb sync is Business: on Basic the request is refused before anything is queued, and nothing reaches Channex.
    await db.prepare("UPDATE subscription SET status = 'canceled' WHERE id = 'sub-boot'").run()
    const writesBefore = channex.seen.filter(request => request.method !== 'GET').length
    const refused = await call('POST', { sync: [{ listing_id: LISTING }] })
    assert.equal(refused.status, 403)
    assert.deepEqual((refused.body as { data: Record<string, unknown> }).data, { code: 'ENTITLEMENT_REQUIRED', entitlement: 'channel_sync' })
    assert.match(JSON.stringify(refused.body), /Airbnb sync comes with the Business plan/)
    assert.equal(await job(), null)
    assert.equal(channex.seen.filter(request => request.method !== 'GET').length, writesBefore)

    // On Business it stays queued until the Worker consumes it. The organization has no contact email or phone and the
    // request names none: the listing fails with the field, and nothing is made.
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, periodEnd) VALUES ('sub-org', 'business', ?, 'active', 1, ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86_400).run()
    const queued = await call('POST', { sync: [{ listing_id: LISTING }] })
    assert.equal(queued.status, 202)
    assert.deepEqual((queued.body.listings as Array<Record<string, unknown>>).map(listing => [listing.listing_id, listing.action, listing.status]), [[LISTING, 'sync', 'queued']])
    assert.deepEqual(await job(), { action: 'sync', state: 'pending', product_id: null, last_error_code: null })
    assert.equal(channex.seen.filter(request => request.method !== 'GET').length, writesBefore, 'HTTP only queues the change')
    await failSync()
    assert.deepEqual(await job(), { action: 'sync', state: 'failed', product_id: null, last_error_code: 'MISSING_DETAIL' })
    const failedRow = ((await call('GET')).body.listings as Array<{ status: string; error: { code: string } }>)[0]!
    assert.deepEqual([failedRow.status, failedRow.error.code], ['failed', 'MISSING_DETAIL'])
    assert.equal(await count(db, 'product_channel_mappings'), 0)

    // Airbnb failing behind Channex when the job runs fails the listing with Airbnb's answer; asking again runs it again.
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING, details: form.missingDetails }] })).status, 202)
    channex.airbnbDown = true
    await failSync()
    assert.deepEqual(await db.prepare('SELECT state, last_error_code FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first(), { state: 'failed', last_error_code: 'CHANNEX_REQUEST_FAILED' })
    channex.airbnbDown = false

    // With the missing contact in the request's details, asked again, the same listing imports, a few photos per step, and goes live.
    channex.extraPhotos = 8
    const propertyCreatesBefore = channex.seen.filter(request => request.method === 'POST' && request.path === '/properties').length
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING, details: form.missingDetails }] })).status, 202)
    const queuedId = await db.prepare('SELECT id FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first('id')
    const yielded = { state: 'pending', last_error_code: null }
    assert.deepEqual(await db.prepare('SELECT state, last_error_code FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first(), yielded)
    assert.equal(await count(db, 'product_channel_mappings'), 0)
    assert.equal(channex.seen.filter(request => request.method === 'POST' && request.path === '/properties').length, propertyCreatesBefore, 'HTTP does not begin the import')
    const nextSyncs = () => syncs.pending.map(({ body, delaySeconds }) => ({ body, delaySeconds }))
    const step = { body: { type: 'airbnb.sync_step', organization_id: ORG, job_id: queuedId }, delaySeconds: 0 }
    assert.deepEqual(nextSyncs(), [step])
    assert.ok(syncs.take(), 'deployment recovery must find the job without its original delivery')
    const providerCallsBeforeRecovery = channex.seen.length
    await queue.binding.send({ type: 'deployment.adopt_pending_work' })
    await queue.runNext(env, 'deployment.adopt_pending_work')
    assert.deepEqual(nextSyncs(), [step], 'deployment recovery sends the persisted job to the serial queue')
    assert.equal(channex.seen.length, providerCallsBeforeRecovery)
    await syncs.runNext(env)
    assert.deepEqual(await db.prepare('SELECT state, last_error_code FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first(), yielded)
    assert.equal(await db.prepare('SELECT import_stage FROM product_channel_mappings').first('import_stage'), 'property')
    assert.equal(channex.seen.filter(request => request.method === 'POST' && request.path === '/properties').length, propertyCreatesBefore, 'one delivery performs one provider step')
    assert.deepEqual(nextSyncs(), [step], 'the next delivery names the same persisted job')
    assert.deepEqual(((await call('GET')).body.listings as Array<Record<string, unknown>>).map(listing => [listing.status, listing.stage]), [['running', 'property']])
    // Every step is delivered twice, one after the other as AIRBNB_SYNC delivers them: each create reaches Channex once.
    for (let item = syncs.take(); item; item = syncs.take()) {
      await syncs.deliver(env, item)
      await syncs.deliver(env, { ...item, id: crypto.randomUUID() })
    }
    const creates = (path: string) => channex.seen.filter(request => request.method === 'POST' && request.path === path).length
    assert.deepEqual([creates('/properties') - propertyCreatesBefore, creates('/room_types'), creates('/rate_plans'), creates('/channels/chan-1/mappings')], [1, 1, 1, 1])
    assert.equal(await db.prepare('SELECT id FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first('id'), queuedId)
    const done = await job()
    assert.deepEqual({ ...done, product_id: null }, { action: 'sync', state: 'done', product_id: null, last_error_code: null })
    const productId = done!.product_id as string
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_airbnb_listings WHERE product_id = ?').bind(productId).first(), { import_stage: 'complete', enabled: 1 })
    assert.deepEqual(((await call('GET')).body.listings as Array<Record<string, unknown>>).map(listing => [listing.product_id, listing.action, listing.status, listing.stage, listing.error]), [[productId, 'sync', 'done', 'complete', null]])
    assert.equal(channex.photoFetches, 11)
    assert.equal((await readStayHome(db, manager, productId)).photos.length, 11)
    assert.equal(await countActiveHomes(db, ORG), 3)
    assert.equal(channex.channel.ratePlans.length, 1)

    // Airbnb removes the listing while Channex still reports the rate row.
    await updateStayHome(env, db, manager, productId, { published: true })
    channex.listingPresent = false
    channex.channel.ratePlans[0]!.settings = {}
    assert.deepEqual(await call('GET', undefined, 'listings'), {
      status: 200, body: { listings: [], missing_listings: [{ listing_id: LISTING, product_id: productId, internal_name: 'Cliff Cabin' }] },
    })
    const callsBeforeStop = channex.seen.length
    const unknownHome = await call('POST', { stop_listing_ids: [LISTING, 'not-a-listing'] })
    assert.equal(unknownHome.status, 404)
    assert.equal((await job())!.action, 'sync', 'an invalid home refuses the entire stop request')
    assert.equal(syncs.pending.length, 0)
    const stopped = await call('POST', { stop_listing_ids: [LISTING] })
    assert.deepEqual([stopped.status, (stopped.body.listings as Array<Record<string, unknown>>)[0]!.action], [202, 'stop'])
    assert.equal(channex.seen.length, callsBeforeStop, 'the stop addresses the saved mapping without asking Airbnb for the listing')
    await runSyncs()
    assert.deepEqual(await job(), { action: 'stop', state: 'done', product_id: productId, last_error_code: null })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_airbnb_listings WHERE product_id = ?').bind(productId).first(), { import_stage: 'draft', enabled: 0 })
    assert.deepEqual(await call('GET', undefined, 'listings'), { status: 200, body: { listings: [], missing_listings: [] } })
    const preserved = await readStayHome(db, manager, productId)
    assert.deepEqual([preserved.published, preserved.live, preserved.photos.length, channex.channel.active], [true, true, 11, true])
    await updateStayHome(env, db, manager, productId, { published: false })
    channex.listingPresent = true
    assert.deepEqual([channex.channel.ratePlans, await countActiveHomes(db, ORG)], [[], 2])
    // A home found partway through activation (as one interrupted at `messages`) is carried to complete. A provider
    // failure on the way fails the listing with Channex's answer; asking again carries on from the same stage.
    const connection = new ChannexConnection(db, env, ORG, OWNER)
    await connection.activate(LISTING)
    for (let step = 0; step < 6 && (await connection.advance(LISTING)).stage !== 'messages'; step++);
    assert.equal(await db.prepare('SELECT import_stage FROM product_airbnb_listings WHERE product_id = ?').bind(productId).first('import_stage'), 'messages')
    channex.failMessages = true
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    await failSync()
    assert.deepEqual(await job(), { action: 'sync', state: 'failed', product_id: productId, last_error_code: 'CHANNEX_REQUEST_FAILED' })
    const failedAtMessages = ((await call('GET')).body.listings as Array<Record<string, unknown>>)[0]!
    assert.deepEqual([failedAtMessages.status, failedAtMessages.stage, (failedAtMessages.error as { code: string }).code], ['failed', 'messages', 'CHANNEX_REQUEST_FAILED'])
    channex.failMessages = false
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    await runSyncs()
    assert.deepEqual(await job(), { action: 'sync', state: 'done', product_id: productId, last_error_code: null })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_airbnb_listings WHERE product_id = ?').bind(productId).first(), { import_stage: 'complete', enabled: 1 })

    // Growth ends: Stripe deletes the subscription and Better Auth marks it canceled. On Basic, the newest live homes
    // past the one it includes, the Airbnb one among them, go back to drafts: Blawby queues its stop itself, and the task runs it.
    await db.prepare("UPDATE organization SET stripeCustomerId = 'cus_org' WHERE id = ?").bind(ORG).run()
    await db.prepare("UPDATE subscription SET status = 'canceled' WHERE id = 'sub-org'").run()
    await returnExtrasToDraftsForPlanEnd(env, db, { type: 'customer.subscription.deleted', data: { object: { id: 'sub-org', customer: 'cus_org', status: 'canceled' } } } as unknown as Stripe.Event)
    assert.deepEqual(await db.prepare('SELECT action, state, requested_by FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first(), { action: 'stop', state: 'pending', requested_by: null })
    await runSyncs()
    assert.deepEqual(await job(), { action: 'stop', state: 'done', product_id: productId, last_error_code: null })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_airbnb_listings WHERE product_id = ?').bind(productId).first(), { import_stage: 'draft', enabled: 0 })
    assert.deepEqual([channex.channel.ratePlans, await countActiveHomes(db, ORG)], [[], 1])

    // On Basic, syncing it again is a Business feature: refused at the request.
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 403)
    // Back on Business, a request naming nothing, an unknown listing or a home not from Airbnb is refused.
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, periodEnd) VALUES ('sub-org-again', 'business', ?, 'active', 1, ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86_400).run()
    assert.equal((await call('POST', {})).status, 422)
    assert.equal((await call('POST', { sync: [{ listing_id: 'listing-404' }] })).status, 404)
    assert.equal((await call('POST', { stop: ['not-a-home'] })).status, 404)
    // Details may only hold what the listing's details report missing, each non-empty.
    const extra = await call('POST', { sync: [{ listing_id: LISTING, details: { city: 'Elsewhere' } }] })
    assert.deepEqual([extra.status, (extra.body as { data: Record<string, unknown> }).data.code, (extra.body as { data: Record<string, unknown> }).data.field], [422, 'ONLY_MISSING_DETAILS', 'details.city'])
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING, details: { email: ' ' } }] })).status, 422)
    // Queued work rechecks the requester's current Better Auth membership before any provider access.
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    await db.prepare("UPDATE member SET role = 'member' WHERE userId = ? AND organizationId = ?").bind(OWNER, ORG).run()
    const refusedAccessStart = channex.seen.length
    await failSync()
    assert.deepEqual(await job(), { action: 'sync', state: 'failed', product_id: productId, last_error_code: 'FORBIDDEN' })
    assert.deepEqual(channex.seen.slice(refusedAccessStart), [])
    await db.prepare("UPDATE member SET role = 'owner' WHERE userId = ? AND organizationId = ?").bind(OWNER, ORG).run()
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    await db.prepare('DELETE FROM member WHERE userId = ? AND organizationId = ?').bind(OWNER, ORG).run()
    const removedAccessStart = channex.seen.length
    await failSync()
    assert.deepEqual(await job(), { action: 'sync', state: 'failed', product_id: productId, last_error_code: 'REQUESTER_REMOVED' })
    assert.deepEqual(channex.seen.slice(removedAccessStart), [])

    // Disconnecting while a sync is queued: the request writes nothing to Channex. It marks the connection
    // disconnecting, so the queued step refuses, and AIRBNB_SYNC runs the disconnect after it.
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner-again', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    // No Stripe customer: disconnecting reports no metered homes to Stripe here.
    await db.prepare('UPDATE organization SET stripeCustomerId = NULL WHERE id = ?').bind(ORG).run()
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    const disconnectStart = channex.seen.length
    assert.deepEqual(await new ChannexConnection(db, env, ORG, OWNER).disconnect('chan-1'), { disconnected: false })
    assert.deepEqual([channex.seen.slice(disconnectStart).filter(request => request.method !== 'GET'), await db.prepare('SELECT status FROM channex_connections').first('status')], [[], 'disconnecting'])
    await failSync()
    assert.deepEqual(await job(), { action: 'sync', state: 'failed', product_id: productId, last_error_code: 'NOT_CONNECTED' })
    assert.deepEqual(await db.prepare('SELECT status, channel_id FROM channex_connections').first(), null)
    assert.deepEqual(channex.seen.slice(disconnectStart).filter(request => request.method !== 'GET').map(request => `${request.method} ${request.path}`), ['POST /channels/chan-1/deactivate', 'DELETE /channels/chan-1'])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('the import asks only for required contact details and preserves provider booking settings', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const realRules = channex.availabilityRules
    for (const value of [undefined, null, 0, 1126, 1.5, '5']) {
      channex.availabilityRules = { ...realRules, default_min_nights: value }
      await assert.rejects(connection.prepare(LISTING, form), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 502 && error.data?.code === 'INVALID_PROVIDER_RESPONSE')
      assert.deepEqual([await count(db, 'business_locations'), await count(db, 'products'), await count(db, 'product_channel_mappings')], [0, 0, 0])
    }
    channex.availabilityRules = realRules
    for (const rules of [
      { ...realRules, day_of_week_min_nights: [1, 2] },
      { ...realRules, day_of_week_min_nights: [0, -1, -1, -1, -1, -1, -1] },
    ]) {
      channex.availabilityRules = rules
      await assert.rejects(connection.prepare(LISTING, form), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 502 && error.data?.code === 'INVALID_PROVIDER_RESPONSE')
      assert.equal(await count(db, 'products'), 0)
    }
    channex.availabilityRules = realRules
    // Only the fields Airbnb left out may be supplied.
    await assert.rejects(connection.prepare(LISTING, { missingDetails: { ...form.missingDetails, city: 'Elsewhere' } }), { status: 422, data: { code: 'ONLY_MISSING_DETAILS' } })
    // Airbnb never says who looks after a home: the host names a member of this organization, or nothing is created.
    const { assigned_member_id: _member, ...withoutMember } = form.missingDetails
    await assert.rejects(connection.prepare(LISTING, { missingDetails: withoutMember }), { status: 422, data: { code: 'MISSING_DETAIL', field: 'details.assigned_member_id' } })
    await assert.rejects(connection.prepare(LISTING, { missingDetails: { ...form.missingDetails, assigned_member_id: 'm-elsewhere' } }), { status: 422, data: { code: 'INVALID_DETAIL', field: 'details.assigned_member_id' } })
    assert.equal(await count(db, 'products'), 0)
    const policies = channex.booking.cancellation_policy_settings
    // Untranslated provider terms do not block the home or acquire a different local policy.
    channex.booking = { ...channex.booking, cancellation_policy_settings: { cancellation_policy_category: 'super_strict_30', lts_cancellation_policy_id: 'CANCEL_LONG_TERM_FAIR' } }
    const untranslated = await connection.details(LISTING)
    assert.equal(untranslated.cancellation_policy, null)
    assert.equal(untranslated.long_term_cancellation_policy, 'firm')
    channex.booking = { ...channex.booking, cancellation_policy_settings: policies }
    // A flexible end is a home whose check-in window has no end; an hour after midnight is that hour.
    channex.booking = { ...channex.booking, check_in_time_start: '16', check_in_time_end: 'FLEXIBLE', check_out_time: 10 }
    assert.equal((await connection.details(LISTING)).check_in_end_time, null)
    channex.booking = { ...channex.booking, check_in_time_end: '25' }
    assert.equal((await connection.details(LISTING)).check_in_end_time, '01:00')
    // The home has Airbnb's window; Channex's child-only beds and infant cots are 0, as Airbnb counts neither.
    const started = await connection.prepare(LISTING, form)
    // It books under the listing's own policies: Firm, and Strict Long Term.
    assert.deepEqual(await db.prepare('SELECT check_in_time, check_in_end_time, check_out_time, cancellation_policy, long_term_cancellation_policy FROM product_booking_configs WHERE product_id = ?').bind(started.product_id).first(),
      { check_in_time: '16:00', check_in_end_time: '01:00', check_out_time: '10:00', cancellation_policy: 'firm', long_term_cancellation_policy: 'strict' })
    assert.deepEqual(channex.roomTypes, [])
    const property = JSON.parse(String(await db.prepare('SELECT import_property FROM product_channel_mappings WHERE product_id = ?').bind(started.product_id).first('import_property'))) as Record<string, unknown>
    assert.deepEqual(['child_beds', 'infant_cots'].filter(key => key in property), [])
    await advanceTo(connection, db, channex, started.product_id, 'draft')
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

async function count(db: D1Database, table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n
}

test('a connected backup merges into the same room across accounts and keeps billing and booking history', { timeout: 120_000 }, async () => {
  const { runtime, db, env, syncs } = await boot()
  const primary = new FakeChannex()
  const backup = new FakeChannex()
  backup.channelId = 'chan-2'
  backup.listingId = 'backup'
  backup.nightlyRate = 129
  backup.ratePlans = primary.ratePlans
  backup.rateProperties = primary.rateProperties
  const realFetch = globalThis.fetch
  let authorizingBackup = false
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
    if (path.endsWith('/ack')) return Promise.resolve(Response.json({ meta: { message: 'Success' } }))
    return (path.includes('/channels/chan-2') || (authorizingBackup && path.includes('/meta/airbnb/connection_link'))
      ? backup : primary).fetch(input, init)
  }) as typeof fetch
  try {
    const connection = await connected(db, env, primary)
    const { product_id: targetId } = await connection.prepare(LISTING, form)
    await advanceTo(connection, db, primary, targetId, 'draft')
    await connection.activate(LISTING)
    await advanceTo(connection, db, primary, targetId, 'complete')
    const target = await readStayHome(db, manager, targetId)
    const inventory = await db.prepare('SELECT property_id, room_type_id, rate_plan_id FROM product_channel_mappings WHERE product_id = ?')
      .bind(targetId).first<{ property_id: string; room_type_id: string; rate_plan_id: string }>()
    assert.ok(inventory)

    authorizingBackup = true
    await connection.start()
    await connection.complete(backup.token, 'chan-2')
    authorizingBackup = false
    assert.deepEqual((await connection.status()).connections.map(account => account.channel_id).sort(), ['chan-1', 'chan-2'])
    assert.deepEqual((await connection.listings()).listings.map(listing => listing.id).sort(), [LISTING, 'backup'].sort())

    const source = await createProduct(db, { env, organizationId: ORG, actor: { actorId: OWNER }, product: {
      kind: 'stay', name: 'Cabin Backup', variants: [{ name: 'Cabin Backup', prices: [{ unit_amount: 12900, currency: 'USD' }] }],
      stay: { location_id: target.location_id, check_in_time: '16:00', check_out_time: '10:00', max_guests: 4, min_nights: 2, assigned_member_id: 'm-owner' },
    } })
    await db.batch([
      db.prepare(`INSERT INTO product_channel_mappings (organization_id, product_id, provider, property_id, room_type_id, rate_plan_id, import_stage, enabled)
        VALUES (?, ?, 'channex', 'old-property', 'old-room', 'old-rate', 'complete', 1)`).bind(ORG, source.id),
      db.prepare(`INSERT INTO product_airbnb_listings (organization_id, product_id, listing_id, channel_id, import_stage, enabled)
        VALUES (?, ?, 'backup', 'chan-2', 'complete', 1)`).bind(ORG, source.id),
    ])
    backup.channel.active = true
    backup.channel.properties = ['old-property']
    backup.channel.ratePlans = [{ id: 'old-mapping', rate_plan_id: 'old-rate', settings: { listing_id: 'backup' } }]
    const arrival = addDays(today(), 10)
    const departure = addDays(arrival, 3)
    const stay = await applyChannelBooking(db, env, ORG, source.id, {
      provider: 'channex', channel: 'airbnb', external_booking_id: 'old-booking', channel_booking_id: 'HMBACKUP', revision_id: 'old-revision',
      provider_updated_at: '2026-10-30T00:00:00Z', check_in_date: arrival, check_out_date: departure, cancelled: false,
      adults: 2, children: 0, infants: 0, total_minor: 38700, currency: 'USD', guest_name: 'Guest', guest_surname: null, guest_email: null, guest_phone: null,
    })
    assert.equal(await countActiveHomes(db, ORG), 2)
    await connection.attach('backup', targetId)
    for (let step = 0; step < 5; step++) if ((await connection.advance('backup')).stage === 'complete') break
    const merged = await readStayHome(db, manager, targetId)
    assert.deepEqual(merged.airbnb_listings.map(listing => [listing.listing_id, listing.channel_id, listing.enabled]), [[LISTING, 'chan-1', true], ['backup', 'chan-2', true]])
    const ratePlan = backup.channel.ratePlans[0]!.rate_plan_id
    assert.equal(primary.ratePlans.get(ratePlan)?.room_type_id, inventory.room_type_id)
    assert.equal(primary.ratePlans.get(ratePlan)?.property_id, inventory.property_id)
    assert.equal(primary.restrictionsByRate.get(ratePlan)?.get(addDays(today(), 1)), '129.00')
    assert.equal(primary.availability[arrival], 0)
    assert.equal(await countActiveHomes(db, ORG), 2)
    assert.equal(await db.prepare('SELECT active FROM products WHERE id = ?').bind(source.id).first('active'), 0)
    assert.equal((await getStay(db, manager, stay.id)).product_id, targetId)
    assert.deepEqual(await db.prepare('SELECT DISTINCT product_id FROM stay_nights WHERE booking_id = ?').bind(stay.id).all().then(result => result.results), [{ product_id: targetId }])

    const revision = await landBookingRevision(db, env, { id: 'cancel-after-merge', type: 'booking_revision', attributes: {
      property_id: 'old-property', booking_id: 'old-booking', ota_name: 'AirBNB', ota_reservation_code: 'HMBACKUP',
      inserted_at: '2026-10-30T01:00:00Z', status: 'cancelled', arrival_date: arrival, departure_date: departure, amount: '387.00', currency: 'USD',
      occupancy: { adults: 2, children: 0, infants: 0 }, customer: { name: 'Guest' },
    } })
    assert.equal(revision.status, 'acknowledged')
    const cancelled = await getStay(db, manager, stay.id)
    assert.deepEqual([cancelled.status, cancelled.product_id, cancelled.conversation_id], ['cancelled', targetId, stay.conversation_id])
    await connection.disconnect('chan-2')
    await syncs.drain(env)
    assert.deepEqual((await connection.status()).connections.map(account => account.channel_id), ['chan-1'])
    assert.equal((await readStayHome(db, manager, targetId)).channel?.status, 'connected')
    assert.equal(await countActiveHomes(db, ORG), 1)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})
