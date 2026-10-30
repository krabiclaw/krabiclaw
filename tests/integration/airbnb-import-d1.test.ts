import assert from 'node:assert/strict'
import type Stripe from 'stripe'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3, HTTPError } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { ChannexError } from '../../server/integrations/channex/client.ts'
import { listingCalendar, listingMinimumNights } from '../../server/integrations/channex/airbnb-listing.ts'
import { AirbnbConnection, type ImportContentReport } from '../../server/integrations/channex/airbnb-connection.ts'
import { createStay, createStayHome, deliverPendingChannelNights, readStayCalendar, readStayHome, setStayNights, stayHomeInput, updateStayHome } from '../../server/domain/stays.ts'
import { deleteMediaAsset, getMediaAsset } from '../../server/utils/media-asset-manager.ts'
import { getProduct } from '../../server/utils/product-management.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import { countActiveHomes } from '../../server/utils/billing.ts'
import { publishedCatalogResponse } from './support/stripe-published-catalog.ts'
import { returnExtrasToDraftsForPlanEnd } from '../../server/utils/billing-plan-end.ts'
import contentRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/imports/[productId]/content.post.ts'
import calendarRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/imports/[productId]/calendar.post.ts'
import syncPostRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/sync.post.ts'
import syncGetRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/sync.get.ts'
import { requestAirbnbSync, runAirbnbSyncJobs } from '../../server/integrations/channex/airbnb-sync.ts'
import listingsRoute from '../../server/api/organizations/[organizationId]/integrations/airbnb/listings.get.ts'
import { errorChainForTelemetry } from '../../shared/error-telemetry.ts'

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
  weekendPrice: number | null = null
  calendarMinimum = (_date: string, _offset: number): number => 2
  calendarRate = (_date: string, offset: number): number => offset === 0 ? 210 : 189.5
  availabilityRules: Record<string, unknown> = { ...AIRBNB_AVAILABILITY, default_min_nights: 5 }
  channel = { title: '', active: false, settings: { min_stay_type: 'Arrival' } as Record<string, unknown>, properties: ['setup-1'], ratePlans: [] as Array<{ id: string; rate_plan_id: string; settings: { listing_id: string } }> }
  availability: Record<string, number> = {}
  restrictions: Record<string, Record<string, unknown>> = {}
  token = ''
  channelId = 'chan-1'
  listings = [LISTING]
  messagesProperty: string | null = null
  failMessages = false
  /** Airbnb failing behind Channex: Channex answers 422 carrying Airbnb's own 500, as it did on production 2026-10-23. */
  airbnbDown = false
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
    if (method === 'POST' && path === '/groups') return json({ data: { id: 'grp-1', type: 'group', attributes: {} } })
    if (method === 'POST' && path === '/properties') {
      if (body!.property.title === 'KrabiClaw connection setup') return json({ data: { id: 'setup-1', type: 'property', attributes: {} } })
      const id = `prop-${++this.ids}`
      const property = { ...body!.property, id }
      this.properties.push(property)
      return json({ data: { id, type: 'property', attributes: property } })
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
      } : { rooms: [], images: null, descriptions: null }
      return json({ data: { listing: { id: listingId, name: 'Cliff Cabin', person_capacity: 4, lat: 38.5733, lng: -109.5498, country_code: 'US', state: 'UT', city: 'Moab', street: '1 Cliff Rd', zipcode: '84532', property_type_category: this.category, availability_rules: this.availabilityRules, booking_settings: this.booking, pricing_settings: { listing_currency: this.currency, guests_included: 2, default_daily_price: 189.5, weekend_price: this.weekendPrice, standard_fees: [], weekly_price_factor: 0, monthly_price_factor: 0 }, ...content } } })
    }
    if (method === 'GET' && path === '/channels/chan-1/action/get_listing_calendar') {
      const from = url.searchParams.get('date_from')!
      const days = Array.from({ length: 500 }, (_, i) => ({ date: addDays(from, i), availability: i === 3 ? 'unavailable' : 'available', daily_price: Number(this.restrictions[addDays(from, i)]?.rate ?? this.calendarRate(addDays(from, i), i)), min_nights: this.restrictions[addDays(from, i)]?.min_stay_arrival ?? this.calendarMinimum(addDays(from, i), i), max_nights: 30, closed_to_arrival: false, closed_to_departure: i === 5 }))
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
    if (method === 'GET' && /^\/channels\/chan-1\/mappings\/[^/]+\/availability_settings$/.test(path)) return json({ data: { id: path.split('/')[4], type: 'airbnb_listing_availability_settings', attributes: AIRBNB_AVAILABILITY } })
    if (method === 'PUT' && /^\/channels\/chan-1\/mappings\/[^/]+\/(availability|pricing)_settings$/.test(path)) {
      const settings = JSON.parse(String(init.body)) as { availability_settings?: { default_min_nights?: number } }
      if (settings.availability_settings?.default_min_nights !== undefined) this.availabilityRules.default_min_nights = settings.availability_settings.default_min_nights
      this.settings.push({ [path.split('/').pop()!]: settings }); return json({ data: {} })
    }
    // ARI arrives as inclusive date ranges; Channex keeps each date's values.
    const dates = (value: { date_from: string; date_to: string }) => Array.from({ length: daysBetween(value.date_from, value.date_to) + 1 }, (_, offset) => addDays(value.date_from, offset))
    if (method === 'POST' && path === '/restrictions') {
      for (const value of body!.values) for (const date of dates(value)) {
        const { date_from: _from, date_to: _to, ...rule } = value
        this.restrictions[date] = { ...this.restrictions[date], ...rule }
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
      ...await runtime.getBindings<CloudflareEnv>(), DB: db, CHANNEX_BASE_URL: 'https://channex.test/api/v1', CHANNEX_API_KEY: 'k', STRIPE_SECRET_KEY: 'sk_test_local_d1',
      BETTER_AUTH_URL: BASE, BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test', GOOGLE_CLIENT_ID: 'test-google-client',
      GOOGLE_CLIENT_SECRET: 'test-google-secret', APPLE_APP_BUNDLE_ID: 'com.krabiclaw.app', MEDIA_BASE_URL: 'https://media.proof.example', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as unknown as CloudflareEnv
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', ?)`).bind(ORG, TZ).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    // Airbnb sync is Business; a test about the plan lapsing cancels this subscription first.
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, periodEnd) VALUES ('sub-boot', 'business', ?, 'active', 1, ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86_400).run()
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
    // Airbnb's category is not a Channex property type: a townhouse or house is Channex's holiday home, and a category with no mapping stops the import.
    assert.equal(details.fields.propertyType, 'holiday_home')
    channex.category = 'house'
    assert.equal((await connection.details(LISTING)).fields.propertyType, 'holiday_home')
    channex.category = 'treehouse'
    await assert.rejects(connection.details(LISTING), { status: 422, data: { code: 'UNSUPPORTED_PROPERTY_TYPE' } })
    channex.category = 'townhouse'

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
    assert.deepEqual(home, { kind: 'stay', name: 'Cliff Cabin', check_in_time: '16:00', check_in_end_time: '21:00', check_out_time: '10:00', max_guests: 4, min_nights: 5, location: 'Cliff Cabin', timezone: TZ, email: 'Stay@Example.test', unit_amount: 18_950, currency: 'USD' })
    const nights = await db.prepare("SELECT COUNT(*) AS total, SUM(closed) AS closed, SUM(closed_to_departure) AS ctd, MAX(price_minor) AS top FROM product_nights WHERE product_id = ? AND source = 'import'").bind(productId).first()
    assert.deepEqual(nights, { total: 500, closed: 1, ctd: 1, top: 21_000 })
    const first = await db.prepare('SELECT date, price_minor, min_stay_arrival, max_stay FROM product_nights WHERE product_id = ? ORDER BY date LIMIT 1').bind(productId).first()
    assert.deepEqual(first, { date: today(), price_minor: 21_000, min_stay_arrival: 2, max_stay: 30 })

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
    // The Channex property carries the mapped type, never Airbnb's category.
    assert.deepEqual(channex.properties.filter(property => property.title === 'Cliff Cabin').map(property => property.property_type), ['holiday_home'])
    // The full sync is one restrictions and one availability call, each logged with Channex's task.
    assert.deepEqual((await db.prepare("SELECT kind, status, task_id FROM channel_sync_log WHERE direction = 'outbound' AND product_id = ? ORDER BY created_at, rowid").bind(productId).all()).results,
      [{ kind: 'restrictions', status: 'pushed', task_id: 'task-restrictions' }, { kind: 'availability', status: 'pushed', task_id: 'task-availability' }])
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
        // The listing's children, infant and pet-capacity controls are restated under ours.
        guest_controls: { allows_children_as_host: true, allows_infants_as_host: true, allows_pets_as_host: true, allows_events_as_host: false, allows_smoking_as_host: false, children_not_allowed_details: null, pet_capacity: 1 }, cancellation_policy_settings: { cancellation_policy_category: 'firm_14', lts_cancellation_policy_id: 'CANCEL_LONG_TERM_WITH_GRACE_PERIOD' }, instant_booking_allowed_category: 'everyone', listing_expectations_for_guests: [{ type: 'requires_stairs', added_details: null }] } } },
      { availability_settings: { availability_settings: { ...AIRBNB_AVAILABILITY, default_min_nights: 3 } } },
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
    // Draft edits become the canonical provider defaults once the actual mapping is recreated, before the home goes live.
    await updateStayHome(env, db, manager, productId, { min_nights: 7, base_price_minor: 250_00 })
    assert.equal(channex.availabilityRules.default_min_nights, 3)
    // Activate syncs it again, through the same stages.
    assert.deepEqual(await connection.activate(productId), { product_id: productId, stage: 'mapping', waiting: false })
    const property = channex.properties.find(property => property.id === mapping!.property_id)!
    const settings = property.settings as Record<string, unknown>
    delete settings.min_stay_type
    await assert.rejects(connection.advance(productId), { status: 502, data: { code: 'INVALID_PROVIDER_RESPONSE', field: 'calendar_defaults', provider_status: 502, uncertain: false } })
    settings.min_stay_type = 'unknown'
    await assert.rejects(connection.advance(productId), { status: 502, data: { code: 'INVALID_PROVIDER_RESPONSE', field: 'calendar_defaults', provider_status: 502, uncertain: false } })
    // A property created under the old through/both model is repaired before its full calendar is sent.
    settings.min_stay_type = 'both'
    await advanceTo(connection, db, channex, productId, 'complete')
    assert.deepEqual(property.settings, { ...settings, min_stay_type: 'arrival' })
    assert.equal(property.title, 'Cliff Cabin')
    assert.deepEqual(Object.keys(channex.restrictions).sort(), Array.from({ length: 500 }, (_, offset) => addDays(today(), offset)))
    assert.equal(Object.values(channex.restrictions).every(rule => rule.min_stay_arrival === 2 && !Object.hasOwn(rule, 'min_stay_through')), true)
    assert.deepEqual([channex.availabilityRules.default_min_nights, channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival], [7, 7])
    assert.equal((channex.ratePlans.get(channex.ratePlan)!.options as Array<{ rate: string }>)[0]!.rate, '250.00')
    assert.deepEqual(await db.prepare('SELECT operation_id, pending_step FROM channex_connections').first(), { operation_id: null, pending_step: null })
    assert.deepEqual([channex.channel.ratePlans.length, channex.messagesProperty, (await readStayHome(db, manager, productId)).live], [1, mapping!.property_id, true])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('actual dated, weekday and weekend rules survive default edits, protected refresh and the rolling window', { timeout: 120_000 }, async (context) => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const firstDate = today()
  const seasonal = [{ start_date: addDays(firstDate, -10), end_date: addDays(firstDate, -5), min_nights: 7 }]
  channex.availabilityRules.seasonal_min_nights = seasonal
  channex.availabilityRules.day_of_week_min_nights = [2, -1, -1, -1, -1, -1, -1]
  channex.availabilityRules.booking_lead_time = 48
  channex.weekendPrice = 225
  channex.calendarMinimum = date => date === firstDate ? 11 : new Date(`${date}T00:00:00Z`).getUTCDay() === 1 ? 2 : Number(channex.availabilityRules.default_min_nights)
  channex.calendarRate = date => date === firstDate ? 210 : [5, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) ? 225 : 189.5
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const productId = (await connection.prepare(LISTING, form)).product_id
    await importAll(connection, db, channex, productId)
    assert.deepEqual((await readStayHome(db, manager, productId)).calendar_rules, { day_of_week_min_nights: [2, -1, -1, -1, -1, -1, -1], weekend_price_minor: 22500 })
    const monday = addDays(firstDate, (8 - new Date(`${firstDate}T00:00:00Z`).getUTCDay()) % 7 || 7)
    const tuesday = addDays(monday, 1)
    assert.deepEqual(await db.prepare('SELECT min_stay_arrival, price_minor FROM product_nights WHERE product_id = ? AND date = ?').bind(productId, tuesday).first(), { min_stay_arrival: null, price_minor: null })
    assert.deepEqual(await db.prepare('SELECT min_stay_arrival, price_minor FROM product_nights WHERE product_id = ? AND date = ?').bind(productId, firstDate).first(), { min_stay_arrival: 11, price_minor: 21000 })
    await updateStayHome(env, db, manager, productId, { min_nights: 9, base_price_minor: 20000 })
    assert.equal(((channex.settings.find(settings => settings.availability_settings)!.availability_settings as { availability_settings: { booking_lead_time: number } }).availability_settings).booking_lead_time, 48)
    assert.deepEqual((channex.settings.find(settings => settings.availability_settings)!.availability_settings as { availability_settings: { seasonal_min_nights: unknown } }).availability_settings.seasonal_min_nights, seasonal)
    await connection.refreshContent(productId)
    await updateStayHome(env, db, manager, productId, { min_nights: 10, base_price_minor: 21000 })
    const changed = await readStayCalendar(db, manager, { productId, from: monday, to: addDays(tuesday, 1) })
    assert.deepEqual(changed.nights.map(night => [night.date, night.min_stay_arrival, night.price_minor]), [[monday, 2, 21000], [tuesday, 10, 21000]])
    const authoredRules = { day_of_week_min_nights: [3, -1, -1, -1, -1, -1, -1], weekend_price_minor: 25000 }
    await updateStayHome(env, db, manager, productId, { calendar_rules: authoredRules })
    await setStayNights(db, env, manager, { product_id: productId, from: monday, to: addDays(monday, 1), min_stay_arrival: 4, price_minor: 23000 })
    const refreshed = await connection.refreshContent(productId)
    assert(refreshed.content.kept_host_edits.includes('calendar_rules'))
    assert.deepEqual((await readStayHome(db, manager, productId)).calendar_rules, authoredRules)
    assert.deepEqual(await db.prepare('SELECT source, min_stay_arrival, price_minor FROM product_nights WHERE product_id = ? AND date = ?').bind(productId, monday).first(), { source: 'host', min_stay_arrival: 4, price_minor: 23000 })
    assert.deepEqual(channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival, [3, 10, 10, 10, 10, 10, 10])
    const remote = await listingCalendar(env, channex.channelId, LISTING, TZ)
    assert.deepEqual(remote.filter(night => [monday, tuesday, addDays(monday, 7)].includes(night.date)).map(night => [night.date, night.minStay, night.rate]), [[monday, 4, '230'], [tuesday, 10, '210'], [addDays(monday, 7), 3, '210']])
    channex.currency = 'EUR'
    await assert.rejects(connection.refreshContent(productId), { status: 422, data: { code: 'CURRENCY_MISMATCH' } })
    assert.equal((await readStayHome(db, manager, productId)).currency, 'USD')
    channex.currency = 'USD'
    // Native weekday defaults own newly opened weekday-only dates; no explicit ARI replay is needed.
    await updateStayHome(env, db, manager, productId, { calendar_rules: { day_of_week_min_nights: authoredRules.day_of_week_min_nights } })
    const weekdayOnlyStart = channex.seen.length
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() + 7 * 86_400_000 })
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 0 })
    assert.deepEqual(channex.seen.slice(weekdayOnlyStart).filter(request => request.method === 'POST'), [])
    assert.deepEqual(channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival, [3, 10, 10, 10, 10, 10, 10])
    context.mock.timers.reset()
    await updateStayHome(env, db, manager, productId, { calendar_rules: authoredRules })
    // Native prices are scalar; only the newly exposed Friday/Saturday prices need dated delivery.
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() + 7 * 86_400_000 })
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 1 })
    const opened = addDays(firstDate, 500)
    const weekend = Array.from({ length: 7 }, (_, offset) => addDays(opened, offset)).find(date => new Date(`${date}T00:00:00Z`).getUTCDay() === 5)!
    assert.ok(weekend)
    assert.equal(channex.restrictions[weekend]!.rate, '250.00')
    const openedMonday = Array.from({ length: 7 }, (_, offset) => addDays(opened, offset)).find(date => new Date(`${date}T00:00:00Z`).getUTCDay() === 1)!
    assert.equal(channex.restrictions[openedMonday], undefined, 'weekday minima are left to the verified native rate-plan template')
    assert.deepEqual((await readStayCalendar(db, manager, { productId, from: openedMonday, to: addDays(openedMonday, 1) })).nights.map(night => [night.min_stay_arrival, night.price_minor]), [[3, 21000]])
    const visible = await readStayCalendar(db, manager, { productId, from: weekend, to: addDays(weekend, 1) })
    assert.deepEqual(visible.nights.map(night => [night.price_minor, night.min_stay_arrival]), [[25000, 10]])
  } finally {
    context.mock.timers.reset()
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a connected home can resend its full calendar without tearing down its mapping, racing a delivery or bypassing its pause', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const { product_id: productId } = await connection.prepare(LISTING, form)
    await importAll(connection, db, channex, productId)
    const app = new H3()
    app.post('/api/organizations/:organizationId/integrations/airbnb/imports/:productId/calendar', calendarRoute)
    const login = await createAuth(env).api.signInEmail({ body: { email: 'owner@example.test', password: PASSWORD }, asResponse: true })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const call = async (organization = ORG, product = productId, authenticated = true) => {
      const response = await app.request(Object.assign(new Request(`${BASE}/api/organizations/${organization}/integrations/airbnb/imports/${product}/calendar`, { method: 'POST', headers: { ...(authenticated ? { cookie } : {}), origin: BASE } }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    const unauthenticated = await call(ORG, productId, false)
    assert.equal(unauthenticated.status, 401)
    assert.deepEqual(unauthenticated.body.data, { code: 'UNAUTHORIZED', field: 'session' })
    const foreignOrganization = await call('another-organization')
    assert.equal(foreignOrganization.status, 404)
    assert.deepEqual(foreignOrganization.body.data, { code: 'ORGANIZATION_NOT_FOUND', field: 'organizationId' })
    const missingHome = await call(ORG, 'another-home')
    assert.equal(missingHome.status, 404)
    assert.deepEqual(missingHome.body.data, { code: 'IMPORT_NOT_FOUND' })
    const mapping = await db.prepare('SELECT property_id, room_type_id, rate_plan_id, channel_id, enabled, import_stage FROM product_channel_mappings WHERE product_id = ?').bind(productId).first()
    const channel = structuredClone(channex.channel)
    const messages = channex.messagesProperty
    const sent = await db.prepare('SELECT date, state, sent_json FROM channel_night_pushes WHERE product_id = ? ORDER BY date').bind(productId).all().then(result => result.results)
    const requests: Array<{ path: string; values: FakeBody['values'] }> = []
    let during: (() => Promise<void>) | undefined
    let limited = false
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (init.method === 'POST' && ['/api/v1/restrictions', '/api/v1/availability'].includes(url.pathname)) {
        requests.push({ path: url.pathname.slice('/api/v1'.length), values: (JSON.parse(String(init.body)) as FakeBody).values })
        const run = during
        during = undefined
        await run?.()
        if (limited) return Response.json({ errors: { message: 'Slow down' } }, { status: 429 })
      }
      return channex.fetch(input, init)
    }
    // A real night save owns the delivery lease while its provider call is in flight. Full sync refuses before resetting anything.
    during = async () => {
      const busy = await call()
      assert.equal(busy.status, 409)
      assert.deepEqual(busy.body.data, { code: 'CHANNEL_DELIVERY_BUSY' })
      assert.deepEqual(await db.prepare('SELECT date, sent_json FROM channel_night_pushes WHERE product_id = ? ORDER BY date').bind(productId).all().then(result => result.results), sent.map(({ date, sent_json }) => ({ date, sent_json })))
    }
    assert.deepEqual((await setStayNights(db, env, manager, { product_id: productId, from: addDays(today(), 20), to: addDays(today(), 21), price_minor: 24500 })).channel_push, { state: 'pushed', detail: null })
    requests.length = 0
    const fullSyncStart = channex.seen.length
    const resynced = await call()
    assert.deepEqual(resynced, { status: 200, body: { product_id: productId, channel_push: { state: 'pushed', detail: null } } })
    const assertFull = (providerStart: number) => {
      assert.deepEqual(channex.seen.slice(providerStart), [{ method: 'GET', path: '/channels/chan-1' }, { method: 'GET', path: '/properties/prop-1' }, { method: 'GET', path: '/channels/chan-1/action/listing_details' }, { method: 'GET', path: `/rate_plans/${channex.ratePlan}` }, { method: 'POST', path: '/restrictions' }, { method: 'POST', path: '/availability' }])
      assert.deepEqual(requests.map(request => request.path), ['/restrictions', '/availability'])
      for (const request of requests) {
        const dates = request.values.flatMap(value => Array.from({ length: daysBetween(value.date_from, value.date_to) + 1 }, (_, offset) => addDays(value.date_from, offset)))
        assert.deepEqual(dates, Array.from({ length: 500 }, (_, offset) => addDays(today(), offset)))
      }
      for (const value of requests[0]!.values) for (const field of ['rate', 'min_stay_arrival', 'max_stay', 'closed_to_arrival', 'closed_to_departure', 'stop_sell']) assert(Object.hasOwn(value, field), `full sync omitted ${field}`)
    }
    assertFull(fullSyncStart)
    assert.equal(channex.restrictions[addDays(today(), 20)]!.rate, '245.00')
    assert.deepEqual(await db.prepare('SELECT property_id, room_type_id, rate_plan_id, channel_id, enabled, import_stage FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), mapping)
    assert.deepEqual(channex.channel, channel)
    assert.equal(channex.messagesProperty, messages)
    assert.deepEqual(await db.prepare('SELECT operation_id, pending_step, status FROM channex_connections').first(), { operation_id: null, pending_step: null, status: 'connected' })
    // A provider pause belongs to the property. Recovery waits for it and retains the failed night's attempt count.
    limited = true
    assert.equal((await setStayNights(db, env, manager, { product_id: productId, from: addDays(today(), 21), to: addDays(today(), 22), price_minor: 25500 })).channel_push?.state, 'pending')
    const pause = await db.prepare('SELECT retry_at, detail, attempts FROM channel_night_pushes WHERE product_id = ? AND date = ?').bind(productId, addDays(today(), 21)).first<{ retry_at: string; detail: string; attempts: number }>()
    assert.equal(pause!.attempts, 1)
    limited = false
    requests.length = 0
    const pausedStart = channex.seen.length
    assert.deepEqual(await call(), { status: 200, body: { product_id: productId, channel_push: { state: 'pending', detail: pause!.detail } } })
    assert.deepEqual(requests, [])
    assert.deepEqual(channex.seen.slice(pausedStart), [{ method: 'GET', path: '/channels/chan-1' }, { method: 'GET', path: '/properties/prop-1' }, { method: 'GET', path: '/channels/chan-1/action/listing_details' }, { method: 'GET', path: `/rate_plans/${channex.ratePlan}` }])
    assert.deepEqual(await db.prepare('SELECT state, retry_at, COUNT(*) AS nights FROM channel_night_pushes WHERE product_id = ? GROUP BY state, retry_at').bind(productId).all().then(result => result.results), [{ state: 'pending', retry_at: pause!.retry_at, nights: 500 }])
    assert.equal(await db.prepare('SELECT attempts FROM channel_night_pushes WHERE product_id = ? AND date = ?').bind(productId, addDays(today(), 21)).first('attempts'), 1)
    assert.deepEqual((await readStayCalendar(db, manager, { productId, from: addDays(today(), 21), to: addDays(today(), 22) })).nights.map(night => [night.date, night.price_minor, night.channel]),
      [[addDays(today(), 21), 25500, { state: 'pending', detail: pause!.detail }]])
    // The existing delivery task completes the queued full sync, without another manual request or any mapping operation.
    await db.prepare("UPDATE channel_night_pushes SET retry_at = '2000-01-01T00:00:00.000Z' WHERE product_id = ?").bind(productId).run()
    assert.deepEqual(await deliverPendingChannelNights(db, env), { homes: 1 })
    assertFull(pausedStart)
    assert.equal(channex.restrictions[addDays(today(), 21)]!.rate, '255.00')
    assert.deepEqual(await db.prepare('SELECT state, COUNT(*) AS nights FROM channel_night_pushes WHERE product_id = ? GROUP BY state').bind(productId).all().then(result => result.results), [{ state: 'pushed', nights: 500 }])
    assert.deepEqual((await readStayCalendar(db, manager, { productId, from: addDays(today(), 20), to: addDays(today(), 22) })).nights.map(night => [night.date, night.price_minor, night.channel]),
      [[addDays(today(), 20), 24500, { state: 'pushed', detail: null }], [addDays(today(), 21), 25500, { state: 'pushed', detail: null }]])
    assert.deepEqual(await db.prepare("SELECT state, json_extract(sent_json, '$.rate') AS rate, attempts, retry_at FROM channel_night_pushes WHERE product_id = ? AND date = ?").bind(productId, addDays(today(), 21)).first(),
      { state: 'pushed', rate: '255.00', attempts: 0, retry_at: null })
    assert.deepEqual(channex.channel, channel)
    assert.equal(channex.messagesProperty, messages)
    // The first full-sync call can outlive its lease. A booking's new delivery must not be overwritten by the old second batch.
    requests.length = 0
    during = async () => {
      await db.prepare("UPDATE product_channel_mappings SET delivery_lease_until = '2000-01-01T00:00:00.000Z' WHERE product_id = ?").bind(productId).run()
      const booking = await createStay(db, env, manager, { product_id: productId, idempotency_key: 'during-full-sync', check_in_date: addDays(today(), 30), check_out_date: addDays(today(), 32), adults: 2, guest_name: 'Ana', total_minor: 37900 })
      assert.deepEqual(booking.channel_push, { state: 'pushed', detail: null })
      assert.equal(channex.availability[addDays(today(), 30)], 0)
    }
    assert.deepEqual(await call(), { status: 200, body: { product_id: productId, channel_push: { state: 'pushed', detail: null } } })
    assert.deepEqual(requests.map(request => request.path), ['/restrictions', '/restrictions', '/availability'])
    assert.equal(channex.availability[addDays(today(), 30)], 0)
    assert.equal(channex.availability[addDays(today(), 31)], 0)
    await connection.deactivate(productId)
    const stopped = await call()
    assert.equal(stopped.status, 409)
    assert.deepEqual(stopped.body.data, { code: 'CHANNEL_PROPERTY_NOT_READY' })
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a live manual full sync retains both locks beyond fifteen minutes and excludes stopping or disconnecting its listing', { timeout: 120_000 }, async (context) => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const { product_id: productId } = await connection.prepare(LISTING, form)
    await importAll(connection, db, channex, productId)
    const from = today()
    const mapping = await db.prepare('SELECT property_id, room_type_id, rate_plan_id, channel_id, enabled, import_stage FROM product_channel_mappings WHERE product_id = ?').bind(productId).first()
    const channel = structuredClone(channex.channel)
    const messages = channex.messagesProperty
    const startedAt = Date.parse(`${from}T18:00:00.000Z`)
    context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: startedAt })
    assert.equal(today(), from, 'the held request must retain the imported home’s local calendar day')
    const requests: Array<{ path: string; values: FakeBody['values'] }> = []
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (init.method === 'POST' && ['/api/v1/restrictions', '/api/v1/availability'].includes(url.pathname)) {
        requests.push({ path: url.pathname.slice('/api/v1'.length), values: (JSON.parse(String(init.body)) as FakeBody).values })
        if (requests.length === 1) {
          const held = await db.prepare('SELECT operation_id, updated_at FROM channex_connections WHERE organization_id = ?').bind(ORG).first<{ operation_id: string; updated_at: string }>()
          const delivery = await db.prepare('SELECT delivery_lease FROM product_channel_mappings WHERE product_id = ?').bind(productId).first<string>('delivery_lease')
          assert.ok(held!.operation_id)
          assert.ok(delivery)
          for (let minute = 1; minute <= 16; minute++) {
            context.mock.timers.tick(60_000)
            await context.waitFor(async () => {
              assert.deepEqual(await db.prepare('SELECT operation_id, updated_at FROM channex_connections WHERE organization_id = ?').bind(ORG).first(), {
                operation_id: held!.operation_id, updated_at: new Date(startedAt + Math.floor(minute / 5) * 300_000).toISOString(),
              })
              const renewed = await db.prepare('SELECT delivery_lease, delivery_lease_until FROM product_channel_mappings WHERE product_id = ?').bind(productId).first<{ delivery_lease: string; delivery_lease_until: string }>()
              assert.equal(renewed!.delivery_lease, delivery)
              assert(Date.parse(renewed!.delivery_lease_until) > Date.now())
            }, { timeout: 10_000 })
          }
          assert(Date.now() - Date.parse(held!.updated_at) > 15 * 60_000)
          const competing = new AirbnbConnection(db, env, ORG, OWNER)
          const before = channex.seen.length
          await assert.rejects(competing.deactivate(productId), { status: 409, data: { code: 'CONNECTION_BUSY' } })
          await assert.rejects(competing.disconnect(), { status: 409, data: { code: 'CONNECTION_BUSY' } })
          assert.deepEqual(channex.seen.slice(before), [])
          assert.deepEqual(await db.prepare('SELECT property_id, room_type_id, rate_plan_id, channel_id, enabled, import_stage FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), mapping)
          assert.deepEqual(channex.channel, channel)
          assert.equal(channex.messagesProperty, messages)
        }
      }
      return channex.fetch(input, init)
    }
    assert.deepEqual(await connection.syncFullCalendar(productId), { product_id: productId, channel_push: { state: 'pushed', detail: null } })
    assert.deepEqual(requests.map(request => request.path), ['/restrictions', '/availability'])
    for (const request of requests) assert.deepEqual(request.values.flatMap(value => Array.from({ length: daysBetween(value.date_from, value.date_to) + 1 }, (_, offset) => addDays(value.date_from, offset))), Array.from({ length: 500 }, (_, offset) => addDays(from, offset)))
    assert.deepEqual(await db.prepare('SELECT state, COUNT(*) AS nights FROM channel_night_pushes WHERE product_id = ? GROUP BY state').bind(productId).all().then(rows => rows.results), [{ state: 'pushed', nights: 500 }])
    assert.deepEqual(await db.prepare('SELECT operation_id, pending_step, status FROM channex_connections WHERE organization_id = ?').bind(ORG).first(), { operation_id: null, pending_step: null, status: 'connected' })
    assert.deepEqual(await db.prepare('SELECT delivery_lease, delivery_lease_until FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { delivery_lease: null, delivery_lease_until: null })
    assert.deepEqual(channex.channel, channel)
    assert.equal(channex.messagesProperty, messages)
  } finally {
    context.mock.timers.reset()
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a connection renewal failure during full sync prevents its second ARI call and reports its cause without manufacturing an uncertain connection write', { timeout: 120_000 }, async (context) => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const { product_id: productId } = await connection.prepare(LISTING, form)
    await importAll(connection, db, channex, productId)
    const from = today()
    context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse(`${from}T18:00:00.000Z`) })
    assert.equal(today(), from)
    await db.prepare(`CREATE TRIGGER refuse_connection_renewal BEFORE UPDATE OF updated_at ON channex_connections
      WHEN OLD.operation_id IS NOT NULL AND NEW.operation_id IS OLD.operation_id
      BEGIN SELECT RAISE(ABORT, 'Connection renewal refused'); END`).run()
    const requests: string[] = []
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (init.method === 'POST' && ['/api/v1/restrictions', '/api/v1/availability'].includes(url.pathname)) {
        requests.push(url.pathname.slice('/api/v1'.length))
        if (requests.length === 1) {
          for (let minute = 0; minute < 5; minute++) {
            context.mock.timers.tick(60_000)
            await context.waitFor(async () => {
              const until = await db.prepare('SELECT delivery_lease_until FROM product_channel_mappings WHERE product_id = ?').bind(productId).first<string>('delivery_lease_until')
              assert(Date.parse(until!) > Date.now())
            }, { timeout: 10_000 })
          }
        }
      }
      return channex.fetch(input, init)
    }
    await assert.rejects(connection.syncFullCalendar(productId), (error: unknown) => {
      assert(error instanceof HTTPError)
      assert.equal(error.status, 503)
      assert.equal(error.data?.code, 'CONNECTION_RENEWAL_FAILED')
      assert(errorChainForTelemetry(error).some(cause => cause.message.includes('Connection renewal refused')))
      return true
    })
    assert.deepEqual(requests, ['/restrictions'])
    assert.deepEqual(await db.prepare('SELECT state, COUNT(*) AS nights FROM channel_night_pushes WHERE product_id = ? GROUP BY state').bind(productId).all().then(rows => rows.results), [{ state: 'pending', nights: 500 }])
    assert.deepEqual(await db.prepare('SELECT operation_id, pending_step, status FROM channex_connections WHERE organization_id = ?').bind(ORG).first(), { operation_id: null, pending_step: null, status: 'connected' })
    assert.deepEqual(await db.prepare('SELECT delivery_lease, delivery_lease_until FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { delivery_lease: null, delivery_lease_until: null })
  } finally {
    context.mock.timers.reset()
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a renewal failure before a repeatable minimum-stay update cancels the unsent provider write', { timeout: 120_000 }, async (context) => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const { product_id: productId } = await connection.prepare(LISTING, form)
    for (const stage of ['room', 'rate', 'inventory'] as const) assert.equal((await connection.advance(productId)).stage, stage)
    const from = today()
    context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse(`${from}T18:00:00.000Z`) })
    assert.equal(today(), from)
    channex.properties[0]!.settings = { min_stay_type: 'both' }
    let reachedUpdateRead = false
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      const response = await channex.fetch(input, init)
      if (!reachedUpdateRead && (init.method ?? 'GET') === 'GET' && url.pathname === `/api/v1/properties/${channex.properties[0]!.id}`) {
        reachedUpdateRead = true
        await db.prepare(`CREATE TRIGGER refuse_pending_connection_renewal BEFORE UPDATE OF updated_at ON channex_connections
          WHEN OLD.operation_id IS NOT NULL AND NEW.operation_id IS OLD.operation_id
          BEGIN SELECT RAISE(ABORT, 'Connection renewal refused before minimum-stay update'); END`).run()
        for (let minute = 0; minute < 5; minute++) {
          context.mock.timers.tick(60_000)
          assert.equal(await db.prepare('SELECT pending_step FROM channex_connections WHERE organization_id = ?').bind(ORG).first('pending_step'), null)
        }
      }
      return response
    }
    const before = channex.seen.length
    await assert.rejects(connection.advance(productId), (error: unknown) => {
      assert(error instanceof HTTPError)
      assert.equal(error.status, 503)
      assert.equal(error.data?.code, 'CONNECTION_RENEWAL_FAILED')
      assert(errorChainForTelemetry(error).some(cause => cause.message.includes('Connection renewal refused before minimum-stay update')))
      return true
    })
    assert.equal(reachedUpdateRead, true)
    assert.deepEqual(channex.seen.slice(before).filter(request => request.method !== 'GET'), [])
    assert.deepEqual(channex.properties[0]!.settings, { min_stay_type: 'both' })
    assert.deepEqual(await db.prepare('SELECT operation_id, pending_step, status FROM channex_connections WHERE organization_id = ?').bind(ORG).first(), { operation_id: null, pending_step: null, status: 'connected' })
    assert.deepEqual(await db.prepare('SELECT delivery_lease, delivery_lease_until, enabled, import_stage FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { delivery_lease: null, delivery_lease_until: null, enabled: 0, import_stage: 'inventory' })
  } finally {
    context.mock.restoreAll()
    context.mock.timers.reset()
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
    // Airbnb failing behind Channex answers the listings with the coded error, 502, never a bare 500.
    channex.airbnbDown = true
    const unavailable = await call('GET', '/listings')
    assert.deepEqual({ status: unavailable.status, message: unavailable.body.message, data: unavailable.body.data }, {
      status: 502,
      message: 'Airbnb did not answer GET /channels/chan-1/action/listings through Channex: Unfortunately, a server error prevented your request from being completed. Airbnb may be undergoing maintenance or your connection may have timed out. Please try again.',
      data: { code: 'AIRBNB_UNAVAILABLE', field: 'provider_response', uncertain: false, provider_status: 422 },
    })
    channex.airbnbDown = false
    const listedBefore = await call('GET', '/listings')
    assert.deepEqual((listedBefore.body.listings as Array<{ import: unknown }>)[0]!.import, { status: 'imported', product_id: productId, stage: 'complete', syncing: true, content: null })

    channex.content = true
    const filled = await call('POST', `/imports/${productId}/content`)
    assert.equal(filled.status, 200)
    assert.deepEqual(filled.body, { product_id: productId, stage: 'complete', channel_push: { state: 'pushed', detail: null }, content: {
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
    // A legacy mapping without an explicit minimum hash cannot authorize source replacement of the canonical default.
    await db.prepare("UPDATE product_channel_mappings SET import_written = json_remove(import_written, '$.min_nights') WHERE product_id = ?").bind(productId).run()
    channex.availabilityRules.default_min_nights = 7
    const protectedMinimum = await call('POST', `/imports/${productId}/content`)
    assert.equal(protectedMinimum.status, 200)
    assert.equal((await readStayHome(db, manager, productId)).min_nights, 5)
    assert((protectedMinimum.body.content as ImportContentReport).kept_host_edits.includes('min_nights'))

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
    // As the iPhone app calls: a bearer session and no browser origin. Queuing
    // does not need the HTTP execution context; only the cron advances jobs.
    const call = async (method: string, body?: unknown) => {
      const response = await app.request(Object.assign(new Request(`${BASE}/api/organizations/${ORG}/integrations/airbnb/sync`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }),
        { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    const runCron = () => runAirbnbSyncJobs(env, Date.now() + 60_000)
    // The cron task's run: as many as it takes, each a slice of its own.
    const cron = async () => { for (let run = 0; run < 6; run++) await runAirbnbSyncJobs(env, Date.now() + 60_000) }
    const job = () => db.prepare('SELECT action, state, product_id, last_error_code, attempts FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first<Record<string, unknown>>()

    // Airbnb sync is Business: on Basic the request is refused before anything is queued, and nothing reaches Channex.
    await db.prepare("UPDATE subscription SET status = 'canceled' WHERE id = 'sub-boot'").run()
    const writesBefore = channex.seen.filter(request => request.method !== 'GET').length
    const refused = await call('POST', { sync: [{ listing_id: LISTING }] })
    assert.equal(refused.status, 403)
    assert.deepEqual((refused.body as { data: Record<string, unknown> }).data, { code: 'ENTITLEMENT_REQUIRED', entitlement: 'channel_sync' })
    assert.match(JSON.stringify(refused.body), /Airbnb sync comes with the Business plan/)
    assert.equal(await job(), null)
    assert.equal(channex.seen.filter(request => request.method !== 'GET').length, writesBefore)

    // On Business it stays queued until the cron runs. The organization has no contact email or phone and the
    // request names none: the listing fails with the field, and nothing is made.
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status, seats, periodEnd) VALUES ('sub-org', 'business', ?, 'active', 1, ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86_400).run()
    const queued = await call('POST', { sync: [{ listing_id: LISTING }] })
    assert.equal(queued.status, 202)
    assert.deepEqual((queued.body.listings as Array<Record<string, unknown>>).map(listing => [listing.listing_id, listing.action, listing.status]), [[LISTING, 'sync', 'queued']])
    assert.deepEqual(await job(), { action: 'sync', state: 'pending', product_id: null, last_error_code: null, attempts: 0 })
    assert.equal(channex.seen.filter(request => request.method !== 'GET').length, writesBefore, 'HTTP only queues the change')
    await runCron()
    assert.deepEqual(await job(), { action: 'sync', state: 'failed', product_id: null, last_error_code: 'MISSING_DETAIL', attempts: 1 })
    const failedRow = ((await call('GET')).body.listings as Array<{ status: string; error: { code: string } }>)[0]!
    assert.deepEqual([failedRow.status, failedRow.error.code], ['failed', 'MISSING_DETAIL'])
    assert.equal(await count(db, 'product_channel_mappings'), 0)

    // Airbnb failing behind Channex when the job runs is retried on its own, with its code, rather than failing the listing.
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING, details: form.missingDetails }] })).status, 202)
    channex.airbnbDown = true
    await runAirbnbSyncJobs(env, Date.now() + 60_000)
    assert.deepEqual(await db.prepare('SELECT state, attempts, last_error_code FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first(), { state: 'error', attempts: 1, last_error_code: 'AIRBNB_UNAVAILABLE' })
    channex.airbnbDown = false

    // With the missing contact in the request's details, asked again, the same listing imports, a few photos per step, and goes live.
    channex.extraPhotos = 8
    const propertyCreatesBefore = channex.seen.filter(request => request.method === 'POST' && request.path === '/properties').length
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING, details: form.missingDetails }] })).status, 202)
    const queuedId = await db.prepare('SELECT id FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first('id')
    const yielded = { state: 'pending', attempts: 0, lease_token: null, lease_until: null, last_error_code: null }
    assert.deepEqual(await db.prepare('SELECT state, attempts, lease_token, lease_until, last_error_code FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first(), yielded)
    assert.equal(await count(db, 'product_channel_mappings'), 0)
    assert.equal(channex.seen.filter(request => request.method === 'POST' && request.path === '/properties').length, propertyCreatesBefore, 'HTTP does not begin the import')
    // A cron invocation inside its 30-second launch reserve does not start this step.
    assert.deepEqual(await runAirbnbSyncJobs(env, Date.now() + 29_000), { stepped: 0, done: 0, failed: 0 })
    assert.deepEqual(await db.prepare('SELECT state, attempts, lease_token, lease_until, last_error_code FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first(), yielded)
    assert.equal(channex.seen.filter(request => request.method === 'POST' && request.path === '/properties').length, propertyCreatesBefore)
    // The first provider step consumes the cron's launch window. Its completed
    // stage is retained without an attempt or failure when the cron yields.
    const clock = Date.now
    let elapsed = 0
    Date.now = () => clock() + elapsed
    globalThis.fetch = async (input, init) => {
      const response = await channex.fetch(input, init)
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.pathname.endsWith('/action/listing_details')) elapsed = 30_000
      return response
    }
    try {
      assert.deepEqual(await runAirbnbSyncJobs(env, clock() + 60_000), { stepped: 1, done: 0, failed: 0 })
    } finally {
      Date.now = clock
      globalThis.fetch = channex.fetch as typeof fetch
    }
    assert.deepEqual(await db.prepare('SELECT state, attempts, lease_token, lease_until, last_error_code FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first(), yielded)
    assert.equal(await db.prepare('SELECT import_stage FROM product_channel_mappings').first('import_stage'), 'property')
    assert.equal(channex.seen.filter(request => request.method === 'POST' && request.path === '/properties').length, propertyCreatesBefore, 'cron yields before launching another provider step')
    await cron()
    assert.equal(await db.prepare('SELECT id FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first('id'), queuedId, 'cron resumes the same yielded request generation')
    const done = await job()
    assert.deepEqual({ ...done, product_id: null }, { action: 'sync', state: 'done', product_id: null, last_error_code: null, attempts: 0 })
    const productId = done!.product_id as string
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { import_stage: 'complete', enabled: 1 })
    assert.deepEqual(((await call('GET')).body.listings as Array<Record<string, unknown>>).map(listing => [listing.product_id, listing.action, listing.status, listing.stage, listing.error]), [[productId, 'sync', 'done', 'complete', null]])
    assert.equal(channex.photoFetches, 11)
    assert.equal((await readStayHome(db, manager, productId)).photos.length, 11)
    assert.equal(await countActiveHomes(db, ORG), 3)
    assert.equal(channex.channel.ratePlans.length, 1)

    // A requested resync reads Airbnb's actual global default, then corrects the unchanged imported canonical value.
    channex.availabilityRules.default_min_nights = 7
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    const unchangedCalendarStart = channex.seen.length
    await runCron()
    assert.deepEqual(await job(), { action: 'sync', state: 'done', product_id: productId, last_error_code: null, attempts: 0 })
    assert.equal((await readStayHome(db, manager, productId)).min_nights, 7)
    assert.equal(channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival, 7)
    assert.deepEqual(channex.seen.slice(unchangedCalendarStart).filter(request => request.method === 'POST' && ['/restrictions', '/availability'].includes(request.path)), [], 'a refresh does not replay an already confirmed calendar')
    // A completed-home sync retains the refresh's pending delivery instead of reporting done or forcing another full sync.
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (init.method === 'POST' && url.pathname === '/api/v1/restrictions') return new Response('Pause this property', { status: 429 })
      return channex.fetch(input, init)
    }
    const queuedNight = await setStayNights(db, env, manager, { product_id: productId, from: addDays(today(), 20), to: addDays(today(), 21), price_minor: 25000 })
    assert.equal(queuedNight.channel_push?.state, 'pending')
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    assert.deepEqual(await runCron(), { stepped: 1, done: 0, failed: 0 })
    assert.deepEqual(await job(), { action: 'sync', state: 'pending', product_id: productId, last_error_code: null, attempts: 0 })
    const waitingRefresh = await new AirbnbConnection(db, env, ORG, OWNER).refreshContent(productId)
    assert.deepEqual(waitingRefresh.channel_push, queuedNight.channel_push)
    assert.equal(await db.prepare('SELECT completed_at FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first('completed_at'), null)
    globalThis.fetch = channex.fetch as typeof fetch
    await db.prepare("UPDATE channel_night_pushes SET retry_at = '2000-01-01T00:00:00.000Z' WHERE product_id = ? AND state = 'pending'").bind(productId).run()
    await db.prepare("UPDATE airbnb_sync_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE listing_id = ?").bind(LISTING).run()
    const confirmedRefreshStart = channex.seen.length
    assert.deepEqual(await runCron(), { stepped: 1, done: 1, failed: 0 })
    assert.deepEqual(await job(), { action: 'sync', state: 'done', product_id: productId, last_error_code: null, attempts: 0 })
    assert.deepEqual(channex.seen.slice(confirmedRefreshStart).filter(request => request.method === 'POST' && ['/restrictions', '/availability'].includes(request.path)), [{ method: 'POST', path: '/restrictions' }])
    assert.deepEqual((await readStayCalendar(db, manager, { productId, from: addDays(today(), 20), to: addDays(today(), 21) })).nights.map(night => [night.price_minor, night.channel]), [[25000, { state: 'pushed', detail: null }]])
    // An authored canonical change survives the next source refresh and the full sync restores Airbnb to it.
    await updateStayHome(env, db, manager, productId, { min_nights: 9, description: 'Host words stay.' })
    channex.availabilityRules.default_min_nights = 11
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    await runCron()
    assert.deepEqual(await job(), { action: 'sync', state: 'done', product_id: productId, last_error_code: null, attempts: 0 })
    const protectedHome = await readStayHome(db, manager, productId)
    assert.deepEqual([protectedHome.min_nights, protectedHome.description, channex.availabilityRules.default_min_nights], [9, 'Host words stay.', 9])
    assert((JSON.parse(String(await db.prepare('SELECT import_content FROM product_channel_mappings WHERE product_id = ?').bind(productId).first('import_content'))) as ImportContentReport).kept_host_edits.includes('min_nights'))
    // A missing upstream default fails visibly and cannot publish an inferred calendar default.
    channex.availabilityRules.default_min_nights = null
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    const failedRefreshStart = channex.seen.length
    await runCron()
    assert.deepEqual(await job(), { action: 'sync', state: 'error', product_id: productId, last_error_code: 'INVALID_PROVIDER_RESPONSE', attempts: 1 })
    assert.deepEqual(channex.seen.slice(failedRefreshStart).filter(request => request.method !== 'GET'), [])
    assert.equal((await readStayHome(db, manager, productId)).min_nights, 9)
    channex.availabilityRules.default_min_nights = 9

    // Unchecked: the job stops it, and it is a free draft again.
    const stopped = await call('POST', { stop: [productId] })
    assert.deepEqual([stopped.status, (stopped.body.listings as Array<Record<string, unknown>>)[0]!.action], [202, 'stop'])
    await runCron()
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
    await runCron()
    assert.deepEqual(await job(), { action: 'sync', state: 'error', product_id: productId, last_error_code: 'CHANNEX_REQUEST_FAILED', attempts: 1 })
    const retrying = ((await call('GET')).body.listings as Array<Record<string, unknown>>)[0]!
    assert.deepEqual([retrying.status, retrying.stage, retrying.attempts, typeof retrying.next_attempt_at, (retrying.error as { code: string }).code], ['running', 'messages', 1, 'string', 'CHANNEX_REQUEST_FAILED'])
    channex.failMessages = false
    await db.prepare("UPDATE airbnb_sync_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE listing_id = ?").bind(LISTING).run()
    await cron()
    assert.deepEqual(await job(), { action: 'sync', state: 'done', product_id: productId, last_error_code: null, attempts: 1 })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { import_stage: 'complete', enabled: 1 })
    assert.equal(((await call('GET')).body.listings as Array<Record<string, unknown>>)[0]!.next_attempt_at, null)

    // Growth ends: Stripe deletes the subscription and Better Auth marks it canceled. On Basic, the newest live homes
    // past the one it includes, the Airbnb one among them, go back to drafts: KrabiClaw queues its stop itself, and the task runs it.
    await db.prepare("UPDATE organization SET stripeCustomerId = 'cus_org' WHERE id = ?").bind(ORG).run()
    await db.prepare("UPDATE subscription SET status = 'canceled' WHERE id = 'sub-org'").run()
    await returnExtrasToDraftsForPlanEnd(env, db, { type: 'customer.subscription.deleted', data: { object: { id: 'sub-org', customer: 'cus_org', status: 'canceled' } } } as unknown as Stripe.Event)
    assert.deepEqual(await db.prepare('SELECT action, state, requested_by FROM airbnb_sync_jobs WHERE listing_id = ?').bind(LISTING).first(), { action: 'stop', state: 'pending', requested_by: null })
    await runCron()
    assert.deepEqual(await job(), { action: 'stop', state: 'done', product_id: productId, last_error_code: null, attempts: 0 })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings WHERE product_id = ?').bind(productId).first(), { import_stage: 'draft', enabled: 0 })
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
    await runCron()
    assert.deepEqual(await job(), { action: 'sync', state: 'failed', product_id: productId, last_error_code: 'FORBIDDEN', attempts: 1 })
    assert.deepEqual(channex.seen.slice(refusedAccessStart), [])
    await db.prepare("UPDATE member SET role = 'owner' WHERE userId = ? AND organizationId = ?").bind(OWNER, ORG).run()
    assert.equal((await call('POST', { sync: [{ listing_id: LISTING }] })).status, 202)
    await db.prepare('DELETE FROM member WHERE userId = ? AND organizationId = ?').bind(OWNER, ORG).run()
    const removedAccessStart = channex.seen.length
    await runCron()
    assert.deepEqual(await job(), { action: 'sync', state: 'failed', product_id: productId, last_error_code: 'REQUESTER_REMOVED', attempts: 1 })
    assert.deepEqual(channex.seen.slice(removedAccessStart), [])

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
    assert.deepEqual(await runAirbnbSyncJobs(env, Date.now() + 1_000, { startReserveMs: 0 }), { stepped: 0, done: 0, failed: 0 })
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
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 1_000, { startReserveMs: 0 })).failed, 1)
    assert.deepEqual(await job(), { state: 'error', last_error_code: 'SYNC_SLICE_ENDED', attempts: 1, lease_token: null, lease_until: null })
    assert.deepEqual(await db.prepare('SELECT status, operation_id, pending_step FROM channex_connections').first(), { status: 'connected', operation_id: null, pending_step: null })

    globalThis.fetch = channex.fetch as typeof fetch
    for (let step = 0; step < 6; step++) { if ((await connection.advance(prepared.product_id)).stage === 'content') break }
    assert.equal(await db.prepare('SELECT import_stage FROM product_channel_mappings').first('import_stage'), 'content')
    await requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: LISTING }] })
    stalled(url => url.origin === CDN, true)
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 1_000, { startReserveMs: 0 })).failed, 1)
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
    // Syncing again sends the calendar ahead first (the stop forgot what Channex had), then maps the listing.
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 5_000, { startReserveMs: 0 })).failed, 1)
    assert.deepEqual(await job(), { state: 'failed', last_error_code: 'SYNC_SLICE_ENDED', attempts: 1, lease_token: null, lease_until: null })
    assert.equal(await db.prepare('SELECT status FROM channex_connections').first('status'), 'needs_review')
    assert.equal(await db.prepare('SELECT pending_step FROM channex_connections').first('pending_step'), 'map_airbnb_listing')
    assert.deepEqual(await runAirbnbSyncJobs(env, Date.now() + 1_000, { startReserveMs: 0 }), { stepped: 0, done: 0, failed: 0 })
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
    await db.prepare("DELETE FROM subscription WHERE id = 'sub-boot'").run()
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, stripeCustomerId, stripeSubscriptionId, status, seats, periodEnd) VALUES ('sub-paid', 'business', ?, 'cus_paid_host', 'sub-paid', 'active', 1, ?)").bind(ORG, Math.floor(Date.now() / 1000) + 86_400).run()
    let stalled = true
    let refused = false
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
      if (refused) return Response.json({ error: { type: 'invalid_request_error', message: 'Meter refused' } }, { status: 400 })
      const data = new URLSearchParams(String(init.body))
      receipts.push({ event: data.get('event_name')!, customer: data.get('payload[stripe_customer_id]')!, value: data.get('payload[value]')! })
      return new Response(JSON.stringify({ object: 'billing.meter_event', identifier: `meter-${requests}`, event_name: data.get('event_name'), created: Math.floor(Date.now() / 1000), livemode: false }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': `req-${requests}` } })
    }
    const job = () => db.prepare('SELECT state, last_error_code, attempts, lease_token, lease_until FROM airbnb_sync_jobs').first()
    const retry = async () => { await db.prepare("UPDATE airbnb_sync_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run() }
    await requestAirbnbSync(env, db, ORG, OWNER, { sync: [{ listing_id: LISTING }] })
    // The slice covers the mapping stage's calendar check and the activation; the stalled meter report ends it.
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 10_000, { startReserveMs: 0 })).failed, 1)
    assert.deepEqual(await job(), { state: 'error', last_error_code: 'SYNC_SLICE_ENDED', attempts: 1, lease_token: null, lease_until: null })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings').first(), { import_stage: 'reservations', enabled: 1 })
    assert.equal(requests, 1, 'the SDK does not retry beyond the operation deadline')
    await retry()
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 10_000, { startReserveMs: 0 })).failed, 1)
    assert.deepEqual(await job(), { state: 'error', last_error_code: 'SYNC_SLICE_ENDED', attempts: 2, lease_token: null, lease_until: null })
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings').first(), { import_stage: 'complete', enabled: 1 })
    assert.equal(requests, 2)
    const providerStart = channex.seen.length
    stalled = false
    await retry()
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 60_000)).done, 1)
    assert.deepEqual(await job(), { state: 'done', last_error_code: null, attempts: 2, lease_token: null, lease_until: null })
    assert.deepEqual(receipts, [{ event: 'krabiclaw_homes', customer: 'cus_paid_host', value: '1' }])
    assert.deepEqual(channex.seen.slice(providerStart).filter(entry => entry.method !== 'GET'), [], 'billing recovery does not repeat confirmed calendar or content writes')
    assert.equal((await readStayHome(db, manager, prepared.product_id)).live, true)

    // A native Stripe refusal stays permanent after the committed-state formatter.
    refused = true
    await requestAirbnbSync(env, db, ORG, OWNER, { stop: [prepared.product_id] })
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 60_000)).failed, 1)
    assert.deepEqual(await job(), { state: 'failed', last_error_code: 'SYNC_STEP_FAILED', attempts: 1, lease_token: null, lease_until: null })
    assert.match((await db.prepare('SELECT last_error FROM airbnb_sync_jobs').first<string>('last_error'))!, /changes were saved.*Meter refused/)
    assert.deepEqual(await db.prepare('SELECT import_stage, enabled FROM product_channel_mappings').first(), { import_stage: 'draft', enabled: 0 })
    assert.equal((await readStayHome(db, manager, prepared.product_id)).live, false)
    const refusedRequests = requests
    const stoppedWrites = channex.seen.filter(entry => entry.method !== 'GET').length
    assert.deepEqual(await runAirbnbSyncJobs(env, Date.now() + 60_000), { stepped: 0, done: 0, failed: 0 })
    assert.equal(requests, refusedRequests, 'a permanent refusal is not automatically retried')
    refused = false
    await requestAirbnbSync(env, db, ORG, OWNER, { stop: [prepared.product_id] })
    assert.equal((await runAirbnbSyncJobs(env, Date.now() + 60_000)).done, 1)
    assert.deepEqual(await job(), { state: 'done', last_error_code: null, attempts: 0, lease_token: null, lease_until: null })
    assert.deepEqual(receipts.slice(1), [{ event: 'krabiclaw_homes', customer: 'cus_paid_host', value: '0' }])
    assert.equal(channex.seen.filter(entry => entry.method !== 'GET').length, stoppedWrites)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

