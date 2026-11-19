import { AIRBNB_MAPPINGS } from './listing-mappings'
import { APIError } from 'better-auth'
import { HTTPError } from 'nitro'
import { STAY_CALENDAR_DAYS, resolveStayNightPolicy, stayChannelCalendarRules } from '~/shared/bookings'
import { executeWithinCapacity, hasOrganizationEntitlement, requireHomeCapacity } from '~/server/utils/billing'
import { d1JsonStringSet, execute, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { createStayHome, importStayNights, mergeStayHomeQueries, placeStayHomePhotosFirst, readStayHome, stayHomeInput, syncStayCalendar, updateStayHome, type StayAccess } from '~/server/domain/stays'
import { currencyFractionDigits, isCurrencyCode } from '~/shared/currencies'
import { isValidTimezone } from '~/utils/timezone'
import { memberAccessPrincipal, resolveOrganizationMembership } from '~/server/utils/member-access'
import { getMediaUploadReplay, replaceR2ImageFile, uploadResolvedMediaToAssetStore } from '~/server/utils/media-upload'
import { getMediaAsset, updateMediaAssetMetadata } from '~/server/utils/media-asset-manager'
import { imagePixelSize, MAX_IMAGE_BYTES, RESOLVED_MEDIA_IMAGE_TYPES, sniffMediaMimeType } from '~/server/utils/media-mime'
import { getProduct, updateProduct } from '~/server/utils/product-management'
import { organizationEventQuery } from '~/server/utils/organization-events'
import type { ProductDetailKey } from '~/shared/product-details'
import { MAX_ORDERED_MEDIA_ASSETS } from '~/shared/media-placement-contract'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { STAY_ARRIVAL_TEXT_LIMITS } from '~/shared/stay-arrival'
import { isStayAmenity, type StayAmenity, type StayCheckInMethod } from '~/shared/stay-listing'
import { channelInventory, channexCreate, channexGet, channexList, channexRequest, ChannexError, mapsActiveRate, propertyChannels, VRBO_CHANNEL, type ChannexEnv } from './client'
import { ChannexDataError, object, relationship, string, type JsonRecord, type Resource } from './data'
import { PHOTO_WIDTH, minorUnits, listingCalendar, listingContent, listingDetails, type DescriptionField, type ListingDetails, type ListingImage, type OrganizationContact, type ListingNight } from './airbnb-listing'
import { DETAIL_FIELDS, IMPORT_STAGES, type DetailField, type ImportStage } from '~/shared/airbnb-import'
export type { ImportStage } from '~/shared/airbnb-import'
import { installChannexMessages, uninstallChannexMessages } from './messages'
import { ariRefusals, ariTask, calendarMinimumDefaults, configureStayCalendar, forgetConfirmedNights, logAriCall, type ChannexMapping } from './ari'
import type { SuccessfulChannelPush } from '~/shared/channel-push'
import { backfillChannexMessages } from '~/server/domain/guest-threads/channel-messages'
import { publishBusinessInvalidation, publishStayInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { assertBookingBatchWrite, bookingBatchWriteRefused } from '~/server/utils/availability'
import { requireStays } from '~/server/utils/cms-capabilities'
import { publishAirbnbSync } from '~/server/events'

/**
 * An organization's Channex group and property inventory, including Airbnb's
 * account authorization and listing import. Organization deletion releases
 * its provider resources.
 *
 * A provider call that fails throws, and the step that made it fails with it.
 */

export type ConnectionStatus = 'not_connected' | 'authorizing' | 'connected' | 'disconnecting'

interface ConnectionRow {
  id: string
  organization_id: string
  status: ConnectionStatus
  group_id: string | null
  setup_property_id: string | null
  state_hash: string | null
  authorization_url: string | null
  authorization_user_id: string | null
  authorization_title: string | null
  authorization_expires_at: string | null
  channel_id: string | null
  connected_at: string | null
  disconnect_error: string | null
}

/** What the content stage could not carry over from Airbnb, for the apps to show the host. */
export interface ImportContentReport {
  /** Airbnb image ids stored this run, in Airbnb's order. */
  photos_imported: string[]
  /** Airbnb image ids already stored by an earlier run; kept as they are, caption included. */
  photos_skipped: string[]
  /** Airbnb image ids stored by an earlier import at 450 px and fetched again at 2560 px into the same photo: its place, caption and rooms kept. */
  photos_upgraded: string[]
  /** Airbnb image ids whose stored photo the host has since deleted from the media library; left out, as the host chose. */
  photos_removed: string[]
  /** Airbnb image ids left out because the home's photo limit is reached, counting the host's own photos. */
  photos_unplaced: string[]
  /** Airbnb amenity constants with no entry in the home's amenity vocabulary. */
  unmatched_amenities: string[]
  /** Airbnb's check-in category when it has no verified home check-in method; null when mapped or absent. */
  unmapped_check_in_category: string | null
  /** Texts cut to the home's limits: the field, its limit and the length Airbnb gave. */
  truncated_fields: Array<{ field: string; limit: number; length: number }>
  /** Airbnb rooms not created as photo rooms: Airbnb's photos name no room, so no tour can be assembled from them. */
  photo_rooms_skipped: number
  /** Fields the host changed in Blawby since Airbnb's value was last written: kept as the host has them. */
  kept_host_edits: string[]
}

export interface AirbnbListing {
  id: string
  channel_id: string
  title: string
  city: string
  country_code: string
  /** `syncing` is whether the listing syncs with Airbnb now (its mapping is enabled): false at `draft`, true at `complete`, either while in progress. */
  import: { status: 'not_imported' } | { status: 'imported'; product_id: string; stage: ImportStage; syncing: boolean; content: ImportContentReport | null }
}

interface MappingRow {
  organization_id: string
  product_id: string
  listing_id: string
  channel_id: string
  property_id: string | null
  room_type_id: string | null
  rate_plan_id: string | null
  import_stage: ImportStage
  import_property: string | null
  listing_rate_plan_id: string | null
  listing_stage: ImportStage
  updated_at: string
  inventory_stage: ImportStage
  import_content: string | null
  import_written: string | null
  enabled: number
}

type InventoryMapping = Pick<MappingRow, 'product_id' | 'property_id' | 'room_type_id' | 'rate_plan_id' | 'import_stage' | 'import_property'>
type MappingProgress = Partial<Pick<MappingRow, 'property_id' | 'room_type_id' | 'rate_plan_id' | 'import_stage' | 'import_property' | 'import_content' | 'import_written' | 'enabled'>>

/** The listing details the host approved; the Channex property, room type and rate plan are created from these. */
interface ImportProperty {
  title: string
  currency: string
  timezone: string
  property_type?: string
  email?: string
  phone?: string
  country?: string
  state?: string
  city?: string
  address?: string
  zip_code?: string
  max_guests: number
  default_occupancy: number
  nightly_rate: string
}

/** What the host supplies at import: only the listing fields Airbnb left out. Everything else is Airbnb's. */
export interface ImportInput {
  missingDetails: Partial<Record<DetailField, unknown>>
}


/** Where Airbnb sends the person back after signing in: the native app. */
export const AIRBNB_CALLBACK = 'krabiclaw://airbnb/callback'
const SIGN_IN_LIFETIME_MS = 2 * 60 * 60 * 1000
const SETUP_PROPERTY_TITLE = 'Blawby connection setup'
/**
 * Photos one content-stage call fetches from Airbnb. A listing's photos are
 * fetched over as many calls as it takes, so no call outlasts the app's
 * request: 28 photos in one call took 74.6 s (2026-10-22).
 */
const PHOTO_FETCHES_PER_CALL = 6

function fail(statusCode: number, code: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new HTTPError({ statusCode, message, data: { code, ...detail } })
}

/**
 * Airbnb `check_in_option.category` values with a verified home check-in
 * method: `smartlock` was read live (2026-10-22); `keypad` and `lockbox` are
 * the same words in both vocabularies. Airbnb's other categories are not
 * documented by Channex, so they are reported rather than guessed.
 */
const CHECK_IN_METHODS: Record<string, StayCheckInMethod> = { smartlock: 'smart_lock', keypad: 'keypad', lockbox: 'lockbox' }

/** Airbnb's description texts and the home's sections they become, one to one. */
const DESCRIPTION_DETAILS: ReadonlyArray<readonly [ProductDetailKey, DescriptionField]> = [
  ['your_property', 'space'], ['guest_access', 'access'], ['interaction_with_guests', 'interaction'], ['other_details_to_note', 'notes'],
  ['neighborhood_description', 'neighborhood_overview'], ['getting_around', 'transit'], ['house_rules', 'house_rules'],
]

/** The non-empty texts, trimmed, as paragraphs; null when there are none. */
function paragraphs(...parts: Array<string | null | undefined>): string | null {
  const text = parts.flatMap(part => part?.trim() ? [part.trim()] : []).join('\n\n')
  return text || null
}

function provided<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof ChannexDataError) fail(502, 'INVALID_PROVIDER_RESPONSE', `Channex returned an invalid response: ${error.message}`)
    throw error
  }
}

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}

const now = () => new Date().toISOString()

export class ChannexConnection {
  private readonly db: DbClient
  private readonly env: CloudflareEnv & ChannexEnv
  private readonly organizationId: string
  private readonly userId: string

  constructor(db: DbClient, env: CloudflareEnv, organizationId: string, userId: string) {
    this.db = db
    this.env = env
    this.organizationId = organizationId
    this.userId = userId
  }

  private async rows(): Promise<ConnectionRow[]> {
    return await queryAll<ConnectionRow>(this.db, `SELECT c.*, g.group_id FROM channex_connections c
      LEFT JOIN channex_groups g USING (organization_id)
      WHERE c.organization_id = ? ORDER BY c.created_at, c.id`, [this.organizationId])
  }

  private async account(channelId: string): Promise<ConnectionRow | undefined> {
    return await queryFirst<ConnectionRow>(this.db, `SELECT c.*, g.group_id FROM channex_connections c
      LEFT JOIN channex_groups g USING (organization_id)
      WHERE c.organization_id = ? AND c.channel_id = ?`, [this.organizationId, channelId])
  }

  private async pending(): Promise<ConnectionRow> {
    await execute(this.db, "INSERT INTO channex_connections (id, organization_id, status) VALUES (?, ?, 'not_connected') ON CONFLICT DO NOTHING", [crypto.randomUUID(), this.organizationId])
    const row = (await this.rows()).find(account => account.channel_id === null)
    if (!row) fail(409, 'CONNECTION_CHANGED', 'The Airbnb sign-in changed. Refresh and try again.')
    return row
  }

  private async save(row: ConnectionRow, values: Partial<Omit<ConnectionRow, 'group_id'>>): Promise<void> {
    const entries = Object.entries(values)
    const result = await execute(this.db, `UPDATE channex_connections SET ${[...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'].join(', ')}
      WHERE organization_id = ? AND id = ?`, [...entries.map(([, value]) => value ?? null), now(), this.organizationId, row.id])
    if (!result.meta.changes) fail(409, 'CONNECTION_CHANGED', 'The Airbnb connection changed. Refresh and try again.')
    Object.assign(row, values)
  }

  private async mappings(): Promise<MappingRow[]> {
    return await queryAll<MappingRow>(this.db, `SELECT * FROM ${AIRBNB_MAPPINGS} WHERE organization_id = ?`, [this.organizationId])
  }

