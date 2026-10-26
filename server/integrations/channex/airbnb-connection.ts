import { HTTPError } from 'nitro'
import { executeWithinCapacity, requireHomeCapacity } from '~/server/utils/billing'
import { d1JsonStringSet, execute, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { createStayHome, importStayNights, placeStayHomePhotosFirst, readStayHome, stayHomeInput, syncStayCalendar, updateStayHome, type StayAccess } from '~/server/domain/stays'
import { currencyFractionDigits, isCurrencyCode } from '~/shared/currencies'
import { isValidTimezone } from '~/utils/timezone'
import { memberAccessPrincipal, resolveOrganizationMembership } from '~/server/utils/member-access'
import { getMediaUploadReplay, replaceR2ImageFile, uploadResolvedMediaToAssetStore } from '~/server/utils/media-upload'
import { getMediaAsset, updateMediaAssetMetadata } from '~/server/utils/media-asset-manager'
import { imagePixelSize, MAX_IMAGE_BYTES, RESOLVED_MEDIA_IMAGE_TYPES, sniffMediaMimeType } from '~/server/utils/media-mime'
import { getProduct, updateProduct } from '~/server/utils/product-management'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import type { ProductDetailKey } from '~/shared/product-details'
import { MAX_ORDERED_MEDIA_ASSETS } from '~/shared/media-placement-contract'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { STAY_ARRIVAL_TEXT_LIMITS } from '~/shared/stay-arrival'
import { isStayAmenity, type StayAmenity, type StayCheckInMethod } from '~/shared/stay-listing'
import { channexCreate, channexGet, channexRequest, ChannexError, type ChannexEnv } from './client'
import { ChannexDataError, object, relationship, string, type JsonRecord, type Resource } from './data'
import { CALENDAR_NIGHTS, DETAIL_FIELDS, PHOTO_WIDTH, PROPERTY_TYPES, listingCalendar, listingContent, listingDetails, type DescriptionField, type DetailField, type ListingDetails, type ListingImage, type OrganizationContact, type ListingNight } from './airbnb-listing'
import { installChannexMessages, uninstallChannexMessages } from './messages'
import { forgetConfirmedNights, type ChannexMapping } from './ari'
import { backfillChannexMessages } from '~/server/domain/guest-threads/channel-messages'

/**
 * An organization's Airbnb account, connected through Channex: start a
 * single-use sign-in, complete it from the callback, read the account's
 * listings, disconnect, and release everything in Channex when the organization
 * is deleted.
 *
 * Every step holds the row's operation lock. A provider write is preceded by
 * naming it in pending_step; if that write fails without proof Channex refused
 * it, the connection is held in needs_review so nothing creates a second
 * resource on retry.
 */

export type ConnectionStatus = 'not_connected' | 'authorizing' | 'connected' | 'disconnecting' | 'needs_review'

interface ConnectionRow {
  organization_id: string
  status: ConnectionStatus
  operation_id: string | null
  pending_step: string | null
  group_id: string | null
  setup_property_id: string | null
  state_hash: string | null
  authorization_url: string | null
  authorization_user_id: string | null
  authorization_title: string | null
  authorization_expires_at: string | null
  channel_id: string | null
  connected_at: string | null
}

/**
 * A listing's import, stage by stage. Through `draft` it builds the home and
 * its Channex property and nothing syncs with Airbnb: a draft is free on every
 * plan. Activate moves a draft to `mapping`, where the plan is checked before
 * Channex maps the listing; from there the home is live.
 */
export const IMPORT_STAGES = ['property', 'room', 'rate', 'inventory', 'verify_inventory', 'content', 'draft', 'mapping', 'activate', 'reservations', 'messages', 'complete'] as const
export type ImportStage = typeof IMPORT_STAGES[number]

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
  /** Fields the host changed in KrabiClaw since Airbnb's value was last written: kept as the host has them. */
  kept_host_edits: string[]
}

export interface AirbnbListing {
  id: string
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
  import_calendar: string | null
  import_content: string | null
  import_written: string | null
  enabled: number
}

/** The listing details the host approved; the Channex property, room type and rate plan are created from these. */
interface ImportProperty {
  title: string
  currency: string
  timezone: string
  property_type: string
  email: string
  phone: string
  country: string
  state: string
  city: string
  address: string
  zip_code: string
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
/** A lock untouched this long belongs to a request that ended without releasing it. */
const ABANDONED_LOCK_MS = 15 * 60 * 1000
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

export class AirbnbConnection {
  private readonly db: DbClient
  private readonly env: CloudflareEnv & ChannexEnv
  private readonly organizationId: string
  private readonly userId: string

  constructor(db: DbClient, env: CloudflareEnv, organizationId: string, userId: string, signal?: AbortSignal) {
    this.db = db
    this.env = signal ? { ...env, requestSignal: signal } : env
    this.organizationId = organizationId
    this.userId = userId
  }

  private checkSlice(): void {
    if (this.env.requestSignal?.aborted) fail(504, 'SYNC_SLICE_ENDED', 'The background slice ended before this step finished. Its recorded stage is retained.')
  }

  private async row(): Promise<ConnectionRow | null> {
    return await queryFirst<ConnectionRow>(this.db, 'SELECT * FROM channex_connections WHERE organization_id = ?', [this.organizationId])
  }

  /** Writes fields while this call still holds the lock it took. */
  private async save(row: ConnectionRow, values: Partial<ConnectionRow>): Promise<void> {
    const entries = Object.entries(values)
    const result = await execute(this.db, `
      UPDATE channex_connections SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ?
       WHERE organization_id = ? AND operation_id = ?`,
    [...entries.map(([, value]) => value ?? null), now(), this.organizationId, row.operation_id])
    if (!result.meta.changes) fail(409, 'CONNECTION_CHANGED', 'The Airbnb connection changed. Refresh and try again.')
    Object.assign(row, values)
  }