for (const authored of [false, true]) {
  test(`receipt resume keeps source inheritance and true exceptions ${authored ? 'after a host edit' : 'without a host edit'}`, { timeout: 120_000 }, async () => {
    const { runtime, db, env } = await boot()
    const channex = new FakeChannex()
    channex.availabilityRules.default_min_nights = 2
    channex.calendarMinimum = () => 2
    const realFetch = globalThis.fetch
    globalThis.fetch = channex.fetch as typeof fetch
    try {
      const connection = await connected(db, env, channex)
      await db.prepare(`CREATE TRIGGER refuse_resume_mapping BEFORE INSERT ON product_channel_mappings BEGIN SELECT RAISE(ABORT, 'Receipt mapping refused'); END`).run()
      await assert.rejects(connection.prepare(LISTING, form), /Receipt mapping refused/)
      const productId = await db.prepare('SELECT id FROM products').first<string>('id')
      assert.ok(productId)
      if (authored) await updateStayHome(env, db, manager, productId, { min_nights: 9, base_price_minor: 20000 })
      await db.prepare('DROP TRIGGER refuse_resume_mapping').run()
      const explicit = addDays(today(), 1)
      const inherited = addDays(today(), 2)
      channex.availabilityRules.default_min_nights = 5
      channex.calendarMinimum = date => date === explicit ? 2 : 5
      channex.calendarRate = date => date === explicit ? 189.5 : 100
      globalThis.fetch = async (input, init = {}) => {
        const response = await channex.fetch(input, init)
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
        if (url.pathname.endsWith('/action/listing_details')) {
          const body = await response.json() as { data: { listing: { pricing_settings: { default_daily_price: number } } } }
          body.data.listing.pricing_settings.default_daily_price = 100
          return Response.json(body)
        }
        return response
      }
      assert.equal((await connection.prepare(LISTING, form)).product_id, productId)
      const home = await readStayHome(db, manager, productId)
      assert.deepEqual([home.min_nights, home.base_price_minor], authored ? [9, 20000] : [2, 18950])
      assert.deepEqual((await db.prepare('SELECT date, min_stay_arrival, price_minor FROM product_nights WHERE product_id = ? AND date IN (?, ?) ORDER BY date').bind(productId, explicit, inherited).all()).results,
        [{ date: explicit, min_stay_arrival: 2, price_minor: 18950 }, { date: inherited, min_stay_arrival: null, price_minor: null }])
      await updateStayHome(env, db, manager, productId, { min_nights: 11, base_price_minor: 23000 })
      const calendar = await readStayCalendar(db, manager, { productId, from: explicit, to: addDays(inherited, 1) })
      assert.deepEqual(calendar.nights.map(night => [night.date, night.min_stay_arrival, night.price_minor]), [[explicit, 2, 18950], [inherited, 11, 23000]])
    } finally {
      globalThis.fetch = realFetch
      await runtime.dispose()
    }
  })
}