  /** The channel, verified to be this organization's Airbnb channel and to map only its properties and rate plans. */
  private async channel(row: ConnectionRow, channelId: string, inventory: readonly MappingRow[] | Promise<readonly MappingRow[]> = this.mappings()): Promise<Resource & { properties: string[]; ratePlans: JsonRecord[]; active: boolean }> {
    const [channel, mappings] = await Promise.all([channexGet(this.env, `/channels/${encodeURIComponent(channelId)}`, 'channel'), inventory])
    const allowedProperties = new Set((await queryAll<{ property_id: string }>(this.db, `SELECT property_id FROM product_channel_mappings
      WHERE organization_id = ? AND property_id IS NOT NULL`, [this.organizationId])).map(mapping => mapping.property_id))
    const allowedRatePlans = new Set(mappings.flatMap(mapping => mapping.channel_id === channelId && mapping.rate_plan_id ? [mapping.rate_plan_id] : []))
    return provided(() => {
      const { properties, ratePlans, active } = channelInventory(channel)
      const allowed = new Set(allowedProperties)
      if (row.setup_property_id) allowed.add(row.setup_property_id)
      if (channel.attributes.channel !== 'AirBNB' || relationship(channel, 'group') !== row.group_id
        || properties.length === 0 || properties.some(id => !allowed.has(id))) {
        fail(403, 'CHANNEL_NOT_OWNED', 'This Airbnb connection does not belong to this organization')
      }
      if (ratePlans.some(mapping => !allowedRatePlans.has(String(mapping.rate_plan_id)) && !mappings.some(listing => listing.channel_id === channelId && listing.import_stage === 'mapping' && listing.listing_id === object(mapping.settings, 'Mapping settings').listing_id))) fail(403, 'CHANNEL_NOT_OWNED', 'This Airbnb connection maps a listing outside this organization')
      return { ...channel, properties, ratePlans, active }
    })
  }

  /**
   * `connected` means the Airbnb account is authorized. Its channel exchanges
   * nothing until a listing is imported and the channel activated, which
   * `channel_active` reports.
   */
  private statusOf(row: ConnectionRow | null, channel: { ratePlans: readonly unknown[]; active: boolean } | null) {
    return {
      status: row?.status ?? 'not_connected' as const, connected_at: row?.connected_at ?? null,
      listing_count: channel?.ratePlans.length ?? 0, channel_active: channel?.active ?? false,
      disconnect_error: row?.disconnect_error ?? null,
    }
  }

  async status() {
    await requireStays(this.db, this.organizationId)
    const rows = await this.rows()
    const mappings = rows.some(row => row.status === 'connected') ? await this.mappings() : []
    const connections = await Promise.all(rows.map(async row => {
      const channel = row.status === 'connected' && row.channel_id ? await this.channel(row, row.channel_id, mappings) : null
      return { ...this.statusOf(row, channel), channel_id: row.channel_id }
    }))
    const connected = connections.filter(account => account.status === 'connected')
    const current = connected[0] ?? connections.find(account => account.status === 'disconnecting' || account.status === 'authorizing')
    return {
      ...this.statusOf(null, null),
      ...current,
      channel_id: current?.channel_id ?? null,
      listing_count: connected.reduce((count, account) => count + account.listing_count, 0),
      channel_active: connected.some(account => account.channel_active),
      connections,
    }
  }