  private async locked<T>(action: (row: ConnectionRow) => Promise<T>): Promise<T> {
    this.checkSlice()
    await execute(this.db, "INSERT INTO channex_connections (organization_id, status) VALUES (?, 'not_connected') ON CONFLICT (organization_id) DO NOTHING", [this.organizationId])
    const operationId = crypto.randomUUID()
    // Every step under the lock writes updated_at, so a lock left untouched for
    // ABANDONED_LOCK_MS belongs to a request the runtime ended before its catch
    // could run. With no provider write named it is released; with one, the
    // write may have applied, so the connection is held for review instead.
    const abandonedBefore = new Date(Date.now() - ABANDONED_LOCK_MS).toISOString()
    await execute(this.db, `UPDATE channex_connections SET status = 'needs_review', updated_at = ?
      WHERE organization_id = ? AND operation_id IS NOT NULL AND pending_step IS NOT NULL AND updated_at < ? AND status <> 'needs_review'`,
    [now(), this.organizationId, abandonedBefore])
    const taken = await execute(this.db, `UPDATE channex_connections SET operation_id = ?, updated_at = ?
      WHERE organization_id = ? AND (operation_id IS NULL OR (pending_step IS NULL AND updated_at < ?))`,
    [operationId, now(), this.organizationId, abandonedBefore])
    if (!taken.meta.changes) {
      if ((await this.row())?.status === 'needs_review') fail(409, 'CONNECTION_NEEDS_REVIEW', 'This Airbnb connection needs support review before continuing.')
      fail(409, 'CONNECTION_BUSY', 'Airbnb setup is running. Refresh before continuing.')
    }
    const row = (await this.row())!
    try {
      if (row.status === 'needs_review') fail(409, 'CONNECTION_NEEDS_REVIEW', 'This Airbnb connection needs support review before continuing.')
      this.checkSlice()
      const result = await action(row)
      await this.save(row, { operation_id: null, pending_step: null })
      return result
    } catch (error) {
      // A write that was sent and not provably refused stays locked for review.
      const uncertain = row.pending_step !== null && !(error instanceof ChannexError && error.writeRefused)
      await this.save(row, uncertain ? { status: 'needs_review' } : { operation_id: null, pending_step: null })
      if (uncertain && error instanceof ChannexError && !error.uncertain) throw new ChannexError(`The pending Channex write needs review because its verification failed: ${error.message}`, error.status, true, error.data)
      throw error
    }
  }

  private async mappings(): Promise<MappingRow[]> {
    return await queryAll<MappingRow>(this.db, "SELECT * FROM product_channel_mappings WHERE organization_id = ? AND provider = 'channex'", [this.organizationId])
  }

  /** The channel, verified to be this organization's Airbnb channel and to map only its properties and rate plans. */
  private async channel(row: ConnectionRow, channelId: string): Promise<Resource & { properties: string[]; ratePlans: JsonRecord[]; active: boolean }> {
    const [channel, mappings] = await Promise.all([channexGet(this.env, `/channels/${encodeURIComponent(channelId)}`, 'channel'), this.mappings()])
    const allowedProperties = new Set(mappings.flatMap(mapping => mapping.property_id ? [mapping.property_id] : []))
    const allowedRatePlans = new Set(mappings.flatMap(mapping => mapping.rate_plan_id ? [mapping.rate_plan_id] : []))
    return provided(() => {
      const attributes = channel.attributes
      if (!Array.isArray(attributes.properties) || !Array.isArray(attributes.rate_plans) || typeof attributes.is_active !== 'boolean') {
        fail(502, 'INVALID_PROVIDER_RESPONSE', 'The Airbnb channel has invalid properties, mappings or activation state.')
      }
      const properties = attributes.properties.map(id => string(id, 'Channel property id'))
      const ratePlans = attributes.rate_plans.map((value) => {
        const mapping = object(value, 'Airbnb mapping')
        string(mapping.id, 'Mapping id')
        string(mapping.rate_plan_id, 'Mapping rate plan id')
        return mapping
      })
      const allowed = new Set(allowedProperties)
      if (row.setup_property_id) allowed.add(row.setup_property_id)
      if (attributes.channel !== 'AirBNB' || relationship(channel, 'group') !== row.group_id
        || properties.length === 0 || properties.some(id => !allowed.has(id))) {
        fail(403, 'CHANNEL_NOT_OWNED', 'This Airbnb connection does not belong to this organization')
      }
      if (ratePlans.some(mapping => !allowedRatePlans.has(String(mapping.rate_plan_id)))) fail(403, 'CHANNEL_NOT_OWNED', 'This Airbnb connection maps a listing outside this organization')
      return { ...channel, properties, ratePlans, active: attributes.is_active }
    })
  }

  /**
   * `connected` means the Airbnb account is authorized. Its channel exchanges
   * nothing until a listing is imported and the channel activated, which
   * `channel_active` reports.
   */
  async status(): Promise<{ status: ConnectionStatus; connected_at: string | null; listing_count: number; channel_active: boolean }> {
    const row = await this.row()
    if (!row) return { status: 'not_connected', connected_at: null, listing_count: 0, channel_active: false }
    if (row.status !== 'connected') return { status: row.status, connected_at: row.connected_at, listing_count: 0, channel_active: false }
    const channel = await this.channel(row, row.channel_id!)
    return { status: row.status, connected_at: row.connected_at, listing_count: channel.ratePlans.length, channel_active: channel.active }
  }