test('a source-owned legacy default becomes inheritance after a refused canonical-default push', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const explicit = addDays(today(), 1)
  const inherited = addDays(today(), 2)
  channex.calendarMinimum = date => date === explicit ? 2 : 5
  const realFetch = globalThis.fetch
  globalThis.fetch = channex.fetch as typeof fetch
  try {
    const connection = await connected(db, env, channex)
    const productId = (await connection.prepare(LISTING, form)).product_id
    await importAll(connection, db, channex, productId)
    // A pre-v23 source import materialized each resolved default instead of recording inheritance.
    await db.prepare("UPDATE product_nights SET min_stay_arrival = COALESCE(min_stay_arrival, 5), price_minor = COALESCE(price_minor, 18950) WHERE product_id = ? AND source = 'import'").bind(productId).run()
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (init.method === 'PUT' && url.pathname.endsWith('/availability_settings')) return new Response('Default refused', { status: 400 })
      return channex.fetch(input, init)
    }
    await assert.rejects(updateStayHome(env, db, manager, productId, { min_nights: 9, base_price_minor: 20000 }), (error: unknown) => {
      assert(error instanceof HTTPError)
      assert.deepEqual([error.status, error.data?.code, error.data?.committed], [503, 'CHANNEL_PUSH_FAILED', true])
      return true
    })
    assert.deepEqual([(await readStayHome(db, manager, productId)).min_nights, channex.availabilityRules.default_min_nights], [9, 5])
    globalThis.fetch = channex.fetch as typeof fetch
    const refreshed = await connection.refreshContent(productId)
    assert(refreshed.content.kept_host_edits.includes('min_nights'))
    assert.deepEqual((await db.prepare('SELECT date, min_stay_arrival, price_minor FROM product_nights WHERE product_id = ? AND date IN (?, ?) ORDER BY date').bind(productId, explicit, inherited).all()).results,
      [{ date: explicit, min_stay_arrival: 2, price_minor: null }, { date: inherited, min_stay_arrival: null, price_minor: null }])
    const calendar = await readStayCalendar(db, manager, { productId, from: explicit, to: addDays(inherited, 1) })
    assert.deepEqual(calendar.nights.map(night => [night.date, night.min_stay_arrival, night.price_minor]), [[explicit, 2, 20000], [inherited, 9, 20000]])
    const source = await listingCalendar(env, channex.channelId, LISTING, TZ)
    assert.deepEqual(source.filter(night => [explicit, inherited].includes(night.date)).map(night => [night.date, night.minStay, night.rate]), [[explicit, 2, '200'], [inherited, 9, '200']])
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

for (const target of ['rolling default', 'listing minimum'] as const) {
  for (const outcome of ['refused', 'refused with failed completion', 'uncertain'] as const) {
    test(`a content refresh preserves ${outcome} ${target} write provenance through completion`, { timeout: 120_000 }, async () => {
      const { runtime, db, env } = await boot()
      const channex = new FakeChannex()
      const realFetch = globalThis.fetch
      globalThis.fetch = channex.fetch as typeof fetch
      try {
        const connection = await connected(db, env, channex)
        const productId = (await connection.prepare(LISTING, form)).product_id
        await importAll(connection, db, channex, productId)
        const canonicalMinimum = target === 'listing minimum' ? 7 : 5
        if (target === 'listing minimum') {
          await updateStayHome(env, db, manager, productId, { min_nights: canonicalMinimum })
          channex.availabilityRules.default_min_nights = 1
        } else channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival = 1
        if (outcome === 'refused with failed completion') await db.prepare(`CREATE TRIGGER refuse_refresh_report BEFORE UPDATE OF import_content ON product_channel_mappings BEGIN SELECT RAISE(ABORT, 'Refresh report refused'); END`).run()
        let failWrite = true
        let attempts = 0
        globalThis.fetch = async (input, init = {}) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
          const targeted = target === 'listing minimum' ? url.pathname.endsWith('/availability_settings') : url.pathname === `/api/v1/rate_plans/${channex.ratePlan}`
          if (init.method === 'PUT' && targeted) {
            attempts++
            if (failWrite) {
              if (outcome === 'uncertain') await channex.fetch(input, init)
              return new Response(outcome === 'uncertain' ? 'Acknowledgement lost' : 'Default refused', { status: outcome === 'uncertain' ? 503 : 400 })
            }
          }
          return channex.fetch(input, init)
        }
        if (target === 'listing minimum' && outcome === 'refused') {
          // An unreadable required control fails before a write intent exists, and never fabricates a policy.
          const notice = channex.availabilityRules.booking_lead_time
          channex.availabilityRules.booking_lead_time = null
          await assert.rejects(connection.refreshContent(productId), (error: unknown) => {
            assert(error instanceof HTTPError)
            assert.deepEqual([error.status, error.data?.code, error.data?.committed], [503, 'CHANNEL_PUSH_FAILED', true])
            assert.match(String(error.data?.reason), /missing booking_lead_time/)
            return true
          })
          assert.equal(attempts, 0)
          assert.deepEqual(await db.prepare('SELECT status, pending_step, operation_id FROM channex_connections').first(), { status: 'connected', pending_step: null, operation_id: null })
          channex.availabilityRules.booking_lead_time = notice
        }
        await assert.rejects(connection.refreshContent(productId), (error: unknown) => {
          assert(error instanceof HTTPError)
          assert.deepEqual([error.status, error.data?.code, error.data?.committed], [503, 'CHANNEL_PUSH_FAILED', true])
          assert(error.cause && typeof error.cause === 'object')
          const wrapped = Reflect.get(error.cause, 'cause')
          const source = wrapped instanceof AggregateError ? wrapped.errors[0] : wrapped
          assert(source instanceof ChannexError)
          assert.equal(source.writeRefused, outcome !== 'uncertain')
          assert.equal(source.uncertain, outcome === 'uncertain')
          if (outcome === 'refused with failed completion') {
            assert(wrapped instanceof AggregateError)
            assert.equal(wrapped.errors.length, 2)
            assert.match(error.message, /Failed query: UPDATE product_channel_mappings SET import_content/)
            assert(errorChainForTelemetry(wrapped.errors[1]).some(cause => cause.message.includes('Refresh report refused')))
          }
          return true
        })
        assert.equal(attempts, 1)
        const state = await db.prepare('SELECT status, pending_step, operation_id FROM channex_connections').first<{ status: string; pending_step: string | null; operation_id: string | null }>()
        const currentMinimum = target === 'listing minimum' ? await listingMinimumNights(env, channex.channelId, LISTING) : channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival
        if (outcome === 'uncertain') {
          assert.deepEqual(state, { status: 'connected', pending_step: null, operation_id: null })
          assert.equal(currentMinimum, canonicalMinimum, 'the unconfirmed mutation actually applied')
          assert.ok((await connection.listings()).some(listing => listing.id === LISTING))
          assert.equal((await connection.details(LISTING)).minimumNights, channex.availabilityRules.default_min_nights)
          failWrite = false
          assert.equal((await connection.refreshContent(productId)).stage, 'complete')
          assert.equal(attempts, 1, 'readback recognizes the applied update without repeating it')
        } else {
          assert.deepEqual(state, { status: 'connected', pending_step: null, operation_id: null })
          assert.equal(currentMinimum, 1, 'the refused mutation did not apply')
          if (outcome === 'refused with failed completion') await db.prepare('DROP TRIGGER refuse_refresh_report').run()
          failWrite = false
          assert.equal((await connection.refreshContent(productId)).stage, 'complete')
          assert.equal(attempts, 2)
          const readback = await fetch(`${env.CHANNEX_BASE_URL}/rate_plans/${channex.ratePlan}`).then(response => response.json()) as { data: { attributes: { min_stay_arrival: number } } }
          assert.equal(readback.data.attributes.min_stay_arrival, canonicalMinimum)
          if (target === 'listing minimum') assert.equal(await listingMinimumNights(env, channex.channelId, LISTING), canonicalMinimum)
          assert.deepEqual(await db.prepare('SELECT status, pending_step, operation_id FROM channex_connections').first(), { status: 'connected', pending_step: null, operation_id: null })
          if (target === 'rolling default' && outcome === 'refused') {
            // The home update can commit before its dependent channel work fails.
            // Its source ownership must commit with it, so a later source change
            // still updates that field while preserving an actual host edit.
            await updateStayHome(env, db, manager, productId, { description: 'The host keeps these words.' })
            channex.availabilityRules.default_min_nights = 7
            channex.booking.check_in_time_start = '17'
            channex.booking.guest_controls = { ...(channex.booking.guest_controls as Record<string, unknown>), allows_events_as_host: true }
            failWrite = true
            await assert.rejects(connection.refreshContent(productId), (error: unknown) => error instanceof HTTPError && error.status === 503 && error.data?.code === 'CHANNEL_PUSH_FAILED' && error.data.committed === true)
            const committed = await readStayHome(db, manager, productId)
            assert.deepEqual([committed.min_nights, committed.check_in_time, committed.description], [7, '17:00', 'The host keeps these words.'])
            assert.equal((await getProduct(db, 'org', productId)).details.events_allowed, false, 'the later details write did not run')
            failWrite = false
            channex.availabilityRules.default_min_nights = 8
            channex.booking.check_in_time_start = '18'
            const retried = await connection.refreshContent(productId)
            const updated = await readStayHome(db, manager, productId)
            assert.deepEqual([updated.min_nights, updated.check_in_time, updated.description], [8, '18:00', 'The host keeps these words.'])
            assert.equal((await getProduct(db, 'org', productId)).details.events_allowed, true, 'uncommitted details were not fingerprinted as already imported')
            assert(retried.content.kept_host_edits.includes('description'))

            // A failure in the outer delivery still runs its completion callback.
            channex.ratePlans.get(channex.ratePlan)!.min_stay_arrival = 1
            channex.booking.check_in_time_start = '19'
            failWrite = true
            await assert.rejects(connection.refreshContent(productId), (error: unknown) => error instanceof HTTPError && error.status === 503 && error.data?.code === 'CHANNEL_PUSH_FAILED' && error.data.committed === true)
            assert.equal((await readStayHome(db, manager, productId)).check_in_time, '19:00')
            failWrite = false
            channex.booking.check_in_time_start = '20'
            await connection.refreshContent(productId)
            assert.equal((await readStayHome(db, manager, productId)).check_in_time, '20:00')
          }
        }
      } finally {
        globalThis.fetch = realFetch
        await runtime.dispose()
      }
    })
  }
}

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
    assert.deepEqual(await runAirbnbSyncJobs(env, Date.now() + 1_000, { startReserveMs: 0 }), { stepped: 0, done: 0, failed: 0 })
    assert.equal(mappings, 1)
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