  async workspace() {
    const connection = await this.status()
    if (connection.status !== 'connected') return { connection, inventory: null, inventory_error: null }
    try {
      return { connection, inventory: await this.listings(), inventory_error: null }
    } catch (cause) {
      return { connection, inventory: null, inventory_error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  private async ensureGroup(): Promise<string> {
    const read = () => queryFirst<{ group_id: string }>(this.db, 'SELECT group_id FROM channex_groups WHERE organization_id = ?', [this.organizationId])
    const existing = await read()
    if (existing) return existing.group_id
    const title = `Blawby ${this.organizationId}`
    const groups = (await channexList(this.env, '/groups', 'group', { 'filter[title]': title })).filter(group => group.attributes.title === title)
    if (groups.length > 1) fail(502, 'PROVIDER_STATE_AMBIGUOUS', `Channex has ${groups.length} groups titled ${JSON.stringify(title)}.`)
    const id = groups[0]?.id ?? (await channexCreate(this.env, '/groups', { group: { title } }, 'group')).id
    await execute(this.db, 'INSERT INTO channex_groups (organization_id, group_id) VALUES (?, ?) ON CONFLICT (organization_id) DO NOTHING', [this.organizationId, id])
    const stored = await read()
    if (!stored) fail(409, 'CONNECTION_CHANGED', 'The Channex group changed. Refresh and try again.')
    if (stored.group_id !== id) await channexRequest(this.env, `/groups/${encodeURIComponent(id)}`, 'DELETE')
    return stored.group_id
  }

  /** A single-use Airbnb sign-in link for the person asking. */
  async start(callback = AIRBNB_CALLBACK): Promise<{ authorization_url: string }> {
    await requireStays(this.db, this.organizationId)
    const row = await this.pending()
    if (row.authorization_url) {
      if (row.authorization_user_id !== this.userId) fail(409, 'SIGN_IN_OWNED_ELSEWHERE', 'Another admin started this Airbnb sign-in. They need to finish it.')
      if (!row.authorization_expires_at || row.authorization_expires_at <= now()) fail(409, 'SIGN_IN_EXPIRED', 'The Airbnb sign-in link expired. Contact support to review the unfinished connection.')
      return { authorization_url: row.authorization_url }
    }
    row.group_id = await this.ensureGroup()
    if (!row.setup_property_id) {
      const title = `${SETUP_PROPERTY_TITLE} ${row.id}`
      const id = await this.createdProperty(title, row.group_id)
        ?? (await channexCreate(this.env, '/properties', { property: { title, currency: 'USD', property_type: 'apartment', group_id: row.group_id } }, 'property')).id
      await this.keepSetupProperty(row, id, `/properties/${encodeURIComponent(id)}`)
    }
    const state = crypto.randomUUID() + crypto.randomUUID()
    const title = `Blawby ${crypto.randomUUID()}`
    const result = await channexRequest(this.env, '/meta/airbnb/connection_link', 'POST', { connection_link: {
      group_id: row.group_id, properties: [row.setup_property_id], redirect_uri: callback, failure_redirect_uri: callback, token: state, title, settings: { min_stay_type: 'Arrival' },
    } })
    const address = provided(() => {
      const data = object(result.data, 'Connection link')
      if (data.type !== 'connection_link') throw new ChannexDataError('Unexpected connection link response')
      return string(object(data.attributes, 'Connection link').url, 'Authorization URL')
    })
    if (!URL.canParse(address)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Channex returned an invalid Airbnb sign-in link')
    const url = new URL(address)
    if (url.protocol !== 'https:' || url.hostname !== 'www.airbnb.com' || url.pathname !== '/oauth2/auth') fail(502, 'INVALID_PROVIDER_RESPONSE', 'Channex returned an unexpected Airbnb sign-in link')
    // A concurrent start that saved its link first wins; this link is never shown.
    const saved = await execute(this.db, `UPDATE channex_connections SET state_hash = ?, authorization_user_id = ?, authorization_title = ?, authorization_expires_at = ?,
        authorization_url = ?, status = 'authorizing', updated_at = ? WHERE organization_id = ? AND id = ? AND authorization_url IS NULL AND channel_id IS NULL`,
    [await digest(state), this.userId, title, new Date(Date.now() + SIGN_IN_LIFETIME_MS).toISOString(), url.toString(), now(), this.organizationId, row.id])
    if (saved.meta.changes) return { authorization_url: url.toString() }
    const winner = (await this.rows()).find(account => account.id === row.id)
    if (!winner?.authorization_url || winner.authorization_user_id !== this.userId) fail(409, 'SIGN_IN_OWNED_ELSEWHERE', 'Another admin started this Airbnb sign-in. They need to finish it.')
    return { authorization_url: winner.authorization_url }
  }

  /**
   * Save a Channex resource this request created, unless a concurrent request
   * saved its own first: then this one is deleted from Channex and the saved
   * one is used.
   */
  private async keepSetupProperty(row: ConnectionRow, id: string, path: string): Promise<void> {
    const saved = await execute(this.db, `UPDATE channex_connections SET setup_property_id = ?, updated_at = ?
      WHERE organization_id = ? AND id = ? AND setup_property_id IS NULL`, [id, now(), this.organizationId, row.id])
    const current = (await this.rows()).find(account => account.id === row.id)
    if (!current) fail(409, 'CONNECTION_CHANGED', 'The Airbnb sign-in changed. Refresh and try again.')
    Object.assign(row, current)
    if (!saved.meta.changes && row.setup_property_id !== id) await channexRequest(this.env, path, 'DELETE')
  }

  /**
   * The property an earlier attempt created in this organization's group before
   * its id was saved, found in Channex: it has every value that attempt sent
   * (title, address, contact, currency, time zone and type), and no Blawby row
   * names it, so it is indistinguishable from the one this attempt would
   * create. Null when there is none; two such are refused.
   */
  private async createdProperty(title: string, groupId: string, sent: Record<string, unknown> = {}): Promise<string | null> {
    const rows = await channexList(this.env, '/properties', 'property', { 'filter[title]': title })
    const known = new Set((await queryAll<{ id: string }>(this.db, `SELECT property_id AS id FROM product_channel_mappings WHERE organization_id = ? AND provider = 'channex' AND property_id IS NOT NULL
      UNION SELECT setup_property_id FROM channex_connections WHERE organization_id = ? AND setup_property_id IS NOT NULL`, [this.organizationId, this.organizationId])).map(row => row.id))
    const created = provided(() => rows.filter((row) => {
      const groups = object(object(row.relationships, 'property.relationships').groups, 'property.relationships.groups').data
      if (!Array.isArray(groups)) throw new ChannexDataError('property.relationships.groups.data must be a list')
      return row.attributes.title === title && Object.entries(sent).every(([key, value]) => value === undefined || row.attributes[key] === value)
        && groups.some(group => object(group, 'property group').id === groupId) && !known.has(row.id)
    }))
    if (created.length > 1) fail(502, 'PROVIDER_STATE_AMBIGUOUS', `Channex has ${created.length} unrecorded properties titled ${JSON.stringify(title)} with the same details in this organization's group.`)
    return created[0]?.id ?? null
  }

  /** The callback: the state proves it is this person's sign-in, the channel proves it is the account they just authorized. */
  async complete(state: string, channelId: string): Promise<{ connected: true }> {
    const hash = await digest(state)
    const row = (await this.rows()).find(account => account.state_hash === hash)
    if (!row || row.status !== 'authorizing' || row.authorization_user_id !== this.userId || !row.authorization_expires_at
      || row.authorization_expires_at <= now()) {
      fail(403, 'SIGN_IN_INVALID', 'This Airbnb sign-in has expired or belongs to a different session')
    }
    const channel = await this.channel(row, channelId)
    if (channel.attributes.title !== row.authorization_title || channel.active || channel.ratePlans.length !== 0) {
      fail(403, 'SIGN_IN_MISMATCH', 'Airbnb returned a different connection. Nothing was imported.')
    }
    await this.save(row, {
      channel_id: channel.id, status: 'connected', connected_at: now(), authorization_url: null,
      state_hash: null, authorization_expires_at: null, authorization_user_id: null, authorization_title: null,
    })
    return { connected: true }
  }

  private async connected(channelId: string): Promise<ConnectionRow & { channel_id: string }> {
    const row = await this.account(channelId)
    if (!row || !row.channel_id || row.status !== 'connected') fail(409, 'NOT_CONNECTED', 'Connect your Airbnb account first.')
    return row as ConnectionRow & { channel_id: string }
  }

  private async accountListings(channelId: string): Promise<Array<Omit<AirbnbListing, 'import'>>> {
    const raw = await channexRequest(this.env, `/channels/${encodeURIComponent(channelId)}/action/listings`)
    return provided(() => {
      const dictionary = object(object(raw.data, 'Airbnb listings').listing_id_dictionary, 'Listing dictionary')
      if (!Array.isArray(dictionary.values)) throw new ChannexDataError('Airbnb did not return a listing collection')
      return dictionary.values.map((value) => {
        const listing = object(value, 'Airbnb listing')
        return { id: string(listing.id, 'Listing id'), channel_id: channelId, title: string(listing.title, 'Listing title'), city: string(listing.city, 'Listing city'), country_code: string(listing.country_code, 'Listing country') }
      })
    })
  }

  /** The account's listings and imported homes still enabled after their listing disappeared from Airbnb. */
  async listings(): Promise<{ listings: AirbnbListing[]; missing_listings: Array<{ listing_id: string; product_id: string; internal_name: string }> }> {
    const rows = (await this.rows()).filter(row => row.status === 'connected' && row.channel_id)
    const mappings = rows.length ? await this.mappings() : []
    const inventories = await Promise.all(rows.map(async row => {
      await this.channel(row, row.channel_id!, mappings)
      return this.listingsFor(row.channel_id!, mappings)
    }))
    return {
      listings: inventories.flatMap(inventory => inventory.listings),
      missing_listings: inventories.flatMap(inventory => inventory.missing_listings),
    }
  }

  private async listingsFor(channelId: string, inventory: readonly MappingRow[] | Promise<readonly MappingRow[]>): Promise<{ listings: AirbnbListing[]; missing_listings: Array<{ listing_id: string; product_id: string; internal_name: string }> }> {
    const [account, mappings] = await Promise.all([this.accountListings(channelId), inventory])
    const imported = new Map(mappings.filter(mapping => mapping.channel_id === channelId).map(mapping => [mapping.listing_id, mapping]))
    const listings: AirbnbListing[] = account.map((listing) => {
      const mapping = imported.get(listing.id)
      imported.delete(listing.id)
      return { ...listing, import: mapping ? { status: 'imported', product_id: mapping.product_id, stage: mapping.import_stage, syncing: mapping.enabled === 1 && ['reservations', 'messages', 'complete'].includes(mapping.import_stage), content: mapping.import_stage === 'content' ? null : contentReport(mapping) } : { status: 'not_imported' } }
    })
    const missing = [...imported.values()].filter(mapping => mapping.enabled === 1 && mapping.import_stage === 'complete')
    const homes = missing.length ? await queryAll<{ product_id: string; internal_name: string | null }>(this.db, `
      SELECT product_id, internal_name FROM product_stay_configs
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?))`,
    [this.organizationId, d1JsonStringSet(missing.map(mapping => mapping.product_id))]) : []
    const missing_listings = missing.map((mapping) => {
      const internal_name = homes.find(home => home.product_id === mapping.product_id)?.internal_name
      if (!internal_name?.trim()) throw new Error(`Home ${mapping.product_id} has no internal name`)
      return { listing_id: mapping.listing_id, product_id: mapping.product_id, internal_name }
    })
    return { listings, missing_listings }
  }

  private async accountForListing(listingId: string): Promise<ConnectionRow & { channel_id: string }> {
    const matches = (await this.listings()).listings.filter(listing => listing.id === listingId)
    if (matches.length > 1) fail(409, 'LISTING_ACCOUNT_AMBIGUOUS', 'Airbnb returned this listing on more than one connected account.')
    const [listing] = matches
    if (!listing && !(await this.rows()).some(row => row.status === 'connected')) fail(409, 'NOT_CONNECTED', 'Connect an Airbnb account first.')
    if (!listing) fail(404, 'LISTING_NOT_FOUND', 'This listing is not on a connected Airbnb account.')
    return await this.connected(listing.channel_id)
  }

  /** A listing's details, and which of the fields an import needs Airbnb left out. */
  async details(listingId: string): Promise<ListingDetails> {
    const row = await this.accountForListing(listingId)
    return await listingDetails(this.env, row.channel_id, listingId, await this.organizationContact())
  }

  /** The organization's contact email and phone, set on Website › Brand › Contact or by a first import. */
  private async organizationContact(): Promise<OrganizationContact> {
    const organization = await queryFirst<{ contact_email: string | null; contact_phone: string | null }>(this.db, 'SELECT contact_email, contact_phone FROM organization WHERE id = ?', [this.organizationId])
    if (!organization) throw new Error(`Organization ${this.organizationId} has no row`)
    return { email: organization.contact_email?.trim() || null, phone: organization.contact_phone?.trim() || null }
  }

  /**
   * Contact details the host typed because the organization had none become
   * the organization's, so the next import does not ask again. Validated as
   * the organization settings validate them, before anything is written; the
   * update is committed with the import's mapping. A detail set in Brand ›
   * Contact while the import ran is kept: each is written only while still empty.
   */
  private organizationContactUpdate(details: ListingDetails, values: Record<Exclude<DetailField, 'assigned_member_id'>, string>): BatchQuery | null {
    const sets: string[] = []
    const params: unknown[] = []
    if (details.missing_fields.includes('email')) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) fail(422, 'INVALID_DETAIL', 'Enter a valid contact email')
      sets.push("contact_email = COALESCE(NULLIF(TRIM(contact_email), ''), ?)")
      params.push(values.email.toLowerCase())
    }
    if (details.missing_fields.includes('phone')) {
      if (values.phone.length > 32) fail(422, 'INVALID_DETAIL', 'Contact phone must be 32 characters or fewer')
      sets.push("contact_phone = COALESCE(NULLIF(TRIM(contact_phone), ''), ?)")
      params.push(values.phone)
    }
    if (sets.length === 0) return null
    sets.push('updated_at = ?', 'updated_by = ?')
    params.push(now(), this.userId, this.organizationId)
    return { query: `UPDATE organization SET ${sets.join(', ')} WHERE id = ?`, params }
  }

  /**
   * Creates the home a listing becomes: its location, its stay product and
   * price, its imported nights, and the mapping the import advances. The home
   * is a draft until it is activated, so nothing here is held to the plan.
   * Calling it again for the same listing returns the import already under way.
   */
  async prepare(listingId: string, input: ImportInput): Promise<{ product_id: string; stage: ImportStage; waiting: false }> {
    const row = await this.accountForListing(listingId)
    const channelId = row.channel_id
    const existing = await queryFirst<MappingRow>(this.db, `SELECT * FROM ${AIRBNB_MAPPINGS} WHERE listing_id = ?`, [listingId])
    if (existing) {
      if (existing.organization_id !== this.organizationId) fail(409, 'LISTING_LINKED_ELSEWHERE', 'This Airbnb listing is already linked to another organization')
      if (existing.channel_id === channelId) return { product_id: existing.product_id, stage: existing.import_stage, waiting: false }
      if (existing.enabled) fail(409, 'IMPORT_NEEDS_REVIEW', 'Stop the previous connection before reconnecting this listing.')
      await execute(this.db, `UPDATE product_airbnb_listings SET channel_id = ?, import_stage = 'draft', updated_at = ?
        WHERE organization_id = ? AND listing_id = ? AND enabled = 0`, [channelId, now(), this.organizationId, listingId])
      return { product_id: existing.product_id, stage: 'draft', waiting: false }
    }

    const details = await listingDetails(this.env, channelId, listingId, await this.organizationContact())
    const supplied = Object.keys(input.missingDetails ?? {})
    if (supplied.some(key => !(details.missing_fields as string[]).includes(key))) fail(422, 'ONLY_MISSING_DETAILS', 'Only the listing details Airbnb left out may be supplied')
    const field = (key: DetailField): string => {
      const value = details.fields[key] ?? input.missingDetails?.[key]
      if (typeof value !== 'string' || !value.trim()) fail(422, 'MISSING_DETAIL', `${key} is required`, { field: `details.${key}` })
      return value.trim()
    }
    const values = Object.fromEntries(DETAIL_FIELDS.filter(key => key !== 'assigned_member_id').map(key => [key, field(key)])) as Record<Exclude<DetailField, 'assigned_member_id'>, string>
    if (details.default_occupancy > details.max_guests) fail(422, 'INVALID_DETAIL', "The included guest count exceeds the listing's capacity")
    const organization = await queryFirst<{ default_currency: string }>(this.db, 'SELECT default_currency FROM organization WHERE id = ?', [this.organizationId])
    if (!organization || !isCurrencyCode(organization.default_currency)) throw new Error(`Organization ${this.organizationId} has no supported default currency`)
    if (details.currency !== organization.default_currency) {
      fail(422, 'CURRENCY_MISMATCH', `This listing is priced in ${details.currency} and this organization sells in ${organization.default_currency}. Import stopped; nothing was created.`)
    }
    if (!isValidTimezone(values.timezone)) fail(422, 'INVALID_DETAIL', 'Choose a valid time zone')
    // Imported times and policies remain exactly as supplied, including unknown values.
    const calendar = await listingCalendar(this.env, channelId, listingId, values.timezone)
    const contact = this.organizationContactUpdate(details, values)
    const property: ImportProperty = {
      title: details.title, currency: details.currency, timezone: values.timezone, ...(details.fields.propertyType ? { property_type: details.fields.propertyType } : {}), email: values.email, phone: values.phone,
      country: values.country, state: values.state, city: values.city, address: values.address, zip_code: values.zipCode, max_guests: details.max_guests,
      default_occupancy: details.default_occupancy, nightly_rate: details.nightly_rate,
    }
    // The host names the member who looks after the home; Airbnb never says.
    const memberId = field('assigned_member_id')
    if (!await queryFirst(this.db, 'SELECT id FROM member WHERE organizationId = ? AND id = ?', [this.organizationId, memberId])) fail(422, 'INVALID_DETAIL', 'assigned_member_id must be a member of this organization', { field: 'details.assigned_member_id' })
    const home = await createStayHome(this.env, this.db, this.manager(), stayHomeInput({
      name: details.title, timezone: values.timezone, address: values.address, city: values.city, state: values.state, country: values.country,
      zip_code: values.zipCode, phone: values.phone, email: values.email, check_in_time: details.check_in_time, check_in_end_time: details.check_in_end_time, check_out_time: details.check_out_time,
      max_guests: details.max_guests, min_nights: details.minimum_nights, calendar_rules: details.calendar_rules, base_price_minor: provided(() => minorUnits(details.nightly_rate, organization.default_currency)),
      cancellation_policy: details.cancellation_policy, long_term_cancellation_policy: details.long_term_cancellation_policy, assigned_member_id: memberId,
    }), `airbnb-listing:${listingId}`)
    // The nights land before the mapping: until the mapping exists a retry
    // runs this whole step again (the location and product replay by their
    // idempotency key, the nights upsert), so no import is left without its calendar.
    await importStayNights(this.db, this.env, this.manager(), home.product_id, provided(() => calendar.map(night => importedNight(night, organization.default_currency, details))))
    // The mapping and what the host typed as the organization's contact are
    // one write: until both land a retry runs this step again with the same
    // form, and a refused import leaves the details missing.
    await executeBatch(this.db, [{
      query: `INSERT INTO product_channel_mappings (organization_id, product_id, provider, import_stage, import_property)
        VALUES (?, ?, 'channex', 'property', ?) ON CONFLICT (product_id, provider) DO NOTHING`,
      params: [this.organizationId, home.product_id, JSON.stringify(property)],
    }, {
      query: `INSERT INTO product_airbnb_listings (organization_id, product_id, listing_id, channel_id, import_stage, import_written)
        VALUES (?, ?, ?, ?, 'property', ?) ON CONFLICT (listing_id) DO NOTHING`,
      params: [this.organizationId, home.product_id, listingId, channelId, JSON.stringify({ min_nights: await fingerprint(home.min_nights), calendar_rules: await fingerprint(stayChannelCalendarRules(home.calendar_rules)) })],
    }, ...(contact ? [contact] : [])], { operation: 'Map an imported Airbnb listing' })
    return { product_id: home.product_id, stage: 'property', waiting: false }
  }

  /** Connect a listing to a home that already has its provider room. The home's content stays its own. */
  async attach(listingId: string, productId: string): Promise<void> {
    await this.requireChannelSync()
    const row = await this.accountForListing(listingId)
    const existing = await queryFirst<MappingRow>(this.db, `SELECT * FROM ${AIRBNB_MAPPINGS} WHERE listing_id = ?`, [listingId])
    if (existing?.organization_id === this.organizationId && existing.product_id === productId) return
    if (existing && (existing.organization_id !== this.organizationId || existing.channel_id !== row.channel_id || !['complete', 'draft'].includes(existing.import_stage))) {
      fail(409, 'LISTING_ALREADY_MAPPED', 'Finish the existing listing’s setup before merging its home.')
    }
    const inventory = await queryFirst<InventoryMapping>(this.db, `SELECT * FROM product_channel_mappings WHERE organization_id = ? AND product_id = ?
      AND provider = 'channex' AND import_stage = 'complete'`, [this.organizationId, productId])
    if (!inventory) fail(409, 'CHANNEL_PROPERTY_NOT_READY', 'Choose a home that already syncs with Channex.')
    const home = await readStayHome(this.db, this.manager(), productId)
    const details = await listingDetails(this.env, row.channel_id, listingId, await this.organizationContact())
    if (details.currency !== home.currency) fail(422, 'CURRENCY_MISMATCH', 'This listing is priced in a different currency from the home.')
    const propertyId = string(inventory.property_id, 'property_id')
    const roomId = string(inventory.room_type_id, 'room_type_id')
    const title = `Airbnb ${listingId}`
    const plans = await channexList(this.env, '/rate_plans', 'rate_plan', { 'filter[property_id]': propertyId })
    const matches = plans.filter(plan => plan.attributes.title === title && relationship(plan, 'room_type') === roomId)
    if (matches.length > 1) fail(409, 'PROVIDER_STATE_AMBIGUOUS', 'More than one Channex rate plan matches this listing.')
    const plan = matches[0] ?? await channexCreate(this.env, '/rate_plans', { rate_plan: {
      property_id: propertyId, room_type_id: roomId, title, currency: details.currency,
      rate_mode: 'manual', sell_mode: 'per_room', min_stay_arrival: details.minimum_nights,
      options: [{ occupancy: details.default_occupancy, is_primary: true, rate: details.nightly_rate }],
    } }, 'rate_plan')
    const [calendar, closedNights] = await Promise.all([
      listingCalendar(this.env, row.channel_id, listingId, home.timezone),
      queryAll<{ date: string }>(this.db, 'SELECT date FROM product_nights WHERE organization_id = ? AND product_id = ? AND closed = 1', [this.organizationId, productId]),
    ])
    const closed = new Set(closedNights.map(night => night.date))
    const digits = currencyFractionDigits(details.currency)
    const receipt = await channexRequest(this.env, '/restrictions', 'POST', { values: calendar.map(night => ({
      property_id: propertyId, rate_plan_id: plan.id, date_from: night.date, date_to: night.date,
      rate: (minorUnits(night.rate, details.currency) / 10 ** digits).toFixed(digits), stop_sell: closed.has(night.date), min_stay_arrival: night.minStay, max_stay: night.maxStay,
      closed_to_arrival: night.closedToArrival, closed_to_departure: night.closedToDeparture,
    })) })
    const refused = ariRefusals(receipt, 'restrictions', calendar.map(night => night.date))
    const detail = refused.values().next().value ?? `Seeded the rates for Airbnb listing ${listingId}`
    await logAriCall(this.db, { organizationId: this.organizationId, productId, propertyId, kind: 'restrictions',
      status: refused.size ? 'needs_review' : 'pushed', detail, taskId: ariTask(receipt, refused.size > 0) })
    if (refused.size) fail(502, 'PROVIDER_VERIFICATION_FAILED', detail)
    if (!existing) {
      await execute(this.db, `INSERT INTO product_airbnb_listings (listing_id, organization_id, product_id, channel_id, rate_plan_id, import_stage)
        VALUES (?, ?, ?, ?, ?, 'draft')`, [listingId, this.organizationId, productId, row.channel_id, plan.id])
      return
    }

    if (await this.hasOtherChannel(existing)) fail(409, 'HOME_HAS_OTHER_LISTINGS', 'Disconnect the source home’s other listings before merging it.')
    const sourceId = existing.product_id
    const timestamp = now()
    const merge = await mergeStayHomeQueries(this.db, this.manager(), sourceId, home, timestamp)
    try {
      await executeBatch(this.db, [
        assertBookingBatchWrite({
          query: `EXISTS (SELECT 1 FROM product_airbnb_listings WHERE organization_id = ? AND listing_id = ? AND product_id = ? AND updated_at = ?)
            AND NOT EXISTS (SELECT 1 FROM product_airbnb_listings WHERE organization_id = ? AND product_id = ? AND listing_id <> ?)`,
          params: [this.organizationId, listingId, sourceId, existing.updated_at, this.organizationId, sourceId, listingId],
        }),
        ...merge,
        {
          query: `UPDATE product_airbnb_listings SET product_id = ?, rate_plan_id = ?, import_stage = 'mapping', updated_at = ?
            WHERE organization_id = ? AND listing_id = ?`,
          params: [productId, plan.id, timestamp, this.organizationId, listingId],
        },
        {
          query: `UPDATE product_channel_mappings SET enabled = 0 WHERE organization_id = ? AND product_id = ?`,
          params: [this.organizationId, sourceId],
        },
        organizationEventQuery({ organizationId: this.organizationId, actorId: this.userId,
          eventType: 'stay.updated', entityType: 'product', entityId: productId, metadata: { listing_id: listingId, merged_product_id: sourceId } }),
      ], { operation: 'Merge an Airbnb listing’s home' })
    } catch (cause) {
      if (bookingBatchWriteRefused(cause)) fail(409, 'HOME_MERGE_CONFLICT', 'The source home changed, has a pending booking, or has an overlapping direct stay. Resolve it before merging.')
      throw cause
    }
    await forgetConfirmedNights(this.db, productId)
    await publishBusinessInvalidation(this.env, this.organizationId)
  }

  private manager(): StayAccess {
    return { organizationId: this.organizationId, actorId: this.userId, manage: true }
  }

  /**
   * One stage of a listing's import. Each call does one provider step and
   * saves where it got; `waiting` means Channex has not applied the last step
   * yet and the same stage is asked again later.
   */
  async advance(listingId: string): Promise<{ product_id: string; stage: ImportStage; waiting: boolean; content: ImportContentReport | null }> {
    const mapping = await this.listingMapping(listingId)
    const productId = mapping.product_id
    if (!mapping.channel_id) fail(409, 'NOT_CONNECTED', 'This home has no connected Airbnb listing.')
    const row = await this.connected(mapping.channel_id)
    const channelId = row.channel_id
    const channel = await this.channel(row, channelId)
    const stage = mapping.import_stage
    const save = (values: MappingProgress) => this.saveListing(mapping, values)
    const path = `/channels/${encodeURIComponent(channelId)}`
    switch (stage) {
      case 'property':
      case 'room':
      case 'rate':
      case 'inventory':
      case 'verify_inventory':
        if (await this.advanceInventory(row, mapping)) return { product_id: productId, stage, waiting: true, content: null }
        if (mapping.import_stage === 'complete') await save({ import_stage: 'content' })
        break
      case 'content': {
        // Reads Airbnb and writes the home; nothing is written to Channex.
        // A few photos per call: until all are stored the stage is asked again, keeping the report so far.
        const { report, done, written } = await this.importContent(mapping, channelId, PHOTO_FETCHES_PER_CALL)
        if (!done) {
          await save({ import_content: JSON.stringify(report) })
          return { product_id: productId, stage, waiting: true, content: null }
        }
        await save({ import_stage: 'draft', import_content: JSON.stringify(report), import_written: JSON.stringify(written) })
        break
      }
      case 'draft':
        // A draft waits for Activate; advancing it changes nothing.
        break
      case 'mapping': {
        // The listing syncs from here on: the plan must take one more live home before Channex maps it.
        await requireHomeCapacity(this.env, this.db, this.organizationId, productId)
        // Channex has the calendar ahead before it maps the listing. A home that stopped
        // syncing forgot what Channex confirmed, so this is its full sync; a home just
        // imported changed nothing since its inventory and sends nothing.
        if ((await this.deliverCalendar(mapping)).state === 'pending') return { product_id: productId, stage, waiting: true, content: null }
        const former = channel.ratePlans.find(entry => entry.rate_plan_id !== mapping.rate_plan_id && object(entry.settings, 'Mapping settings').listing_id === listingId)
        if (former) await channexRequest(this.env, `${path}/mappings/${encodeURIComponent(string(former.id, 'Mapping id'))}`, 'DELETE')
        if (!channel.ratePlans.some(entry => entry.rate_plan_id === mapping.rate_plan_id && object(entry.settings, 'Mapping settings').listing_id === listingId)) {
          await channexCreate(this.env, `${path}/mappings`, { mapping: { rate_plan_id: mapping.rate_plan_id, settings: { listing_id: mapping.listing_id } } }, 'channel_rate_plan')
        }
        await save({ import_stage: 'activate' })
        break
      }
      case 'activate': {
        // The first real listing replaces the temporary setup property before activation.
        if (row.setup_property_id) {
          const properties = channel.properties.filter(id => id !== row.setup_property_id)
          if (!properties.length) throw new Error(`Import of ${productId} reached activation with no mapped property`)
          if (properties.length !== channel.properties.length) await channexRequest(this.env, path, 'PUT', { channel: { channel: 'AirBNB', properties } })
          // An earlier attempt may have deleted it before its removal was saved.
          const setupPath = `/properties/${encodeURIComponent(row.setup_property_id)}`
          if (await this.present(setupPath, 'property')) await channexRequest(this.env, setupPath, 'DELETE')
          await this.save(row, { setup_property_id: null })
        }
        if ((await channexGet(this.env, path, 'channel')).attributes.is_active === false) await channexRequest(this.env, `${path}/activate`, 'POST')
        // The real provider mapping now exists: publish any draft edits before enabling the home.
        if ((await this.deliverCalendar(mapping)).state === 'pending') return { product_id: productId, stage, waiting: true, content: null }
        // Enabling the mapping makes the home live: guarded and billed as a home going live.
        const [enabled] = await executeWithinCapacity(this.env, this.db, this.organizationId, [{
          query: "UPDATE product_airbnb_listings SET import_stage = 'reservations', enabled = 1, updated_at = ? WHERE organization_id = ? AND listing_id = ? AND import_stage = 'activate'",
          params: [now(), this.organizationId, listingId],
        }, {
          query: "UPDATE product_channel_mappings SET enabled = 1 WHERE organization_id = ? AND product_id = ? AND EXISTS (SELECT 1 FROM product_airbnb_listings WHERE listing_id = ? AND enabled = 1)",
          params: [this.organizationId, productId, listingId],
        }], { operation: 'Enable an imported Airbnb listing', action: 'sync it with Airbnb' })
        if (!enabled?.meta.changes) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
        Object.assign(mapping, { import_stage: 'reservations', enabled: 1 })
        break
      }
      case 'reservations': {
        const receipt = await channexRequest(this.env, `${path}/execute/load_future_reservations`, 'POST', { listing_id: mapping.listing_id })
        // This accepts background work; it is not evidence that every expected guest arrived in the revision feed.
        await executeBatch(this.db, [organizationEventQuery({ organizationId: this.organizationId, actorId: this.userId,
          eventType: 'stay.reservations_import_requested', entityType: 'product', entityId: productId,
          metadata: { provider: 'channex', channel: 'airbnb', listing_id: mapping.listing_id, channel_id: mapping.channel_id, property_id: mapping.property_id, receipt } })], { operation: 'Record Airbnb reservation import request' })
        await save({ import_stage: 'messages' })
        break
      }
      case 'messages': {
        await installChannexMessages(this.env, string(mapping.property_id, 'property_id'))
        await backfillChannexMessages(this.db, this.env, string(mapping.property_id, 'property_id'), this.organizationId)
        await save({ import_stage: 'complete' })
        break
      }
      case 'complete':
        break
    }
    return { product_id: productId, stage: mapping.import_stage, waiting: false, content: contentReport(mapping) }
  }

  /** Airbnb sync is Business: every step that reads from or writes to Airbnb needs it; stopping and disconnecting never do. */
  async requireChannelSync() {
    if (!await hasOrganizationEntitlement(this.env, this.organizationId, 'channel_sync')) fail(403, 'ENTITLEMENT_REQUIRED', 'Airbnb sync comes with the Business plan', { entitlement: 'channel_sync' })
  }

  /**
   * Activate a draft: the plan is checked for one more live home before
   * anything is written to Channex, then the import moves to `mapping` and
   * `advance` carries it to `complete`. An import past `draft` answers where
   * it is, unchanged; one before `draft` is still being built.
   */
  async activate(listingId: string): Promise<{ product_id: string; stage: ImportStage; waiting: false }> {
    const mapping = await this.listingMapping(listingId)
    const productId = mapping.product_id
    if (!mapping.channel_id) fail(409, 'NOT_CONNECTED', 'This home has no connected Airbnb listing.')
    await this.connected(mapping.channel_id)
    const stage = IMPORT_STAGES.indexOf(mapping.import_stage)
    if (stage > IMPORT_STAGES.indexOf('draft')) return { product_id: productId, stage: mapping.import_stage, waiting: false }
    if (stage < IMPORT_STAGES.indexOf('draft')) fail(409, 'IMPORT_IN_PROGRESS', 'Finish importing this listing before activating it.')
    await this.requireChannelSync()
    await requireHomeCapacity(this.env, this.db, this.organizationId, productId)
    const result = await execute(this.db, "UPDATE product_airbnb_listings SET import_stage = 'mapping', updated_at = ? WHERE organization_id = ? AND listing_id = ? AND import_stage = 'draft'", [now(), this.organizationId, listingId])
    if (!result.meta.changes) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
    return { product_id: productId, stage: 'mapping', waiting: false }
  }

  /**
   * Stop syncing a home with Airbnb: undo what Activate turned on and keep the
   * home as a free draft. This listing's rate plan mapping is removed from the
   * channel (Channex passes the removal on to Airbnb) and verified gone, then
   * its property's Messages installation is removed; the channel stays active
   * for the account's other listings. The home, its photos, texts, rates,
   * calendar and stays are kept, and Activate syncs it again, starting with a
   * full sync: a stopped home sends Channex nothing, so what Channex last
   * confirmed is forgotten here. A home already a draft answers as it is; one
   * being imported or activated is refused.
   */
  async deactivate(listingId: string): Promise<{ product_id: string; stage: ImportStage; waiting: false }> {
    const mapping = await this.listingMapping(listingId)
    const productId = mapping.product_id
    if (!mapping.channel_id) fail(409, 'NOT_CONNECTED', 'This home has no connected Airbnb listing.')
    const row = await this.connected(mapping.channel_id)
    const channelId = row.channel_id
    if (mapping.import_stage === 'draft') return { product_id: productId, stage: 'draft', waiting: false }
    if (mapping.import_stage !== 'complete') fail(409, 'IMPORT_IN_PROGRESS', 'This listing is still being imported or activated. Finish that first.')
    const propertyId = string(mapping.property_id, 'property_id')
    const otherChannel = await this.hasOtherChannel(mapping)
    const path = `/channels/${encodeURIComponent(channelId)}`
    const mapped = (await this.channel(row, channelId)).ratePlans.find(entry => entry.rate_plan_id === mapping.rate_plan_id)
    if (mapped) {
      const mappingId = provided(() => string(mapped.id, 'Mapping id'))
      await channexRequest(this.env, `${path}/mappings/${encodeURIComponent(mappingId)}`, 'DELETE')
    }
    if (!otherChannel) await uninstallChannexMessages(this.env, propertyId)
    // The home stops syncing, so it may stop being live: its billing is reported again.
    const [stopped] = await executeWithinCapacity(this.env, this.db, this.organizationId, [{
      query: "UPDATE product_airbnb_listings SET import_stage = 'draft', enabled = 0, updated_at = ? WHERE organization_id = ? AND listing_id = ? AND import_stage = 'complete'",
      params: [now(), this.organizationId, listingId],
    }, ...(otherChannel ? [] : [{
      query: "UPDATE product_channel_mappings SET enabled = 0 WHERE organization_id = ? AND product_id = ?",
      params: [this.organizationId, productId],
    }, { query: "DELETE FROM channel_night_pushes WHERE product_id = ? AND provider = 'channex'", params: [productId] }])], { operation: 'Stop syncing an Airbnb listing', action: 'stop syncing it' })
    if (!stopped?.meta.changes) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
    return { product_id: productId, stage: 'draft', waiting: false }
  }

  /**
   * The content stage again, for a home whose import is complete: one imported
   * before content was carried over, or whose Airbnb content changed. Same
   * work, same report, then the home's calendar is sent.
   */
  async refreshContent(listingId: string): Promise<{ product_id: string; stage: ImportStage; content: ImportContentReport | null; channel_push: SuccessfulChannelPush | null }> {
    await this.requireChannelSync()
    const mapping = await this.listingMapping(listingId)
    const productId = mapping.product_id
    if (!mapping.channel_id) fail(409, 'NOT_CONNECTED', 'This home has no connected Airbnb listing.')
    const row = await this.connected(mapping.channel_id)
    if (mapping.import_stage !== 'complete') fail(409, 'IMPORT_IN_PROGRESS', 'Finish importing this listing first; its content lands at the content stage.')
    if (mapping.listing_rate_plan_id) return { product_id: productId, stage: 'complete', content: contentReport(mapping), channel_push: await this.deliverCalendar(mapping) }
    const { report, written } = await this.importContent(mapping, row.channel_id, Infinity)
    const result = await execute(this.db, "UPDATE product_airbnb_listings SET import_content = ?, import_written = ?, updated_at = ? WHERE organization_id = ? AND listing_id = ? AND import_stage = 'complete'", [JSON.stringify(report), JSON.stringify(written), now(), this.organizationId, listingId])
    if (!result.meta.changes) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
    const home = await readStayHome(this.db, this.manager(), productId)
    await publishBusinessInvalidation(this.env, this.organizationId)
    await publishStayInvalidation(this.env, { type: 'nights.changed', organization_id: this.organizationId, product_id: productId, location_id: home.location_id, booking_id: null }, { updated_at: now() })
    return { product_id: productId, stage: 'complete', content: report, channel_push: await this.deliverCalendar(mapping) }
  }

  /**
   * The listing's content onto the home: its photos in Airbnb's order with
   * their captions, its texts, its counts, its amenities and its check-in
   * method. Each photo is one media asset keyed by Airbnb's image id, so a
   * retry stores none twice; a photo that cannot be fetched stops the stage
   * naming the image. A photo the host has since deleted from the library
   * stays deleted, and photos past the home's limit (the host's own photos
   * counted first) are not fetched; both are reported. A text Airbnb has no
   * value for leaves the home's own alone; one over the home's limit is cut
   * and the cut reported. At most `fetches` photos are fetched: with more to
   * fetch the call ends `done: false` before placing anything, and the next
   * call carries on from the photos already stored. A photo an earlier call of
   * the same stage stored or upgraded is reported as it was then.
   */
  private async importContent(mapping: MappingRow, channelId: string, fetches: number): Promise<{ report: ImportContentReport; done: boolean; written: Record<string, string> }> {
    const content = await listingContent(this.env, channelId, mapping.listing_id)
    const earlier = mapping.import_stage === 'content' ? contentReport(mapping) : null
    const budget = { left: fetches }
    let pending = false
    const report: ImportContentReport = { photos_imported: [], photos_skipped: [], photos_upgraded: [], photos_removed: [], photos_unplaced: [], unmatched_amenities: [], unmapped_check_in_category: null, truncated_fields: [], photo_rooms_skipped: content.rooms.length, kept_host_edits: [] }
    const access = this.manager()
    const home = await readStayHome(this.db, access, mapping.product_id)
    if (content.currency !== home.currency) fail(422, 'CURRENCY_MISMATCH', 'The Airbnb listing currency differs from the canonical home currency.')

    // What an earlier run stored, before anything is fetched: the room left for new photos is the home's limit less the host's other photos.
    const stored = new Map<string, string>()
    for (const image of content.images) {
      try {
        const replay = await getMediaUploadReplay(this.db, { organizationId: this.organizationId, idempotencyKey: `airbnb-photo:${mapping.listing_id}:${image.id}`, sourceFileId: image.id })
        if (replay) stored.set(image.id, replay.assetId)
      } catch (error) {
        if (!(error instanceof HTTPError && error.status === 410)) throw error
        report.photos_removed.push(image.id)
      }
    }
    // A photo already on the home keeps its place; every other one, stored by an interrupted run or new, takes one of the places left.
    const onHome = new Set(home.photos.map(photo => photo.id))
    let capacity = MAX_ORDERED_MEDIA_ASSETS - home.photos.length
    const assetIds: string[] = []
    for (const image of content.images) {
      if (report.photos_removed.includes(image.id)) continue
      const assetId = stored.get(image.id)
      if (assetId && onHome.has(assetId)) {
        if (!await this.keep(assetId, image, report, budget, earlier)) { pending = true; break }
        assetIds.push(assetId)
        continue
      }
      if (capacity <= 0) {
        report.photos_unplaced.push(image.id)
        continue
      }
      capacity -= 1
      if (assetId) {
        if (!await this.keep(assetId, image, report, budget, earlier)) { pending = true; break }
        assetIds.push(assetId)
        continue
      }
      if (budget.left <= 0) { pending = true; break }
      budget.left -= 1
      const identity = { idempotencyKey: `airbnb-photo:${mapping.listing_id}:${image.id}`, sourceFileId: image.id }
      const photo = await this.photo(image)
      // Imported photos live in R2 in every environment; Cloudflare Images holds credentials in production only.
      const uploaded = await uploadResolvedMediaToAssetStore({
        db: this.db, env: this.env, organizationId: this.organizationId, userId: null, source: 'external', kind: 'image', provider: 'cloudflare_r2',
        ...photo, idempotencyKey: identity.idempotencyKey, sourceFileId: identity.sourceFileId,
      })
      await this.caption(uploaded.assetId, image)
      assetIds.push(uploaded.assetId)
      report.photos_imported.push(image.id)
    }
    if (pending) return { report, done: false, written: {} }
    if (assetIds.length) {
      const membership = await resolveOrganizationMembership(this.env, { organizationId: this.organizationId, userId: this.userId })
      if (!membership) fail(403, 'NOT_A_MEMBER', 'Only a member of this organization can import listing content')
      await placeStayHomePhotosFirst(this.db, this.env, access, memberAccessPrincipal(membership, { env: this.env }), mapping.product_id, assetIds)
    }

    const within = (field: string, text: string, limit: number): string => {
      if (text.length <= limit) return text
      report.truncated_fields.push({ field, limit, length: text.length })
      return text.slice(0, limit).trimEnd()
    }
    const written: Record<string, string> = mapping.import_written ? JSON.parse(mapping.import_written) as Record<string, string> : {}
    const body: Record<string, unknown> = {}
    if (written.min_nights !== undefined) body.min_nights = content.minimum_nights
    else report.kept_host_edits.push('min_nights')
    if (written.calendar_rules !== undefined || stayChannelCalendarRules(home.calendar_rules) === null) body.calendar_rules = content.calendar_rules
    else report.kept_host_edits.push('calendar_rules')
    const texts = content.descriptions
    // Airbnb's Listing description is the home's description; Airbnb's other texts are the home's sections of the same names.
    if (texts.summary) body.description = within('description', texts.summary.trim(), PRODUCT_LIMITS.description)
    const details: Partial<Record<ProductDetailKey, string | boolean | null>> = {}
    for (const [key, source] of DESCRIPTION_DETAILS) {
      const text = texts[source]?.trim()
      if (text) details[key] = within(key, text, PRODUCT_LIMITS.description)
    }
    for (const [key, allowed] of [['pets_allowed', content.guestControls.pets], ['events_allowed', content.guestControls.events], ['smoking_allowed', content.guestControls.smoking]] as const) {
      if (allowed !== null) details[key] = allowed
    }
    if (content.quietHours !== null) {
      Object.assign(details, content.quietHours === false
        ? { quiet_hours: false, quiet_hours_start: null, quiet_hours_end: null }
        : { quiet_hours: true, quiet_hours_start: content.quietHours.start, quiet_hours_end: content.quietHours.end })
    }
    // The import guard below preserves host edits; unknown provider values stay null.
    Object.assign(body, { check_in_time: content.check_in_time, check_in_end_time: content.check_in_end_time, check_out_time: content.check_out_time })
    const arrival: Record<keyof typeof STAY_ARRIVAL_TEXT_LIMITS, string | null> = {
      check_in_instructions: paragraphs(content.checkInOption?.instruction),
      house_manual: paragraphs(content.houseManual), directions: paragraphs(content.directions),
      wifi_network: paragraphs(content.wifiNetwork), wifi_password: content.wifiPassword,
    }
    for (const [field, text] of Object.entries(arrival) as Array<[keyof typeof STAY_ARRIVAL_TEXT_LIMITS, string | null]>) {
      if (text) body[field] = within(field, text, STAY_ARRIVAL_TEXT_LIMITS[field])
    }
    for (const field of ['bedrooms', 'beds', 'bathrooms'] as const) if (content[field] !== null) body[field] = content[field]
    if (content.amenities.length) {
      const matched: StayAmenity[] = []
      for (const key of content.amenities) {
        const code = key.toLowerCase()
        if (isStayAmenity(code)) matched.push(code)
        else report.unmatched_amenities.push(key)
      }
      // Nothing Airbnb names is in the vocabulary: the host's own amenities stay as they are.
      if (matched.length) body.amenities = [...new Set(matched)]
    }
    if (content.checkInOption) {
      const method = CHECK_IN_METHODS[content.checkInOption.category]
      if (method) body.check_in_method = method
      else report.unmapped_check_in_category = content.checkInOption.category
    }
    // A field the host changed since Airbnb's value was last written here keeps the host's value: only a
    // field still holding what the last run wrote, or one never written, takes Airbnb's.
    const current: Record<string, unknown> = { ...home, calendar_rules: stayChannelCalendarRules(home.calendar_rules), ...(await getProduct(this.db, this.organizationId, mapping.product_id)).details }
    const unedited = async <T extends Record<string, unknown>>(values: T): Promise<Partial<T>> => {
      const kept: Partial<T> = {}
      for (const [field, value] of Object.entries(values) as Array<[keyof T & string, T[keyof T & string]]>) {
        const currentHash = await fingerprint(current[field])
        if (written[field] !== undefined && written[field] !== currentHash) {
          report.kept_host_edits.push(field)
          continue
        }
        written[field] = await fingerprint(value)
        if (written[field] !== currentHash) kept[field] = field === 'calendar_rules' && home.calendar_rules?.direct_discounts
          ? { ...content.calendar_rules, direct_discounts: home.calendar_rules.direct_discounts } as T[keyof T & string]
          : value
      }
      return kept
    }
    const homeWrite = await unedited(body)
    const detailsWrite = await unedited(details)
    const stayImport = { channelId, listingId: mapping.listing_id, written }
    if (Object.keys(homeWrite).length) await updateStayHome(this.env, this.db, access, mapping.product_id, homeWrite, stayImport)
    if (Object.keys(detailsWrite).length) {
      await updateProduct(this.db, { organizationId: this.organizationId, productId: mapping.product_id, patch: { details_mode: 'merge', details: detailsWrite }, actor: { actorId: this.userId }, env: this.env, stayImport })
    }
    return { report, done: true, written }
  }

  /**
   * A photo an earlier run stored: its caption resumed if that write never
   * landed, and, when it was stored before photos were fetched at full width
   * (no recorded width), its file fetched again at 2560 px into the same
   * asset, so its place, caption and rooms stay. False when that fetch is
   * past this call's budget.
   */
  private async keep(assetId: string, image: ListingImage, report: ImportContentReport, budget: { left: number }, earlier: ImportContentReport | null): Promise<boolean> {
    await this.caption(assetId, image)
    const asset = await getMediaAsset(this.db, assetId, this.organizationId)
    if (!asset) throw new Error(`Airbnb photo ${image.id} was stored as ${assetId} but cannot be read back`)
    if (asset.width !== null) {
      // Stored or upgraded by an earlier call of this same stage: reported as that call did.
      if (earlier?.photos_imported.includes(image.id)) report.photos_imported.push(image.id)
      else if (earlier?.photos_upgraded.includes(image.id)) report.photos_upgraded.push(image.id)
      else report.photos_skipped.push(image.id)
      return true
    }
    if (budget.left <= 0) return false
    budget.left -= 1
    // Count the photo when the saved asset names the new file.
    await replaceR2ImageFile({ db: this.db, env: this.env, organizationId: this.organizationId, assetId, ...await this.photo(image), onSwitched: () => report.photos_upgraded.push(image.id) })
    return true
  }


  /**
   * Airbnb's caption as the asset's own description, written after the asset
   * exists (so a changed caption never changes the asset's identity) and only
   * while the asset has none, in the write itself: a run interrupted before
   * this write resumes it, and a caption the host wrote, even meanwhile, is theirs.
   */
  private async caption(assetId: string, image: ListingImage): Promise<void> {
    if (!image.caption) return
    if (await updateMediaAssetMetadata(this.db, assetId, this.organizationId, { alt_text: image.caption.trim().slice(0, 500) }, undefined, true)) return
    // Not written: the asset already has a description, or it is gone.
    if (!await getMediaAsset(this.db, assetId, this.organizationId)) throw new Error(`Airbnb photo ${image.id} was stored as ${assetId} but cannot be read back`)
  }

  /**
   * One Airbnb photo at 2560 px: an image of a supported type within the home
   * photo size limit, whose header states its size; the body is never read
   * past that limit. Any failure names the image and the URL tried, and no
   * smaller size is taken instead.
   */
  private async photo(image: ListingImage): Promise<{ buffer: Uint8Array<ArrayBuffer>; contentType: string; filename: string; width: number; height: number }> {
    const detail = { image_id: image.id, url: image.url }
    const tooLarge = () => fail(502, 'PHOTO_FETCH_FAILED', `Airbnb photo ${image.id} exceeds ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`, detail)
    let response: Response
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      response = await fetch(image.url, { redirect: 'follow' })
      if (!response.ok) fail(502, 'PHOTO_FETCH_FAILED', `Airbnb answered ${response.status} for photo ${image.id} at ${image.url}. Retry the import.`, detail)
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) tooLarge()
      const reader = response.body?.getReader()
      for (let chunk = reader ? await reader.read() : { done: true as const, value: undefined }; !chunk.done; chunk = await reader!.read()) {
        total += chunk.value.byteLength
        if (total > MAX_IMAGE_BYTES) {
          await reader!.cancel()
          tooLarge()
        }
        chunks.push(chunk.value)
      }
    } catch (error) {
      if (error instanceof HTTPError) throw error
      fail(502, 'PHOTO_FETCH_FAILED', `Airbnb photo ${image.id} could not be fetched from ${image.url}: ${error instanceof Error ? error.message : String(error)}. Retry the import.`, detail)
    }
    if (!total) fail(502, 'PHOTO_FETCH_FAILED', `Airbnb photo ${image.id} is empty. Retry the import.`, detail)
    const buffer = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      buffer.set(chunk, offset)
      offset += chunk.byteLength
    }
    const contentType = sniffMediaMimeType(buffer)
    if (!RESOLVED_MEDIA_IMAGE_TYPES.has(contentType)) fail(502, 'PHOTO_FETCH_FAILED', `Airbnb photo ${image.id} is not a supported image (${contentType}).`, detail)
    const size = imagePixelSize(buffer)
    if (!size) fail(502, 'PHOTO_FETCH_FAILED', `Airbnb photo ${image.id} does not state its size (${contentType}).`, detail)
    return { buffer, contentType, ...size, filename: `airbnb-${image.id}-w${PHOTO_WIDTH}.${contentType === 'image/jpeg' ? 'jpg' : contentType.slice('image/'.length).replace('+xml', '')}` }
  }

  /** Install Messages on a connected home's property and import its conversations. */
  async syncMessages(productId: string): Promise<{ threads: number }> {
    await this.requireChannelSync()
    const mapping = await queryFirst<MappingRow>(this.db, "SELECT * FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [this.organizationId, productId])
    if (!mapping || mapping.enabled !== 1 || !mapping.property_id) fail(409, 'CHANNEL_PROPERTY_NOT_READY', 'Connect this home before importing conversations')
    await installChannexMessages(this.env, mapping.property_id)
    return backfillChannexMessages(this.db, this.env, mapping.property_id, this.organizationId)
  }

  /** Resend a connected home's calendar without changing its Airbnb mapping or Messages installation. */
  async syncFullCalendar(productId: string): Promise<{ product_id: string; channel_push: SuccessfulChannelPush }> {
    await this.requireChannelSync()
    const mapping = await queryFirst<MappingRow>(this.db, "SELECT * FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [this.organizationId, productId])
    if (!mapping) fail(404, 'IMPORT_NOT_FOUND', 'Listing import not found')
    if (mapping.import_stage !== 'complete' || mapping.enabled !== 1) fail(409, 'CHANNEL_PROPERTY_NOT_READY', 'Finish connecting this home before syncing its full calendar.')
    for (const field of ['property_id', 'room_type_id', 'rate_plan_id'] as const) string(mapping[field], field)
    const pushed = await this.deliverCalendar(mapping, true)
    return { product_id: productId, channel_push: pushed }
  }

  private async listingMapping(listingId: string): Promise<MappingRow> {
    const mapping = await queryFirst<MappingRow>(this.db, `SELECT * FROM ${AIRBNB_MAPPINGS} WHERE organization_id = ? AND listing_id = ?`, [this.organizationId, listingId])
    if (!mapping) fail(404, 'IMPORT_NOT_FOUND', 'Listing import not found')
    return mapping
  }

  private async saveListing(mapping: MappingRow, values: Pick<MappingProgress, 'import_stage' | 'import_content' | 'import_written'>): Promise<void> {
    const entries = Object.entries(values)
    const result = await execute(this.db, `UPDATE product_airbnb_listings SET ${entries.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ?
      WHERE organization_id = ? AND listing_id = ? AND import_stage = ?`, [...entries.map(([, value]) => value), now(), this.organizationId, mapping.listing_id, mapping.listing_stage])
    if (!result.meta.changes) fail(409, 'IMPORT_CHANGED', 'The listing changed. Refresh and try again.')
    Object.assign(mapping, values, values.import_stage ? { listing_stage: values.import_stage } : {})
  }

  private async hasOtherChannel(mapping: MappingRow): Promise<boolean> {
    const other = await queryFirst(this.db, 'SELECT 1 FROM product_airbnb_listings WHERE organization_id = ? AND product_id = ? AND listing_id <> ? AND enabled = 1',
      [this.organizationId, mapping.product_id, mapping.listing_id])
    return Boolean(other) || await this.hasVrbo(mapping)
  }

  private async saveMapping(mapping: InventoryMapping, values: MappingProgress, created?: {
    column: 'property_id' | 'room_type_id' | 'rate_plan_id'
    collection: string
    id: string
  }): Promise<void> {
    const entries = Object.entries(values)
    const result = await execute(this.db, `UPDATE product_channel_mappings SET ${entries.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ?
      WHERE organization_id = ? AND product_id = ? AND provider = 'channex' AND import_stage = ?`,
    [...entries.map(([, value]) => value ?? null), now(), this.organizationId, mapping.product_id, mapping.import_stage])
    if (!result.meta.changes) {
      if (created) {
        const winner = await queryFirst<InventoryMapping>(this.db, `SELECT * FROM product_channel_mappings
          WHERE organization_id = ? AND product_id = ? AND provider = 'channex'`, [this.organizationId, mapping.product_id])
        if (winner?.[created.column] !== created.id) {
          await channexRequest(this.env, `/${created.collection}/${encodeURIComponent(created.id)}`, 'DELETE')
        }
      }
      fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
    }
    Object.assign(mapping, values)
  }

  /** Build the provider property, room and rate, then verify the inventory shared by its channels. */
  private async advanceInventory(row: Pick<ConnectionRow, 'group_id' | 'channel_id'>, mapping: InventoryMapping): Promise<boolean> {
    const productId = mapping.product_id
    const stage = mapping.import_stage
    const required = stage === 'property' ? [] : stage === 'room' ? [mapping.property_id] : stage === 'rate' ? [mapping.property_id, mapping.room_type_id] : [mapping.property_id, mapping.room_type_id, mapping.rate_plan_id]
    if (required.some(id => !id)) throw new Error(`Home ${productId} at ${stage} is missing a Channex id`)
    const property = mapping.import_property ? JSON.parse(mapping.import_property) as ImportProperty : null
    const groupId = string(row.group_id, 'group_id')
    switch (stage) {
      case 'property': {
        if (!property) throw new Error(`Import of ${productId} has no approved listing details`)
        const sent = {
          currency: property.currency, timezone: property.timezone, property_type: property.property_type, email: property.email, phone: property.phone,
          country: property.country, state: property.state, city: property.city, address: property.address, zip_code: property.zip_code,
        }
        const earlier = await this.createdProperty(property.title, groupId, sent)
        const created = earlier ? { id: earlier } : await channexCreate(this.env, '/properties', { property: {
          title: property.title, group_id: groupId, ...sent, settings: { state_length: STAY_CALENDAR_DAYS, min_stay_type: 'arrival' },
        } }, 'property')
        await this.saveMapping(mapping, { property_id: created.id, import_stage: 'room' },
          earlier ? undefined : { column: 'property_id', collection: 'properties', id: created.id })
        break
      }
      case 'room': {
        if (!property) throw new Error(`Import of ${productId} has no approved listing details`)
        // Blawby creates one room type in each property it creates, so any room type it holds is that one.
        const earlier = await channexList(this.env, '/room_types', 'room_type', { 'filter[property_id]': mapping.property_id! })
        if (earlier.length > 1) fail(502, 'PROVIDER_STATE_AMBIGUOUS', `Channex has ${earlier.length} room types in property ${mapping.property_id}, which Blawby created with one.`)
        if (earlier[0] && provided(() => relationship(earlier[0]!, 'property')) !== mapping.property_id) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Channex returned a room type of a different property')
        const created = earlier[0] ?? await channexCreate(this.env, '/room_types', { room_type: {
          property_id: mapping.property_id, title: 'Entire home', count_of_rooms: 1, occ_adults: property.max_guests,
          // Channex's child-only beds and infant cots; Airbnb counts neither, and Channex says to send 0 when there are none.
          occ_children: 0, occ_infants: 0, default_occupancy: property.default_occupancy, room_kind: 'room',
        } }, 'room_type')
        await this.saveMapping(mapping, { room_type_id: created.id, import_stage: 'rate' },
          earlier[0] ? undefined : { column: 'room_type_id', collection: 'room_types', id: created.id })
        break
      }
      case 'rate': {
        if (!property) throw new Error(`Import of ${productId} has no approved listing details`)
        const home = await readStayHome(this.db, this.manager(), productId)
        // Blawby creates one rate plan in each property it creates, so any rate plan it holds is that one.
        const options = await channexRequest(this.env, `/rate_plans/options?${new URLSearchParams({ 'filter[property_id]': mapping.property_id! })}`)
        const earlier = provided(() => {
          if (!Array.isArray(options.data)) throw new ChannexDataError('rate plan options must be a list')
          return options.data.map(value => object(value, 'rate plan option')).filter(option => object(option.attributes, 'rate plan option attributes').property_id === mapping.property_id)
        })
        if (earlier.length > 1) fail(502, 'PROVIDER_STATE_AMBIGUOUS', `Channex has ${earlier.length} rate plans in property ${mapping.property_id}, which Blawby created with one.`)
        if (earlier[0] && object(earlier[0].attributes, 'rate plan option attributes').room_type_id !== mapping.room_type_id) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Channex returned a rate plan of a different room type')
        const created = earlier[0] ? { id: provided(() => string(earlier[0]!.id, 'rate plan id')) } : await channexCreate(this.env, '/rate_plans', { rate_plan: {
          property_id: mapping.property_id, room_type_id: mapping.room_type_id, title: 'Standard rate', currency: property.currency,
          rate_mode: 'manual', sell_mode: 'per_room', min_stay_arrival: calendarMinimumDefaults(home),
          options: [{ occupancy: property.default_occupancy, is_primary: true, rate: property.nightly_rate }],
        } }, 'rate_plan')
        await this.saveMapping(mapping, { rate_plan_id: created.id, import_stage: 'inventory' },
          earlier[0] ? undefined : { column: 'rate_plan_id', collection: 'rate_plans', id: created.id })
        break
      }
      case 'inventory': {
        // The full sync: the home's calendar ahead through the delivery outbox, as every
        // night change goes, to a rate plan Channex has nothing confirmed for yet (a new
        // property has no outbox rows; a reconnect emptied them). One restrictions and
        // one availability call, each logged with its task; a stage asked again sends
        // what is due, honouring the outbox's retry times.
        const waiting = (await this.deliverCalendar(mapping)).state === 'pending'
        if (waiting) return true
        await this.saveMapping(mapping, { import_stage: 'verify_inventory' })
        break
      }
      case 'verify_inventory': {
        const matches = await this.inventoryMatches(mapping as InventoryMapping & ChannexMapping)
        if (!matches) return true
        await this.saveMapping(mapping, { import_stage: 'complete', import_property: null })
        break
      }
      default: throw new Error(`Home ${productId} cannot provision inventory at ${stage}`)
    }
    return false
  }

  /** A hosted channel uses the home's own property and inventory, including homes created in Blawby. */
  async prepareHostedProperty(productId: string): Promise<string | null> {
    await requireStays(this.db, this.organizationId)
    const home = await readStayHome(this.db, this.manager(), productId)
    let mapping = await queryFirst<InventoryMapping & { enabled: number }>(this.db, `SELECT * FROM product_channel_mappings
      WHERE organization_id = ? AND product_id = ? AND provider = 'channex'`, [this.organizationId, productId])
    if (mapping?.enabled && (mapping.import_stage === 'complete' || mapping.import_stage === 'draft')) return string(mapping.property_id, 'property_id')
    if (mapping && await queryFirst(this.db, "SELECT 1 FROM product_airbnb_listings WHERE organization_id = ? AND product_id = ? AND import_stage <> 'complete'", [this.organizationId, productId])) fail(409, 'CHANNEL_MAPPING_IN_PROGRESS', 'Finish activating this home in Airbnb before adding Vrbo.')
    await requireHomeCapacity(this.env, this.db, this.organizationId, productId)
    if (!mapping) {
      if (home.base_price_minor === null) fail(422, 'PRICE_REQUIRED', 'Set the home’s base nightly price before connecting it to Channex.', { field: 'base_price_minor' })
      const contact = await this.organizationContact()
      const address = home.address
      const digits = currencyFractionDigits(home.currency)
      const property: ImportProperty = {
        title: `${home.name} (${productId})`, currency: home.currency, timezone: home.timezone, property_type: 'holiday_home',
        ...(contact.email ? { email: contact.email } : {}), ...(contact.phone ? { phone: contact.phone } : {}),
        ...(address ? { address: address.address, country: address.country, city: address.city ?? undefined, state: address.state ?? undefined, zip_code: address.zip_code ?? undefined } : {}),
        max_guests: home.max_guests, default_occupancy: home.max_guests,
        nightly_rate: (home.base_price_minor / 10 ** digits).toFixed(digits),
      }
      const importProperty = JSON.stringify(property)
      await execute(this.db, `INSERT INTO product_channel_mappings (organization_id, product_id, provider, import_stage, import_property)
        VALUES (?, ?, 'channex', 'property', ?)`, [this.organizationId, productId, importProperty])
      mapping = { product_id: productId, property_id: null, room_type_id: null, rate_plan_id: null, import_stage: 'property', import_property: importProperty, enabled: 0 }
    }
    if (mapping.import_stage === 'complete') {
      if ((await this.deliverCalendar(mapping)).state === 'pending') return null
      if (!await this.inventoryMatches(mapping as InventoryMapping & ChannexMapping)) return null
    }
    const groupId = mapping.import_stage === 'complete' ? null : await this.ensureGroup()
    while (mapping.import_stage !== 'complete') {
      if (await this.advanceInventory({ group_id: groupId, channel_id: null }, mapping)) return null
    }
    return string(mapping.property_id, 'property_id')
  }

  /** Re-read Channex after hosted setup or removal and release inventory with no active channel. */
  async finishHostedProperty(productId: string, channelCode?: typeof VRBO_CHANNEL): Promise<boolean> {
    await requireStays(this.db, this.organizationId)
    await readStayHome(this.db, this.manager(), productId)
    const mapping = await queryFirst<{ property_id: string; rate_plan_id: string; enabled: number }>(this.db, `SELECT property_id, rate_plan_id, enabled
      FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'
        AND import_stage IN ('draft', 'complete')`, [this.organizationId, productId])
    if (!mapping) fail(404, 'CHANNEL_MAPPING_NOT_FOUND', 'Prepare this home in Channex before completing setup.')
    const channels = await propertyChannels(this.env, mapping.property_id, channelCode)
    const active = Number(channels.some(channel => mapsActiveRate(channel, mapping.rate_plan_id)))
    if (!active && await queryFirst(this.db, 'SELECT 1 FROM product_airbnb_listings WHERE organization_id = ? AND product_id = ? AND enabled = 1', [this.organizationId, productId])) return true
    if ((channelCode && !active) || mapping.enabled === active) return Boolean(active)
    const [changed] = await executeWithinCapacity(this.env, this.db, this.organizationId, [{
      query: `UPDATE product_channel_mappings SET enabled = ?, import_property = NULL, updated_at = ?
        WHERE organization_id = ? AND product_id = ? AND provider = 'channex' AND enabled = ?`,
      params: [active, now(), this.organizationId, productId, mapping.enabled],
    }], { operation: 'Update sync for a hosted Channex channel', action: 'update its Channex connection' })
    if (!changed?.meta.changes) fail(409, 'IMPORT_CHANGED', 'The home changed. Refresh and try again.')
    return Boolean(active)
  }

  /** Send the configured home's calendar through the outbox: one restrictions call and one availability call. */
  private async deliverCalendar(mapping: InventoryMapping, fullSync = false): Promise<SuccessfulChannelPush> {
    if ('listing_rate_plan_id' in mapping && mapping.listing_rate_plan_id !== null) {
      const shared = await queryFirst<InventoryMapping>(this.db, `SELECT * FROM product_channel_mappings
        WHERE organization_id = ? AND product_id = ? AND provider = 'channex'`, [this.organizationId, mapping.product_id])
      if (!shared) fail(409, 'CHANNEL_PROPERTY_NOT_READY', 'This listing has no shared inventory.')
      mapping = shared
    }
    const target = { property_id: string(mapping.property_id, 'property_id'), room_type_id: string(mapping.room_type_id, 'room_type_id'), rate_plan_id: string(mapping.rate_plan_id, 'rate_plan_id') }
    await configureStayCalendar(this.db, this.env, this.organizationId, await readStayHome(this.db, this.manager(), mapping.product_id), target)
    if (fullSync) await forgetConfirmedNights(this.db, mapping.product_id)
    const pushed = await syncStayCalendar(this.db, this.env, this.manager(), mapping.product_id, target)
    if (pushed.state === 'needs_review') fail(502, 'PROVIDER_VERIFICATION_FAILED', `Channex rejected part of the calendar: ${pushed.detail}`)
    return pushed
  }

  /** Whether Channex now reads every night the full sync sent it; a new rate plan reads zero until its update is applied, which is "not yet", not an error. */
  private async inventoryMatches(mapping: InventoryMapping & ChannexMapping): Promise<boolean> {
    const sent = await queryAll<{ date: string; sent_json: string }>(this.db, "SELECT date, sent_json FROM channel_night_pushes WHERE product_id = ? AND provider = 'channex' AND state = 'pushed' AND sent_json IS NOT NULL ORDER BY date", [mapping.product_id])
    if (!sent.length) throw new Error(`Import of ${mapping.product_id} has no delivered calendar to verify`)
    const query = new URLSearchParams({ 'filter[property_id]': mapping.property_id, 'filter[date][gte]': sent[0]!.date, 'filter[date][lte]': sent.at(-1)!.date })
    const availability = await channexRequest(this.env, `/availability?${query}`)
    query.set('filter[restrictions]', 'rate,min_stay_arrival,max_stay,closed_to_arrival,closed_to_departure,stop_sell')
    const restrictions = await channexRequest(this.env, `/restrictions?${query}`)
    return provided(() => {
      const available = object(object(availability.data, 'availability')[mapping.room_type_id], 'room type availability')
      const rates = object(object(restrictions.data, 'restrictions')[mapping.rate_plan_id], 'rate plan restrictions')
      return sent.every((night) => {
        const values = object(JSON.parse(night.sent_json), `sent values for ${night.date}`)
        const count = available[night.date]
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new ChannexDataError(`availability on ${night.date} must be a non-negative integer`)
        const rule = object(rates[night.date], `restrictions on ${night.date}`)
        const rate = Number(rule.rate)
        if (!Number.isFinite(rate) || rate < 0) throw new ChannexDataError(`rate on ${night.date} must be a non-negative number`)
        return count === values.availability && rate === Number(values.rate) && rule.min_stay_arrival === values.min_stay_arrival
          && rule.max_stay === values.max_stay && rule.closed_to_arrival === values.closed_to_arrival && rule.closed_to_departure === values.closed_to_departure && rule.stop_sell === values.stop_sell
      })
    })
  }

  private async hasVrbo(mapping: InventoryMapping): Promise<boolean> {
    const { property_id: propertyId } = mapping
    const ratePlanId = 'listing_rate_plan_id' in mapping && mapping.listing_rate_plan_id !== null
      ? (await queryFirst<{ rate_plan_id: string }>(this.db, "SELECT rate_plan_id FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [this.organizationId, mapping.product_id]))?.rate_plan_id
      : mapping.rate_plan_id
    if (propertyId === null || !ratePlanId) return false
    const channels = await propertyChannels(this.env, propertyId, VRBO_CHANNEL)
    return channels.some(channel => mapsActiveRate(channel, ratePlanId))
  }

  /**
   * Ask to disconnect: the connection is marked disconnecting, so no sync,
   * import or calendar step starts on it, and the AIRBNB_SYNC queue runs the
   * disconnect between the steps already queued. `disconnected: false` means
   * it is under way; the connection status reads not_connected when it is done.
   */
  async disconnect(channelId: string, retry = false): Promise<{ disconnected: boolean }> {
    const row = await this.account(channelId)
    if (!row) fail(404, 'AIRBNB_ACCOUNT_NOT_FOUND', 'That Airbnb account is not connected to this organization.')
    if (row.status === 'disconnecting') return { disconnected: false }
    if (row.status !== 'connected') fail(409, 'DISCONNECT_UNAVAILABLE', 'The Airbnb connection is not ready to disconnect.')
    if (row.disconnect_error && !retry) fail(409, 'DISCONNECT_FAILED', row.disconnect_error)
    const started = await execute(this.db, `UPDATE channex_connections SET status = 'disconnecting', disconnect_error = NULL, updated_at = ?
      WHERE organization_id = ? AND channel_id = ? AND status = 'connected' AND disconnect_error IS ?`,
    [now(), this.organizationId, channelId, row.disconnect_error])
    if (!started.meta.changes) {
      const current = await this.account(channelId)
      if (!current?.channel_id) return { disconnected: true }
      if (current.channel_id === channelId) {
        if (current.status === 'disconnecting') return { disconnected: false }
        if (current.disconnect_error) fail(409, 'DISCONNECT_FAILED', current.disconnect_error)
      }
      fail(409, 'DISCONNECT_CHANGED', 'The Airbnb connection changed. Refresh and try again.')
    }
    try {
      await publishAirbnbSync(this.env, { type: 'airbnb.disconnect', organization_id: this.organizationId, user_id: this.userId, channel_id: channelId })
    } catch (cause) {
      await this.disconnectFailed(channelId, cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
    return { disconnected: false }
  }

  /**
   * One step of the disconnect asked for `channelId`, run by the AIRBNB_SYNC
   * queue: removes one mapping per call, then deactivates the channel, deletes
   * the setup property and the channel. False means another step remains. A
   * delivery for a disconnect no longer asked for (a later reconnect, a failed
   * step) does nothing.
   */
  async disconnectStep(channelId: string): Promise<boolean> {
    const row = await this.account(channelId)
    if (!row || row.status !== 'disconnecting' || row.channel_id !== channelId) return true
    const path = `/channels/${encodeURIComponent(channelId)}`
    // An earlier step may have deleted the channel before saving that it had.
    if (!await this.present(path, 'channel')) return await this.disconnected(row, channelId)
    const channel = await this.channel(row, channelId)
    const first = channel.ratePlans[0]
    if (first !== undefined) {
      const mappingId = provided(() => string(first.id, 'Mapping id'))
      await channexRequest(this.env, `${path}/mappings/${encodeURIComponent(mappingId)}`, 'DELETE')
      // The home stops syncing once its Airbnb mapping is gone, so it may stop being live: the counts are reported again.
      await this.stopSyncing(channelId, String(first.rate_plan_id))
      return false
    }
    if (channel.active) await channexRequest(this.env, `${path}/deactivate`, 'POST')
    return await this.disconnected(row, channelId)
  }

  private async stopSyncing(channelId: string, ratePlanId: string | null): Promise<void> {
    const mappings = (await this.mappings()).filter(mapping => mapping.channel_id === channelId && mapping.enabled === 1
      && (ratePlanId === null || mapping.rate_plan_id === ratePlanId))
    if (!mappings.length) return
    const keepingInventory = await Promise.all(mappings.map(mapping => this.hasVrbo(mapping)))
    await executeWithinCapacity(this.env, this.db, this.organizationId, [
      {
        query: `UPDATE product_airbnb_listings SET enabled = 0, import_stage = 'draft', updated_at = ?
          WHERE organization_id = ? AND channel_id = ? AND listing_id IN (SELECT value FROM json_each(?))`,
        params: [now(), this.organizationId, channelId, d1JsonStringSet(mappings.map(mapping => mapping.listing_id))],
      },
      {
        query: `UPDATE product_channel_mappings AS i SET enabled = 0 WHERE organization_id = ?
          AND product_id IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (SELECT 1 FROM product_airbnb_listings l WHERE l.organization_id = i.organization_id AND l.product_id = i.product_id AND l.enabled = 1)`,
        params: [this.organizationId, d1JsonStringSet(mappings.filter((_, index) => !keepingInventory[index]).map(mapping => mapping.product_id))],
      },
    ], { operation: 'Disconnect Airbnb listings', action: 'disconnect them' })
  }

  /** A disconnect step failed: the connection reads as it is now, with the reason, and Disconnect can be asked again. */
  async disconnectFailed(channelId: string, reason: string): Promise<void> {
    await execute(this.db, `UPDATE channex_connections SET status = 'connected', disconnect_error = ?, updated_at = ?
      WHERE organization_id = ? AND status = 'disconnecting' AND channel_id = ?`, [reason, now(), this.organizationId, channelId])
  }

  /** The channel's last steps; the connection reads not connected only once every one of them is done. */
  private async disconnected(row: ConnectionRow, channelId: string): Promise<true> {
    await this.stopSyncing(channelId, null)
    if (row.setup_property_id) {
      const setupPath = `/properties/${encodeURIComponent(row.setup_property_id)}`
      if (await this.present(setupPath, 'property')) await channexRequest(this.env, `${setupPath}?force=true`, 'DELETE')
    }
    const channelPath = `/channels/${encodeURIComponent(channelId)}`
    if (await this.present(channelPath, 'channel')) await channexRequest(this.env, channelPath, 'DELETE')
    await execute(this.db, 'DELETE FROM channex_connections WHERE organization_id = ? AND id = ?', [this.organizationId, row.id])
    return true
  }

  /**
   * Before the organization is deleted: deletes every property in the
   * organization's dedicated group with `force=true` and the group itself. An
   * organization with an Airbnb channel is refused until Disconnect, which runs
   * on the AIRBNB_SYNC queue, has removed it: with no channel no queued step
   * writes to Channex, so nothing here overlaps one. A property mapped here but
   * outside the group must already be gone. Any failure keeps the organization.
   */
  async deleteForOrganization(): Promise<void> {
    const rows = await this.rows()
    const group = await queryFirst<{ group_id: string }>(this.db, 'SELECT group_id FROM channex_groups WHERE organization_id = ?', [this.organizationId])
    // Better Auth's organization delete answers only its own APIError with this message.
    if (rows.some(row => row.channel_id || row.status === 'authorizing' || row.status === 'disconnecting')) throw new APIError('CONFLICT', { code: 'AIRBNB_CONNECTED', message: 'Disconnect Airbnb in Integrations → Airbnb before deleting this business.' })
    const mapped = (await queryAll<{ property_id: string }>(this.db, 'SELECT property_id FROM product_channel_mappings WHERE organization_id = ? AND property_id IS NOT NULL', [this.organizationId])).map(mapping => mapping.property_id)
    mapped.push(...rows.flatMap(row => row.setup_property_id ? [row.setup_property_id] : []))
    if (!group) {
      if (mapped.length) fail(500, 'INVALID_CONNECTION_MAPPING', 'This organization maps Channex properties without its Channex group.')
      return
    }
    const groupPath = `/groups/${encodeURIComponent(group.group_id)}`
    const resource = await this.present(groupPath, 'group')
    const grouped = resource ? provided(() => {
      const data = object(object(resource.relationships, 'group.relationships').properties, 'group.relationships.properties').data
      if (!Array.isArray(data)) throw new ChannexDataError('group.relationships.properties.data must be a list')
      return data.map(entry => string(object(entry, 'group property').id, 'group property id'))
    }) : []
    for (const id of mapped.filter(id => !grouped.includes(id))) {
      if (await this.present(`/properties/${encodeURIComponent(id)}`, 'property')) fail(409, 'PROPERTY_OUTSIDE_GROUP', `Channex property ${id} is mapped here but is not in this organization's group.`)
    }
    const shared = await queryFirst<{ organization_id: string }>(this.db, `
      SELECT organization_id FROM product_channel_mappings WHERE provider = 'channex' AND organization_id <> ? AND property_id IN (SELECT value FROM json_each(?))
      UNION SELECT organization_id FROM channex_connections WHERE organization_id <> ? AND setup_property_id IN (SELECT value FROM json_each(?))
      LIMIT 1`, [this.organizationId, d1JsonStringSet(grouped), this.organizationId, d1JsonStringSet(grouped)])
    if (shared) fail(409, 'SHARED_PROVIDER_PROPERTY', 'A Channex property in this group belongs to another organization.')
    await execute(this.db, "UPDATE product_channel_mappings SET enabled = 0, updated_at = ? WHERE organization_id = ? AND provider = 'channex'", [now(), this.organizationId])
    for (const id of grouped) await channexRequest(this.env, `/properties/${encodeURIComponent(id)}?force=true`, 'DELETE')
    if (resource) await channexRequest(this.env, groupPath, 'DELETE')
    await executeBatch(this.db, [
      { query: 'DELETE FROM channex_connections WHERE organization_id = ?', params: [this.organizationId] },
      { query: 'DELETE FROM channex_groups WHERE organization_id = ?', params: [this.organizationId] },
    ], { operation: 'Remove the organization Channex group' })
  }

  /** The resource, or null when Channex answers 404 (deleted already). */
  private async present(path: string, type: string): Promise<Resource | null> {
    try {
      return await channexGet(this.env, path, type)
    } catch (error) {
      if (error instanceof ChannexError && error.providerStatus === 404) return null
      throw error
    }
  }
}

/** What a field held, as the content stage records what it wrote: the SHA-256 of its JSON, a list in sorted order (the home keeps amenities in catalog order). */
async function fingerprint(value: unknown): Promise<string> {
  return await digest(JSON.stringify(Array.isArray(value) ? [...value].map(String).sort() : value ?? null))
}

/** The content stage's saved report, or null until it ran. */
function contentReport(mapping: MappingRow): ImportContentReport | null {
  return mapping.import_content ? JSON.parse(mapping.import_content) as ImportContentReport : null
}


/** Source equality identifies inheritance; the canonical home governs inherited values after import. */
function importedNight(night: ListingNight, currency: string, source: Pick<ListingDetails, 'minimum_nights' | 'nightly_rate' | 'calendar_rules'>) {
  const defaults = resolveStayNightPolicy({ min_nights: source.minimum_nights, base_price_minor: minorUnits(source.nightly_rate, currency), calendar_rules: source.calendar_rules }, night.date)
  const price = minorUnits(night.rate, currency)
  return {
    date: night.date, available: !night.blocked, price_minor: price === defaults.price_minor ? null : price,
    min_stay_arrival: night.minStay === defaults.min_stay_arrival ? null : night.minStay,

    max_stay: night.maxStay === 0 ? null : night.maxStay, closed_to_arrival: night.closedToArrival, closed_to_departure: night.closedToDeparture,
  }
}