  /** A single-use Airbnb sign-in link for the person asking. */
  async start(): Promise<{ authorization_url: string }> {
    return await this.locked(async (row) => {
      if (row.channel_id) fail(409, 'ALREADY_CONNECTED', 'Disconnect the current Airbnb account before connecting another one.')
      if (row.authorization_url) {
        if (row.authorization_user_id !== this.userId) fail(409, 'SIGN_IN_OWNED_ELSEWHERE', 'Another admin started this Airbnb sign-in. They need to finish it.')
        if (!row.authorization_expires_at || row.authorization_expires_at <= now()) fail(409, 'SIGN_IN_EXPIRED', 'The Airbnb sign-in link expired. Contact support to review the unfinished connection.')
        return { authorization_url: row.authorization_url }
      }
      if (!row.group_id) {
        await this.save(row, { pending_step: 'create_group' })
        const group = await channexCreate(this.env, '/groups', { group: { title: `KrabiClaw ${this.organizationId}` } }, 'group')
        await this.save(row, { group_id: group.id, pending_step: null })
      }
      if (!row.setup_property_id) {
        await this.save(row, { pending_step: 'create_setup_property' })
        const property = await channexCreate(this.env, '/properties', { property: { title: 'KrabiClaw connection setup', currency: 'USD', property_type: 'apartment', group_id: row.group_id } }, 'property')
        await this.save(row, { setup_property_id: property.id, pending_step: null })
      }
      const state = crypto.randomUUID() + crypto.randomUUID()
      const title = `KrabiClaw ${crypto.randomUUID()}`
      await this.save(row, {
        state_hash: await digest(state), authorization_user_id: this.userId, authorization_title: title,
        authorization_expires_at: new Date(Date.now() + SIGN_IN_LIFETIME_MS).toISOString(), pending_step: 'connection_link',
      })
      const result = await channexRequest(this.env, '/meta/airbnb/connection_link', 'POST', { connection_link: {
        group_id: row.group_id, properties: [row.setup_property_id], redirect_uri: AIRBNB_CALLBACK, failure_redirect_uri: AIRBNB_CALLBACK, token: state, title,
      } })
      const address = provided(() => {
        const data = object(result.data, 'Connection link')
        if (data.type !== 'connection_link') throw new ChannexDataError('Unexpected connection link response')
        return string(object(data.attributes, 'Connection link').url, 'Authorization URL')
      })
      if (!URL.canParse(address)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Channex returned an invalid Airbnb sign-in link')
      const url = new URL(address)
      if (url.protocol !== 'https:' || url.hostname !== 'www.airbnb.com' || url.pathname !== '/oauth2/auth') fail(502, 'INVALID_PROVIDER_RESPONSE', 'Channex returned an unexpected Airbnb sign-in link')
      await this.save(row, { authorization_url: url.toString(), status: 'authorizing', pending_step: null })
      return { authorization_url: url.toString() }
    })
  }

  /** The callback: the state proves it is this person's sign-in, the channel proves it is the account they just authorized. */
  async complete(state: string, channelId: string): Promise<{ connected: true }> {
    return await this.locked(async (row) => {
      if (row.status !== 'authorizing' || row.authorization_user_id !== this.userId || !row.authorization_expires_at
        || row.authorization_expires_at <= now() || row.state_hash !== await digest(state)) {
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
    })
  }

  private async connected(): Promise<ConnectionRow & { channel_id: string }> {
    const row = await this.row()
    if (!row || row.status !== 'connected' || !row.channel_id) fail(409, 'NOT_CONNECTED', 'Connect your Airbnb account first.')
    return row as ConnectionRow & { channel_id: string }
  }

  private async accountListings(row: ConnectionRow & { channel_id: string }): Promise<Array<Omit<AirbnbListing, 'import'>>> {
    await this.channel(row, row.channel_id)
    const raw = await channexRequest(this.env, `/channels/${encodeURIComponent(row.channel_id)}/action/listings`)
    return provided(() => {
      const dictionary = object(object(raw.data, 'Airbnb listings').listing_id_dictionary, 'Listing dictionary')
      if (!Array.isArray(dictionary.values)) throw new ChannexDataError('Airbnb did not return a listing collection')
      return dictionary.values.map((value) => {
        const listing = object(value, 'Airbnb listing')
        return { id: string(listing.id, 'Listing id'), title: string(listing.title, 'Listing title'), city: string(listing.city, 'Listing city'), country_code: string(listing.country_code, 'Listing country') }
      })
    })
  }

  /** The listings on the connected Airbnb account, and how far each one's import got. */
  async listings(): Promise<AirbnbListing[]> {
    const row = await this.connected()
    const [listings, mappings] = await Promise.all([this.accountListings(row), this.mappings()])
    return listings.map((listing) => {
      const mapping = mappings.find(candidate => candidate.listing_id === listing.id && candidate.channel_id === row.channel_id)
      return { ...listing, import: mapping ? { status: 'imported', product_id: mapping.product_id, stage: mapping.import_stage, syncing: mapping.enabled === 1, content: mapping.import_stage === 'content' ? null : contentReport(mapping) } : { status: 'not_imported' } }
    })
  }

  private async requireListing(row: ConnectionRow & { channel_id: string }, listingId: string): Promise<void> {
    if (!(await this.accountListings(row)).some(listing => listing.id === listingId)) fail(404, 'LISTING_NOT_FOUND', 'This listing is not on your connected Airbnb account')
  }

  /** A listing's details, and which of the fields an import needs Airbnb left out. */
  async details(listingId: string): Promise<ListingDetails> {
    const row = await this.connected()
    await this.requireListing(row, listingId)
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
  private organizationContactUpdate(details: ListingDetails, values: Record<DetailField, string>): BatchQuery | null {
    const sets: string[] = []
    const params: unknown[] = []
    if (details.missingFields.includes('email')) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) fail(422, 'INVALID_DETAIL', 'Enter a valid contact email')
      sets.push("contact_email = COALESCE(NULLIF(TRIM(contact_email), ''), ?)")
      params.push(values.email.toLowerCase())
    }
    if (details.missingFields.includes('phone')) {
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
    return await this.locked(async (row) => {
      if (row.status !== 'connected' || !row.channel_id) fail(409, 'NOT_CONNECTED', 'Connect Airbnb before importing listings.')
      const channelId = row.channel_id
      await this.requireListing(row as ConnectionRow & { channel_id: string }, listingId)
      const existing = await queryFirst<MappingRow>(this.db, "SELECT * FROM product_channel_mappings WHERE provider = 'channex' AND listing_id = ?", [listingId])
      if (existing) {
        if (existing.organization_id !== this.organizationId) fail(409, 'LISTING_LINKED_ELSEWHERE', 'This Airbnb listing is already linked to another organization')
        if (existing.channel_id === channelId) return { product_id: existing.product_id, stage: existing.import_stage, waiting: false }
        // A reconnected account re-pushes the inventory of a home it already imported.
        if (existing.enabled || !existing.property_id || !existing.room_type_id || !existing.rate_plan_id) fail(409, 'IMPORT_NEEDS_REVIEW', 'The previous listing connection needs review before reconnecting')
      }

      const details = await listingDetails(this.env, channelId, listingId, await this.organizationContact())
      const supplied = Object.keys(input.missingDetails ?? {})
      if (supplied.some(key => !(details.missingFields as string[]).includes(key))) fail(422, 'ONLY_MISSING_DETAILS', 'Only the listing details Airbnb left out may be supplied')
      const field = (key: DetailField): string => {
        const value = details.fields[key] ?? input.missingDetails?.[key]
        if (typeof value !== 'string' || !value.trim()) fail(422, 'MISSING_DETAIL', `${key} is required`)
        return value.trim()
      }
      const values = Object.fromEntries(DETAIL_FIELDS.map(key => [key, field(key)])) as Record<DetailField, string>
      if (!(PROPERTY_TYPES as readonly string[]).includes(values.propertyType)) fail(422, 'INVALID_DETAIL', 'Check the property type')
      if (details.defaultOccupancy > details.maxGuests) fail(422, 'INVALID_DETAIL', "The included guest count exceeds the listing's capacity")
      const organization = await queryFirst<{ default_currency: string }>(this.db, 'SELECT default_currency FROM organization WHERE id = ?', [this.organizationId])
      if (!organization || !isCurrencyCode(organization.default_currency)) throw new Error(`Organization ${this.organizationId} has no supported default currency`)
      if (details.currency !== organization.default_currency) {
        fail(422, 'CURRENCY_MISMATCH', `This listing is priced in ${details.currency} and this organization sells in ${organization.default_currency}. Import stopped; nothing was created.`)
      }
      if (!isValidTimezone(values.timezone)) fail(422, 'INVALID_DETAIL', 'Choose a valid time zone')
      // The check-in window and checkout are Airbnb's; a listing without a start or checkout hour is set on Airbnb first.
      if (!details.checkInTime) fail(422, 'MISSING_AIRBNB_FIELD', 'Set a check-in start time on Airbnb, then import again.', { field: 'booking_settings.check_in_time_start' })
      if (!details.checkOutTime) fail(422, 'MISSING_AIRBNB_FIELD', 'Set a checkout time on Airbnb, then import again.', { field: 'booking_settings.check_out_time' })
      const calendar = await listingCalendar(this.env, channelId, listingId, values.timezone)
      const contact = this.organizationContactUpdate(details, values)
      const property: ImportProperty = {
        title: details.title, currency: details.currency, timezone: values.timezone, property_type: values.propertyType, email: values.email, phone: values.phone,
        country: values.country, state: values.state, city: values.city, address: values.address, zip_code: values.zipCode, max_guests: details.maxGuests,
        default_occupancy: details.defaultOccupancy, nightly_rate: details.nightlyRate,
      }
      this.checkSlice()
      if (existing) {
        // A completed import cleared its source inputs. Re-read and validate
        // them above before resuming the same home's inventory on this channel.
        await importStayNights(this.db, this.env, this.manager(), existing.product_id, provided(() => calendar.map(night => importedNight(night, organization.default_currency))))
        const [reconnected] = await executeWithinCapacity(this.env, this.db, this.organizationId, [{
          query: "UPDATE product_channel_mappings SET channel_id = ?, import_stage = 'inventory', import_property = ?, updated_at = ? WHERE product_id = ? AND provider = 'channex' AND enabled = 0",
          params: [channelId, JSON.stringify(property), now(), existing.product_id],
        }, ...(contact ? [contact] : [])], { operation: 'Reconnect an imported Airbnb listing', action: 'reconnect it' })
        if (!reconnected?.meta.changes) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
        return { product_id: existing.product_id, stage: 'inventory', waiting: false }
      }
      // The home itself is made as a home added by hand is: a draft until it goes live.
      const home = await createStayHome(this.env, this.db, this.manager(), stayHomeInput({
        name: details.title, timezone: values.timezone, address: values.address, city: values.city, state: values.state, country: values.country,
        zip_code: values.zipCode, phone: values.phone, email: values.email, check_in_time: details.checkInTime, check_in_end_time: details.checkInEndTime, check_out_time: details.checkOutTime,
        max_guests: details.maxGuests, min_nights: calendar[0]!.minStay, base_price_minor: provided(() => minorUnits(details.nightlyRate, organization.default_currency)),
      }), `airbnb-listing:${listingId}`)
      // The nights land before the mapping: until the mapping exists a retry
      // runs this whole step again (the location and product replay by their
      // idempotency key, the nights upsert), so no import is left without its calendar.
      await importStayNights(this.db, this.env, this.manager(), home.product_id, provided(() => calendar.map(night => importedNight(night, organization.default_currency))))
      // The mapping and what the host typed as the organization's contact are
      // one write: until both land a retry runs this step again with the same
      // form, and a refused import leaves the details missing.
      await executeBatch(this.db, [{
        query: `INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, import_stage, import_property)
          VALUES (?, ?, 'channex', ?, ?, 'property', ?) ON CONFLICT (product_id, provider) DO NOTHING`,
        params: [this.organizationId, home.product_id, listingId, channelId, JSON.stringify(property)],
      }, ...(contact ? [contact] : [])], { operation: 'Map an imported Airbnb listing' })
      return { product_id: home.product_id, stage: 'property', waiting: false }
    })
  }

  private manager(): StayAccess {
    return { organizationId: this.organizationId, actorId: this.userId, manage: true }
  }

  /**
   * One stage of a listing's import. Each call does one provider step and
   * saves where it got; `waiting` means Channex has not applied the last step
   * yet and the same stage is asked again later.
   */
  async advance(productId: string): Promise<{ product_id: string; stage: ImportStage; waiting: boolean; content: ImportContentReport | null }> {
    return await this.locked(async (row) => {
      if (row.status !== 'connected' || !row.channel_id || !row.group_id) fail(409, 'NOT_CONNECTED', 'Connect Airbnb before importing listings.')
      const channelId = row.channel_id
      const groupId = row.group_id
      await this.channel(row, channelId)
      const mapping = await queryFirst<MappingRow>(this.db, "SELECT * FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [this.organizationId, productId])
      if (!mapping || mapping.channel_id !== channelId) fail(404, 'IMPORT_NOT_FOUND', 'Listing import not found')
      const stage = mapping.import_stage
      const required = stage === 'property' ? [] : stage === 'room' ? [mapping.property_id] : stage === 'rate' ? [mapping.property_id, mapping.room_type_id] : [mapping.property_id, mapping.room_type_id, mapping.rate_plan_id]
      if (required.some(id => !id)) throw new Error(`Import of ${productId} at ${stage} is missing a Channex id`)
      const property = mapping.import_property ? JSON.parse(mapping.import_property) as ImportProperty : null
      const save = async (values: Partial<Pick<MappingRow, 'property_id' | 'room_type_id' | 'rate_plan_id' | 'import_stage' | 'import_property' | 'import_content' | 'import_written' | 'enabled'>>) => {
        const entries = Object.entries(values)
        const result = await execute(this.db, `UPDATE product_channel_mappings SET ${entries.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ? WHERE product_id = ? AND provider = 'channex' AND import_stage = ?`,
          [...entries.map(([, value]) => value ?? null), now(), productId, stage])
        if (!result.meta.changes) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
        Object.assign(mapping, values)
      }
      const path = `/channels/${encodeURIComponent(channelId)}`
      const wrote = (step: string | null) => this.save(row, { pending_step: step })
      switch (stage) {
        case 'property': {
          if (!property) throw new Error(`Import of ${productId} has no approved listing details`)
          await wrote('import_property')
          const created = await channexCreate(this.env, '/properties', { property: {
            title: property.title, currency: property.currency, timezone: property.timezone, group_id: groupId, property_type: property.property_type,
            email: property.email, phone: property.phone, country: property.country, state: property.state, city: property.city,
            // KrabiClaw keeps minimum stay on arrival and through stay apart and sends both (docs.channex.io Properties: `both`).
            address: property.address, zip_code: property.zip_code, settings: { state_length: CALENDAR_NIGHTS, min_stay_type: 'both' },
          } }, 'property')
          await save({ property_id: created.id, import_stage: 'room' })
          break
        }
        case 'room': {
          if (!property) throw new Error(`Import of ${productId} has no approved listing details`)
          await wrote('import_room')
          const created = await channexCreate(this.env, '/room_types', { room_type: {
            property_id: mapping.property_id, title: 'Entire home', count_of_rooms: 1, occ_adults: property.max_guests,
            // Channex's child-only beds and infant cots; Airbnb counts neither, and Channex says to send 0 when there are none.
            occ_children: 0, occ_infants: 0, default_occupancy: property.default_occupancy, room_kind: 'room',
          } }, 'room_type')
          await save({ room_type_id: created.id, import_stage: 'rate' })
          break
        }
        case 'rate': {
          if (!property) throw new Error(`Import of ${productId} has no approved listing details`)
          await wrote('import_rate')
          const created = await channexCreate(this.env, '/rate_plans', { rate_plan: {
            property_id: mapping.property_id, room_type_id: mapping.room_type_id, title: 'Standard rate', currency: property.currency,
            rate_mode: 'manual', sell_mode: 'per_room', options: [{ occupancy: property.default_occupancy, is_primary: true, rate: property.nightly_rate }],
          } }, 'rate_plan')
          await save({ rate_plan_id: created.id, import_stage: 'inventory' })
          break
        }
        case 'inventory': {
          // The full sync: the home's calendar ahead through the delivery outbox, as every
          // night change goes, to a rate plan Channex has nothing confirmed for yet. One
          // restrictions and one availability call, each logged with its task.
          await forgetConfirmedNights(this.db, productId)
          const waiting = await this.syncCalendar(mapping)
          if (waiting) return { product_id: productId, stage, waiting: true, content: null }
          await save({ import_stage: 'verify_inventory' })
          break
        }
        case 'verify_inventory': {
          const matches = await this.inventoryMatches(mapping as MappingRow & ChannexMapping)
          if (!matches) return { product_id: productId, stage, waiting: true, content: null }
          await save({ import_stage: 'content' })
          break
        }
        case 'content': {
          // Reads Airbnb and writes the home; nothing is written to Channex, so no pending step.
          // A few photos per call: until all are stored the stage is asked again, keeping the report so far.
          const { report, done, written } = await this.importContent(mapping, channelId, PHOTO_FETCHES_PER_CALL)
          if (!done) {
            await save({ import_content: JSON.stringify(report) })
            await wrote(null)
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
          if (await this.syncCalendar(mapping)) return { product_id: productId, stage, waiting: true, content: null }
          await wrote('map_airbnb_listing')
          await channexCreate(this.env, `${path}/mappings`, { mapping: { rate_plan_id: mapping.rate_plan_id, settings: { listing_id: mapping.listing_id } } }, 'channel_rate_plan')
          const channel = await channexGet(this.env, path, 'channel')
          const mapped = provided(() => Array.isArray(channel.attributes.rate_plans) && channel.attributes.rate_plans.some((value) => {
            const entry = object(value, 'Mapping')
            return entry.rate_plan_id === mapping.rate_plan_id && object(entry.settings, 'Mapping settings').listing_id === mapping.listing_id
          }))
          if (!mapped) fail(502, 'PROVIDER_VERIFICATION_FAILED', 'The Airbnb mapping is not verified yet. Contact support before retrying.')
          await save({ import_stage: 'activate' })
          break
        }
        case 'activate': {
          // The first real listing replaces the temporary setup property before activation.
          if (row.setup_property_id) {
            const channel = await this.channel(row, channelId)
            const properties = channel.properties.filter(id => id !== row.setup_property_id)
            if (!properties.length) throw new Error(`Import of ${productId} reached activation with no mapped property`)
            await wrote('detach_setup_property')
            await channexRequest(this.env, path, 'PUT', { channel: { channel: 'AirBNB', properties } })
            if ((await this.channel(row, channelId)).properties.includes(row.setup_property_id)) fail(502, 'PROVIDER_VERIFICATION_FAILED', 'Removing the setup property needs review')
            await wrote('delete_setup_property')
            await channexRequest(this.env, `/properties/${encodeURIComponent(row.setup_property_id)}`, 'DELETE')
            await this.save(row, { setup_property_id: null, pending_step: null })
          }
          if ((await channexGet(this.env, path, 'channel')).attributes.is_active === false) {
            await wrote('activate_airbnb')
            await channexRequest(this.env, `${path}/activate`, 'POST')
          }
          if ((await channexGet(this.env, path, 'channel')).attributes.is_active !== true) fail(502, 'PROVIDER_VERIFICATION_FAILED', 'Airbnb activation is not verified yet')
          await wrote(null)
          // Enabling the mapping makes the home live: guarded and billed as a home going live.
          const [enabled] = await executeWithinCapacity(this.env, this.db, this.organizationId, [{
            query: "UPDATE product_channel_mappings SET import_stage = 'reservations', enabled = 1, updated_at = ? WHERE product_id = ? AND provider = 'channex' AND import_stage = 'activate'",
            params: [now(), productId],
          }], { operation: 'Enable an imported Airbnb listing', action: 'sync it with Airbnb' })
          if (!enabled?.meta.changes) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
          Object.assign(mapping, { import_stage: 'reservations', enabled: 1 })
          break
        }
        case 'reservations': {
          await wrote('load_airbnb_reservations')
          await channexRequest(this.env, `${path}/execute/load_future_reservations`, 'POST', { listing_id: mapping.listing_id })
          await save({ import_stage: 'messages' })
          break
        }
        case 'messages': {
          await wrote('install_messages')
          await installChannexMessages(this.env, string(mapping.property_id, 'property_id'))
          await wrote(null)
          await backfillChannexMessages(this.db, this.env, string(mapping.property_id, 'property_id'), this.organizationId)
          await save({ import_stage: 'complete', import_property: null })
          break
        }
        case 'complete':
          break
      }
      await wrote(null)
      return { product_id: productId, stage: mapping.import_stage, waiting: false, content: contentReport(mapping) }
    })
  }

  /**
   * Activate a draft: the plan is checked for one more live home before
   * anything is written to Channex, then the import moves to `mapping` and
   * `advance` carries it to `complete`. An import past `draft` answers where
   * it is, unchanged; one before `draft` is still being built.
   */
  async activate(productId: string): Promise<{ product_id: string; stage: ImportStage; waiting: false }> {
    return await this.locked(async (row) => {
      if (row.status !== 'connected' || !row.channel_id) fail(409, 'NOT_CONNECTED', 'Connect Airbnb before activating listings.')
      const mapping = await queryFirst<MappingRow>(this.db, "SELECT * FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [this.organizationId, productId])
      if (!mapping || mapping.channel_id !== row.channel_id) fail(404, 'IMPORT_NOT_FOUND', 'Listing import not found')
      const stage = IMPORT_STAGES.indexOf(mapping.import_stage)
      if (stage > IMPORT_STAGES.indexOf('draft')) return { product_id: productId, stage: mapping.import_stage, waiting: false }
      if (stage < IMPORT_STAGES.indexOf('draft')) fail(409, 'IMPORT_IN_PROGRESS', 'Finish importing this listing before activating it.')
      await requireHomeCapacity(this.env, this.db, this.organizationId, productId)
      const result = await execute(this.db, "UPDATE product_channel_mappings SET import_stage = 'mapping', updated_at = ? WHERE product_id = ? AND provider = 'channex' AND import_stage = 'draft'", [now(), productId])
      if (!result.meta.changes) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
      return { product_id: productId, stage: 'mapping', waiting: false }
    })
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
  async deactivate(productId: string): Promise<{ product_id: string; stage: ImportStage; waiting: false }> {
    return await this.locked(async (row) => {
      if (row.status !== 'connected' || !row.channel_id) fail(409, 'NOT_CONNECTED', 'Connect Airbnb before changing which listings sync.')
      const channelId = row.channel_id
      const mapping = await queryFirst<MappingRow>(this.db, "SELECT * FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [this.organizationId, productId])
      if (!mapping || mapping.channel_id !== channelId) fail(404, 'IMPORT_NOT_FOUND', 'Listing import not found')
      if (mapping.import_stage === 'draft') return { product_id: productId, stage: 'draft', waiting: false }
      if (mapping.import_stage !== 'complete') fail(409, 'IMPORT_IN_PROGRESS', 'This listing is still being imported or activated. Finish that first.')
      const propertyId = string(mapping.property_id, 'property_id')
      const path = `/channels/${encodeURIComponent(channelId)}`
      const mapped = (await this.channel(row, channelId)).ratePlans.find(entry => entry.rate_plan_id === mapping.rate_plan_id)
      if (mapped) {
        const mappingId = provided(() => string(mapped.id, 'Mapping id'))
        await this.save(row, { pending_step: `remove_mapping:${mappingId}` })
        await channexRequest(this.env, `${path}/mappings/${encodeURIComponent(mappingId)}`, 'DELETE')
        if ((await this.channel(row, channelId)).ratePlans.some(entry => entry.id === mappingId)) fail(502, 'PROVIDER_VERIFICATION_FAILED', 'Airbnb is still removing the listing. Support must verify it before continuing.')
      }
      await this.save(row, { pending_step: 'uninstall_messages' })
      await uninstallChannexMessages(this.env, propertyId)
      await this.save(row, { pending_step: null })
      // The home stops syncing, so it may stop being live: its billing is reported again.
      const [stopped] = await executeWithinCapacity(this.env, this.db, this.organizationId, [{
        query: "UPDATE product_channel_mappings SET import_stage = 'draft', enabled = 0, updated_at = ? WHERE product_id = ? AND provider = 'channex' AND import_stage = 'complete'",
        params: [now(), productId],
      }, { query: "DELETE FROM channel_night_pushes WHERE product_id = ? AND provider = 'channex'", params: [productId] }], { operation: 'Stop syncing an Airbnb listing', action: 'stop syncing it' })
      if (!stopped?.meta.changes) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
      return { product_id: productId, stage: 'draft', waiting: false }
    })
  }

  /**
   * The content stage again, for a home whose import is complete: one imported
   * before content was carried over, or whose Airbnb content changed. Same
   * lock, same work, same report.
   */
  async refreshContent(productId: string): Promise<{ product_id: string; stage: ImportStage; content: ImportContentReport }> {
    return await this.locked(async (row) => {
      if (row.status !== 'connected' || !row.channel_id) fail(409, 'NOT_CONNECTED', 'Connect Airbnb before importing listing content.')
      const mapping = await queryFirst<MappingRow>(this.db, "SELECT * FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [this.organizationId, productId])
      if (!mapping || mapping.channel_id !== row.channel_id) fail(404, 'IMPORT_NOT_FOUND', 'Listing import not found')
      if (mapping.import_stage !== 'complete') fail(409, 'IMPORT_IN_PROGRESS', 'Finish importing this listing first; its content lands at the content stage.')
      const { report, written } = await this.importContent(mapping, row.channel_id, Infinity)
      const result = await execute(this.db, "UPDATE product_channel_mappings SET import_content = ?, import_written = ?, updated_at = ? WHERE product_id = ? AND provider = 'channex' AND import_stage = 'complete'", [JSON.stringify(report), JSON.stringify(written), now(), productId])
      if (!result.meta.changes) fail(409, 'IMPORT_CHANGED', 'The import changed. Refresh and try again.')
      return { product_id: productId, stage: 'complete', content: report }
    })
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
    // A photo's new file shows on the site's cached pages only once they are purged, including when a later photo stops the stage.
    const purgeUpgraded = async () => { if (report.photos_upgraded.length) await purgePublicResourceCacheNow(this.env, this.organizationId) }
    try {
      for (const image of content.images) {
        this.checkSlice()
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
        this.checkSlice()
        // Imported photos live in R2 in every environment; Cloudflare Images holds credentials in production only.
        const uploaded = await uploadResolvedMediaToAssetStore({
          db: this.db, env: this.env, organizationId: this.organizationId, userId: null, source: 'external', kind: 'image', provider: 'cloudflare_r2',
          ...photo, idempotencyKey: identity.idempotencyKey, sourceFileId: identity.sourceFileId,
        })
        await this.caption(uploaded.assetId, image)
        assetIds.push(uploaded.assetId)
        report.photos_imported.push(image.id)
      }
    } catch (error) {
      try {
        await purgeUpgraded()
      } catch (purgeError) {
        throw new AggregateError([error, purgeError], 'The content stage stopped and the photos it had already upgraded could not be purged from the cached pages', { cause: purgeError })
      }
      throw error
    }
    await purgeUpgraded()
    if (pending) return { report, done: false, written: {} }
    if (assetIds.length) {
      this.checkSlice()
      const membership = await resolveOrganizationMembership(this.env, { organizationId: this.organizationId, userId: this.userId })
      if (!membership) fail(403, 'NOT_A_MEMBER', 'Only a member of this organization can import listing content')
      await placeStayHomePhotosFirst(this.db, this.env, access, memberAccessPrincipal(membership, { env: this.env }), mapping.product_id, assetIds)
    }

    const within = (field: string, text: string, limit: number): string => {
      if (text.length <= limit) return text
      report.truncated_fields.push({ field, limit, length: text.length })
      return text.slice(0, limit).trimEnd()
    }
    const body: Record<string, unknown> = {}
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
    // The window is written whole or not at all: a start or checkout Airbnb has not set leaves the home's.
    if (content.checkInTime && content.checkOutTime) Object.assign(body, { check_in_time: content.checkInTime, check_in_end_time: content.checkInEndTime, check_out_time: content.checkOutTime })
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
    const written: Record<string, string> = mapping.import_written ? JSON.parse(mapping.import_written) as Record<string, string> : {}
    const current: Record<string, unknown> = { ...home, ...(await getProduct(this.db, this.organizationId, mapping.product_id)).details }
    const unedited = async <T extends Record<string, unknown>>(values: T): Promise<Partial<T>> => {
      const kept: Partial<T> = {}
      for (const [field, value] of Object.entries(values) as Array<[keyof T & string, T[keyof T & string]]>) {
        if (written[field] !== undefined && written[field] !== await fingerprint(current[field])) {
          report.kept_host_edits.push(field)
          continue
        }
        kept[field] = value
        written[field] = await fingerprint(value)
      }
      return kept
    }
    const homeWrite = await unedited(body)
    const detailsWrite = await unedited(details)
    this.checkSlice()
    if (Object.keys(homeWrite).length) await updateStayHome(this.env, this.db, access, mapping.product_id, homeWrite)
    if (Object.keys(detailsWrite).length) {
      this.checkSlice()
      await updateProduct(this.db, { organizationId: this.organizationId, productId: mapping.product_id, patch: { details_mode: 'merge', details: detailsWrite }, actor: { actorId: this.userId }, env: this.env })
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
    // Counted when the photo names its new file, so a failure deleting the old one still purges the cached pages.
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
      this.checkSlice()
      response = await fetch(image.url, { redirect: 'follow', signal: this.env.requestSignal })
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
      this.checkSlice()
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

  /** Existing imports use the same connection lock and installation review policy. */
  async syncMessages(productId: string): Promise<{ threads: number }> {
    return this.locked(async (row) => {
      if (row.status !== 'connected' || !row.channel_id) fail(409, 'NOT_CONNECTED', 'Connect Airbnb before importing conversations')
      const mapping = await queryFirst<MappingRow>(this.db, "SELECT * FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [this.organizationId, productId])
      if (!mapping || mapping.enabled !== 1 || mapping.channel_id !== row.channel_id || !mapping.property_id) fail(409, 'CHANNEL_PROPERTY_NOT_READY', 'Connect this home before importing conversations')
      await this.save(row, { pending_step: 'install_messages' })
      await installChannexMessages(this.env, mapping.property_id)
      await this.save(row, { pending_step: null })
      return backfillChannexMessages(this.db, this.env, mapping.property_id, this.organizationId)
    })
  }

  /** Whether Channex now holds exactly the calendar the import pushed. */
  /**
   * The home's calendar ahead, delivered to its Channex property through the
   * outbox. True while Channex holds part of it (a rate limit or a pause after
   * a call it did not confirm): the stage is asked again later. A refusal
   * fails the import for review with Channex's reason.
   */
  private async syncCalendar(mapping: MappingRow): Promise<boolean> {
    const pushed = await syncStayCalendar(this.db, this.env, this.manager(), mapping.product_id, { property_id: string(mapping.property_id, 'property_id'), room_type_id: string(mapping.room_type_id, 'room_type_id'), rate_plan_id: string(mapping.rate_plan_id, 'rate_plan_id') })
    if (pushed.state === 'needs_review') fail(502, 'PROVIDER_VERIFICATION_FAILED', `Channex rejected part of the calendar: ${pushed.detail} The import needs review before connecting Airbnb.`)
    return pushed.state === 'pending'
  }

  /** Whether Channex now reads every night the full sync sent it; a new rate plan reads zero until its update is applied, which is "not yet", not an error. */
  private async inventoryMatches(mapping: MappingRow & ChannexMapping): Promise<boolean> {
    const sent = await queryAll<{ date: string; sent_json: string }>(this.db, "SELECT date, sent_json FROM channel_night_pushes WHERE product_id = ? AND provider = 'channex' AND state = 'pushed' AND sent_json IS NOT NULL ORDER BY date", [mapping.product_id])
    if (!sent.length) throw new Error(`Import of ${mapping.product_id} has no delivered calendar to verify`)
    const query = new URLSearchParams({ 'filter[property_id]': mapping.property_id, 'filter[date][gte]': sent[0]!.date, 'filter[date][lte]': sent.at(-1)!.date })
    const availability = await channexRequest(this.env, `/availability?${query}`)
    query.set('filter[restrictions]', 'rate,min_stay_arrival,min_stay_through,max_stay,closed_to_arrival,closed_to_departure,stop_sell')
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
        return count === values.availability && rate === Number(values.rate) && rule.min_stay_arrival === values.min_stay_arrival && rule.min_stay_through === values.min_stay_through
          && rule.max_stay === values.max_stay && rule.closed_to_arrival === values.closed_to_arrival && rule.closed_to_departure === values.closed_to_departure && rule.stop_sell === values.stop_sell
      })
    })
  }

  /**
   * Removes the connection one mapping per call (each removal is verified
   * before the next), then deactivates and deletes the channel and the setup
   * property. `disconnected: false` means call again.
   */
  async disconnect(): Promise<{ disconnected: boolean }> {
    return await this.locked(async (row) => {
      if (!row.channel_id) fail(409, 'NOT_CONNECTED', 'There is no completed Airbnb connection to disconnect.')
      let channel = await this.channel(row, row.channel_id)
      const path = `/channels/${encodeURIComponent(channel.id)}`
      await this.save(row, { status: 'disconnecting' })
      // Homes that stop syncing may stop being live: the counts are reported again.
      await executeWithinCapacity(this.env, this.db, this.organizationId, [{
        query: "UPDATE product_channel_mappings SET enabled = 0, updated_at = ? WHERE organization_id = ? AND provider = 'channex' AND channel_id = ?",
        params: [now(), this.organizationId, channel.id],
      }], { operation: 'Disconnect Airbnb listings', action: 'disconnect them' })
      const first = channel.ratePlans[0]
      if (first !== undefined) {
        const mappingId = provided(() => string(first.id, 'Mapping id'))
        await this.save(row, { pending_step: `remove_mapping:${mappingId}` })
        await channexRequest(this.env, `${path}/mappings/${encodeURIComponent(mappingId)}`, 'DELETE')
        channel = await this.channel(row, channel.id)
        if (channel.ratePlans.some(mapping => mapping.id === mappingId)) fail(409, 'DISCONNECT_PENDING', 'Airbnb is still removing the listing. Support must verify it before continuing.')
        await this.save(row, { pending_step: null })
        return { disconnected: false }
      }
      if (channel.active) {
        await this.save(row, { pending_step: 'deactivate_channel' })
        await channexRequest(this.env, `${path}/deactivate`, 'POST')
        await this.save(row, { pending_step: null })
      }
      await this.save(row, { pending_step: 'delete_channel' })
      await channexRequest(this.env, path, 'DELETE')
      await this.save(row, { channel_id: null, connected_at: null, status: 'not_connected', pending_step: null })
      if (row.setup_property_id) {
        await this.save(row, { pending_step: 'delete_setup_property' })
        await channexRequest(this.env, `/properties/${encodeURIComponent(row.setup_property_id)}`, 'DELETE')
        await this.save(row, { setup_property_id: null, pending_step: null })
      }
      return { disconnected: true }
    })
  }

  /**
   * Before the organization is deleted: disconnects Airbnb in Channex's
   * documented order (mappings, deactivate, delete), then deletes every
   * property in the organization's dedicated group with `force=true` and the
   * group itself, each verified gone. A property mapped here but outside the
   * group must already be gone. Any failure keeps the organization.
   */
  async deleteForOrganization(): Promise<void> {
    if (!await this.row()) return
    // Each disconnect call removes one mapping and verifies it before the next.
    // A channel Channex answers 404 for is already deleted.
    for (let row = await this.row(); row?.channel_id; row = await this.row()) {
      if (!await this.present(`/channels/${encodeURIComponent(row.channel_id)}`, 'channel')) {
        await this.locked(async locked => this.save(locked, { channel_id: null, connected_at: null, status: 'not_connected' }))
        break
      }
      if ((await this.disconnect()).disconnected) break
    }
    await this.locked(async (row) => {
      const mapped = (await this.mappings()).flatMap(mapping => mapping.property_id ? [mapping.property_id] : [])
      if (row.setup_property_id) mapped.push(row.setup_property_id)
      if (!row.group_id) {
        if (mapped.length) fail(500, 'INVALID_CONNECTION_MAPPING', 'This organization maps Channex properties without its Channex group.')
        return
      }
      const groupPath = `/groups/${encodeURIComponent(row.group_id)}`
      const group = await this.present(groupPath, 'group')
      const grouped = group ? provided(() => {
        const data = object(object(group.relationships, 'group.relationships').properties, 'group.relationships.properties').data
        if (!Array.isArray(data)) throw new ChannexDataError('group.relationships.properties.data must be a list')
        return data.map(entry => string(object(entry, 'group property').id, 'group property id'))
      }) : []
      for (const id of mapped.filter(id => !grouped.includes(id))) {
        if (await this.present(`/properties/${encodeURIComponent(id)}`, 'property')) fail(409, 'PROPERTY_OUTSIDE_GROUP', `Channex property ${id} is mapped here but is not in this organization's group.`)
      }
      const shared = await queryFirst<{ organization_id: string }>(this.db, `
        SELECT organization_id FROM product_channel_mappings WHERE provider = 'channex' AND organization_id <> ? AND property_id IN (SELECT value FROM json_each(?))
        UNION SELECT organization_id FROM channex_connections WHERE organization_id <> ? AND (group_id = ? OR setup_property_id IN (SELECT value FROM json_each(?)))
        LIMIT 1`, [this.organizationId, d1JsonStringSet(grouped), this.organizationId, row.group_id, d1JsonStringSet(grouped)])
      if (shared) fail(409, 'SHARED_PROVIDER_PROPERTY', 'A Channex property in this group belongs to another organization.')
      await execute(this.db, "UPDATE product_channel_mappings SET enabled = 0, updated_at = ? WHERE organization_id = ? AND provider = 'channex'", [now(), this.organizationId])
      for (const id of grouped) {
        const path = `/properties/${encodeURIComponent(id)}`
        await this.save(row, { pending_step: `delete_property:${id}` })
        await channexRequest(this.env, `${path}?force=true`, 'DELETE')
        // Channex accepted the delete, so a retry may send it again.
        await this.save(row, { pending_step: null })
        if (await this.present(path, 'property')) fail(502, 'PROVIDER_DELETION_PENDING', `Channex still has property ${id}.`)
      }
      if (group) {
        await this.save(row, { pending_step: 'delete_group' })
        await channexRequest(this.env, groupPath, 'DELETE')
        await this.save(row, { pending_step: null })
        if (await this.present(groupPath, 'group')) fail(502, 'PROVIDER_DELETION_PENDING', `Channex still has group ${row.group_id}.`)
      }
      await this.save(row, { group_id: null, setup_property_id: null })
    })
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

/** Airbnb states money as a decimal number; the catalog stores minor units of the organization's currency. */
function minorUnits(decimal: string, currency: string): number {
  if (!isCurrencyCode(currency)) throw new ChannexDataError(`Unsupported currency ${currency}`)
  const minor = Math.round(Number(decimal) * 10 ** currencyFractionDigits(currency))
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new ChannexDataError(`Airbnb rate ${decimal} ${currency} is not a positive amount in that currency`)
  return minor
}

function importedNight(night: ListingNight, currency: string) {
  return {
    date: night.date, available: night.availability === 1, price_minor: minorUnits(night.rate, currency), min_stay_arrival: night.minStay, min_stay_through: night.minStay,

    max_stay: night.maxStay === 0 ? null : night.maxStay, closed_to_arrival: night.closedToArrival, closed_to_departure: night.closedToDeparture,
  }
}