test('a full sync Channex took without naming its task is logged as failed and the import waits for the outbox to confirm it', { timeout: 120_000 }, async () => {
  const { runtime, db, env } = await boot()
  const channex = new FakeChannex()
  const realFetch = globalThis.fetch
  let unnamed = true
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    const answer = await channex.fetch(input, init)
    return unnamed && init.method === 'POST' && url.pathname === '/api/v1/restrictions' ? Response.json({ data: [], meta: { message: 'Success', warnings: [] } }) : answer
  }
  try {
    const connection = await connected(db, env, channex)
    const { product_id: productId } = await connection.prepare(LISTING, form)
    let result: { stage: string; waiting: boolean } | undefined
    for (let step = 0; step < 6 && !result?.waiting; step++) {
      await track(db, channex, productId)
      result = await connection.advance(productId)
    }
    // The full sync goes through the delivery outbox: an unconfirmed call pauses the property, the nights stay pending, the stage is asked again.
    assert.deepEqual(result, { product_id: productId, stage: 'inventory', waiting: true, content: null })
    assert.deepEqual(await db.prepare("SELECT kind, status, task_id FROM channel_sync_log WHERE direction = 'outbound' AND product_id = ?").bind(productId).all().then(rows => rows.results),
      [{ kind: 'restrictions', status: 'failed', task_id: null }])
    const pending = await db.prepare("SELECT state, COUNT(*) AS nights, MIN(detail) AS detail FROM channel_night_pushes WHERE product_id = ? GROUP BY state").bind(productId).all().then(rows => rows.results)
    assert.equal(pending.length, 1)
    assert.partialDeepStrictEqual(pending[0], { state: 'pending', nights: 500 })
    assert.match(String(pending[0]!.detail), /Channex did not confirm the restrictions update .* Attempt 1; sending again at/)
    assert.deepEqual(await db.prepare('SELECT status, pending_step FROM channex_connections').first(), { status: 'connected', pending_step: null })
    // Asked again before the retry time, the stage sends nothing and the nights wait on.
    unnamed = false
    const calls = channex.seen.length
    await track(db, channex, productId)
    assert.deepEqual(await connection.advance(productId), { product_id: productId, stage: 'inventory', waiting: true, content: null })
    assert.deepEqual(channex.seen.slice(calls).filter(request => request.method === 'POST'), [])
    assert.deepEqual(await db.prepare("SELECT state, COUNT(*) AS nights, MIN(attempts) AS attempts FROM channel_night_pushes WHERE product_id = ? GROUP BY state").bind(productId).all().then(rows => rows.results), [{ state: 'pending', nights: 500, attempts: 1 }])
    // Channex naming its task on the retry lets the import on: one restrictions and one availability call, both confirmed.
    await db.prepare("UPDATE channel_night_pushes SET retry_at = '2000-01-01T00:00:00.000Z' WHERE product_id = ?").bind(productId).run()
    await track(db, channex, productId)
    assert.deepEqual(await connection.advance(productId), { product_id: productId, stage: 'verify_inventory', waiting: false, content: null })
    assert.deepEqual(await db.prepare("SELECT kind, status, task_id FROM channel_sync_log WHERE direction = 'outbound' AND product_id = ? ORDER BY created_at, rowid").bind(productId).all().then(rows => rows.results),
      [{ kind: 'restrictions', status: 'failed', task_id: null }, { kind: 'restrictions', status: 'pushed', task_id: 'task-restrictions' }, { kind: 'availability', status: 'pushed', task_id: 'task-availability' }])
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
    assert.equal(typeof await db.prepare('SELECT operation_id FROM channex_connections').first('operation_id'), 'string', 'the real stop still holds the connection lock')
    assert.deepEqual((await connection.listings()).map(listing => [listing.id, listing.import.status]), [[LISTING, 'imported']])
    assert.equal((await connection.details(LISTING)).fields.city, 'Moab')
    await assert.rejects(connection.activate(prepared.product_id), error => error instanceof HTTPError && error.data?.code === 'CONNECTION_BUSY')
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
        assert.deepEqual(await runAirbnbSyncJobs(env, Date.now() + 1_000, { startReserveMs: 0 }), { stepped: 0, done: 0, failed: 0 })
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
    // "FLEXIBLE" or "NOT_SELECTED" is no start: the import stops naming Airbnb's field, and nothing is made.
    const policies = channex.booking.cancellation_policy_settings
    for (const [setting, field] of [
      [{ check_in_time_start: 'NOT_SELECTED' }, 'booking_settings.check_in_time_start'], [{ check_out_time: null }, 'booking_settings.check_out_time'],
      [{ cancellation_policy_settings: null }, 'booking_settings.cancellation_policy_settings.cancellation_policy_category'],
      [{ cancellation_policy_settings: { cancellation_policy_category: 'flexible' } }, 'booking_settings.cancellation_policy_settings.lts_cancellation_policy_id'],
    ] as const) {
      channex.booking = { ...channex.booking, check_in_time_start: '16', check_out_time: 10, cancellation_policy_settings: policies, ...setting }
      await assert.rejects(connection.prepare(LISTING, form), (error: { status?: number; data?: Record<string, unknown> }) => error.status === 422 && error.data?.code === 'MISSING_AIRBNB_FIELD' && error.data.field === field)
      assert.deepEqual([await count(db, 'business_locations'), await count(db, 'products'), await count(db, 'product_channel_mappings')], [0, 0, 0])
    }
    // A policy Airbnb names that has none of ours stops the import for review, and nothing is made.
    channex.booking = { ...channex.booking, cancellation_policy_settings: { cancellation_policy_category: 'super_strict_30', lts_cancellation_policy_id: 'CANCEL_LONG_TERM_FAIR' } }
    await assert.rejects(connection.prepare(LISTING, form), { status: 422, data: { code: 'UNSUPPORTED_CANCELLATION_POLICY' } })
    assert.deepEqual([await count(db, 'business_locations'), await count(db, 'products'), await count(db, 'product_channel_mappings')], [0, 0, 0])
    channex.booking = { ...channex.booking, cancellation_policy_settings: policies }
    // A flexible end is a home whose check-in window has no end; an hour after midnight is that hour.
    channex.booking = { ...channex.booking, check_in_time_start: '16', check_in_time_end: 'FLEXIBLE', check_out_time: 10 }
    assert.equal((await connection.details(LISTING)).checkInEndTime, null)
    channex.booking = { ...channex.booking, check_in_time_end: '25' }
    assert.equal((await connection.details(LISTING)).checkInEndTime, '01:00')
    // The home has Airbnb's window; Channex's child-only beds and infant cots are 0, as Airbnb counts neither.
    await db.prepare(`CREATE TRIGGER refuse_initial_mapping BEFORE INSERT ON product_channel_mappings BEGIN SELECT RAISE(ABORT, 'Import mapping refused'); END`).run()
    await assert.rejects(connection.prepare(LISTING, form), /Import mapping refused/)
    const orphanId = await db.prepare('SELECT id FROM products').first<string>('id')
    assert.ok(orphanId)
    await updateStayHome(env, db, manager, orphanId, { min_nights: 9 })
    await db.prepare('DROP TRIGGER refuse_initial_mapping').run()
    const started = await connection.prepare(LISTING, form)
    assert.equal(started.product_id, orphanId)
    assert.equal((await readStayHome(db, manager, started.product_id)).min_nights, 9)
    assert.equal(Object.hasOwn(JSON.parse(String(await db.prepare('SELECT import_written FROM product_channel_mappings WHERE product_id = ?').bind(started.product_id).first('import_written'))) as Record<string, unknown>, 'min_nights'), false)
    // It books under the listing's own policies: Firm, and Strict Long Term.
    assert.deepEqual(await db.prepare('SELECT check_in_time, check_in_end_time, check_out_time, cancellation_policy, long_term_cancellation_policy FROM product_stay_configs WHERE product_id = ?').bind(started.product_id).first(),
      { check_in_time: '16:00', check_in_end_time: '01:00', check_out_time: '10:00', cancellation_policy: 'firm', long_term_cancellation_policy: 'strict' })
    assert.deepEqual(channex.roomTypes, [])
    const property = JSON.parse(String(await db.prepare('SELECT import_property FROM product_channel_mappings WHERE product_id = ?').bind(started.product_id).first('import_property'))) as Record<string, unknown>
    assert.deepEqual(['child_beds', 'infant_cots'].filter(key => key in property), [])
    await advanceTo(connection, db, channex, started.product_id, 'draft')
    assert.equal((await readStayHome(db, manager, started.product_id)).min_nights, 9)
    assert((JSON.parse(String(await db.prepare('SELECT import_content FROM product_channel_mappings WHERE product_id = ?').bind(started.product_id).first('import_content'))) as ImportContentReport).kept_host_edits.includes('min_nights'))
  } finally {
    globalThis.fetch = realFetch
    await runtime.dispose()
  }
})

async function count(db: D1Database, table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n
}
