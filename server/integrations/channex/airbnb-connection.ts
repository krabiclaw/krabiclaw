import { HTTPError } from 'nitro'
import { d1JsonStringSet, execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { createStayHome, importStayNights, stayHomeInput, type StayAccess } from '~/server/domain/stays'
import { currencyFractionDigits, isCurrencyCode } from '~/shared/currencies'
import { isValidTimezone } from '~/utils/timezone'
import { channexCreate, channexGet, channexRequest, ChannexError } from './client'
import { ChannexDataError, object, relationship, string, type JsonRecord, type Resource } from './data'
import { CALENDAR_NIGHTS, DETAIL_FIELDS, PROPERTY_TYPES, listingCalendar, listingDetails, type DetailField, type ListingDetails, type OrganizationContact, type ListingNight } from './airbnb-listing'
import { installChannexMessages } from './messages'
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

export const IMPORT_STAGES = ['property', 'room', 'rate', 'inventory', 'verify_inventory', 'mapping', 'activate', 'reservations', 'messages', 'complete'] as const
export type ImportStage = typeof IMPORT_STAGES[number]

export interface AirbnbListing {
  id: string
  title: string
  city: string
  country_code: string
  import: { status: 'not_imported' } | { status: 'imported'; product_id: string; stage: ImportStage }
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
  child_beds: number
  infant_cots: number
  default_occupancy: number
  nightly_rate: string
}

/** What the host supplies at import: the listing fields Airbnb left out, and the stay times it never gives. */
export interface ImportInput {
  missingDetails: Partial<Record<DetailField, unknown>>
  checkInTime: unknown
  checkOutTime: unknown
}


/** Where Airbnb sends the person back after signing in: the native app. */
export const AIRBNB_CALLBACK = 'krabiclaw://airbnb/callback'
const SIGN_IN_LIFETIME_MS = 2 * 60 * 60 * 1000
/** A lock untouched this long belongs to a request that ended without releasing it. */
const ABANDONED_LOCK_MS = 15 * 60 * 1000

function fail(statusCode: number, code: string, message: string): never {
  throw new HTTPError({ statusCode, message, data: { code } })
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
  private readonly env: CloudflareEnv
  private readonly organizationId: string
  private readonly userId: string

  constructor(db: DbClient, env: CloudflareEnv, organizationId: string, userId: string) {
    this.db = db
    this.env = env
    this.organizationId = organizationId
    this.userId = userId
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
    if (!taken.meta.changes) fail(409, 'CONNECTION_BUSY', 'Airbnb setup is running or needs review. Refresh before continuing.')
    const row = (await this.row())!
    try {
      if (row.status === 'needs_review') fail(409, 'CONNECTION_NEEDS_REVIEW', 'This Airbnb connection needs support review before continuing.')
      const result = await action(row)
      await this.save(row, { operation_id: null, pending_step: null })
      return result
    } catch (error) {
      // A write that was sent and not provably refused stays locked for review.
      const uncertain = row.pending_step !== null && !(error instanceof ChannexError && !error.uncertain)
      await this.save(row, uncertain ? { status: 'needs_review' } : { operation_id: null, pending_step: null })
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
    if (!row || row.status !== 'connected' || !row.channel_id || row.operation_id) fail(409, 'NOT_CONNECTED', 'Connect your Airbnb account first.')
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
      return { ...listing, import: mapping ? { status: 'imported', product_id: mapping.product_id, stage: mapping.import_stage } : { status: 'not_imported' } }
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
   * the organization settings validate them.
   */
  private async saveOrganizationContact(details: ListingDetails, values: Record<DetailField, string>): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (details.missingFields.includes('email')) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) fail(422, 'INVALID_DETAIL', 'Enter a valid contact email')
      sets.push('contact_email = ?')
      params.push(values.email.toLowerCase())
    }
    if (details.missingFields.includes('phone')) {
      if (values.phone.length > 32) fail(422, 'INVALID_DETAIL', 'Contact phone must be 32 characters or fewer')
      sets.push('contact_phone = ?')
      params.push(values.phone)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?', 'updated_by = ?')
    params.push(now(), this.userId, this.organizationId)
    await execute(this.db, `UPDATE organization SET ${sets.join(', ')} WHERE id = ?`, params)
  }

  /**
   * Creates the home a listing becomes: its location, its stay product and
   * price, its imported nights, and the mapping the import advances. Billing
   * for the new location applies as it does to any location. Calling it
   * again for the same listing returns the import already under way.
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
        await execute(this.db, "UPDATE product_channel_mappings SET channel_id = ?, import_stage = 'inventory', updated_at = ? WHERE product_id = ? AND provider = 'channex'", [channelId, now(), existing.product_id])
        return { product_id: existing.product_id, stage: 'inventory', waiting: false }
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
      for (const key of ['childBeds', 'infantCots'] as const) {
        if (!/^\d+$/.test(values[key]) || Number(values[key]) > details.maxGuests) fail(422, 'INVALID_DETAIL', `${key} must be between zero and the guest capacity`)
      }
      if (details.defaultOccupancy > details.maxGuests) fail(422, 'INVALID_DETAIL', "The included guest count exceeds the listing's capacity")
      const organization = await queryFirst<{ default_currency: string }>(this.db, 'SELECT default_currency FROM organization WHERE id = ?', [this.organizationId])
      if (!organization || !isCurrencyCode(organization.default_currency)) throw new Error(`Organization ${this.organizationId} has no supported default currency`)
      if (details.currency !== organization.default_currency) {
        fail(422, 'CURRENCY_MISMATCH', `This listing is priced in ${details.currency} and this organization sells in ${organization.default_currency}. Import stopped; nothing was created.`)
      }
      if (!isValidTimezone(values.timezone)) fail(422, 'INVALID_DETAIL', 'Choose a valid time zone')
      const calendar = await listingCalendar(this.env, channelId, listingId, values.timezone)
      // Every check has passed, so what the host typed becomes the organization's contact.
      await this.saveOrganizationContact(details, values)
      // The home itself is checked and made as a home added by hand is: billed as a home, and refused past the homes Basic includes.
      const home = await createStayHome(this.env, this.db, this.manager(), stayHomeInput({
        name: details.title, timezone: values.timezone, address: values.address, city: values.city, state: values.state, country: values.country,
        zip_code: values.zipCode, phone: values.phone, email: values.email, check_in_time: input.checkInTime, check_out_time: input.checkOutTime,
        max_guests: details.maxGuests, min_nights: calendar[0]!.minStay, base_price_minor: provided(() => minorUnits(details.nightlyRate, organization.default_currency)),
      }), `airbnb-listing:${listingId}`)
      const property: ImportProperty = {
        title: details.title, currency: details.currency, timezone: values.timezone, property_type: values.propertyType, email: values.email, phone: values.phone,
        country: values.country, state: values.state, city: values.city, address: values.address, zip_code: values.zipCode, max_guests: details.maxGuests,
        child_beds: Number(values.childBeds), infant_cots: Number(values.infantCots), default_occupancy: details.defaultOccupancy, nightly_rate: details.nightlyRate,
      }
      // The nights land before the mapping: until the mapping exists a retry
      // runs this whole step again (the location and product replay by their
      // idempotency key, the nights upsert), so no import is left without its calendar.
      await importStayNights(this.db, this.env, this.manager(), home.product_id, provided(() => calendar.map(night => importedNight(night, organization.default_currency))))
      await execute(this.db, `INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, import_stage, import_property, import_calendar)
        VALUES (?, ?, 'channex', ?, ?, 'property', ?, ?) ON CONFLICT (product_id, provider) DO NOTHING`,
      [this.organizationId, home.product_id, listingId, channelId, JSON.stringify(property), JSON.stringify(calendar)])
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
  async advance(productId: string): Promise<{ product_id: string; stage: ImportStage; waiting: boolean }> {
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
      const calendar = mapping.import_calendar ? JSON.parse(mapping.import_calendar) as ListingNight[] : null
      const save = async (values: Partial<Pick<MappingRow, 'property_id' | 'room_type_id' | 'rate_plan_id' | 'import_stage' | 'import_property' | 'import_calendar' | 'enabled'>>) => {
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
            address: property.address, zip_code: property.zip_code, settings: { state_length: CALENDAR_NIGHTS, min_stay_type: 'arrival' },
          } }, 'property')
          await save({ property_id: created.id, import_stage: 'room' })
          break
        }
        case 'room': {
          if (!property) throw new Error(`Import of ${productId} has no approved listing details`)
          await wrote('import_room')
          const created = await channexCreate(this.env, '/room_types', { room_type: {
            property_id: mapping.property_id, title: 'Entire home', count_of_rooms: 1, occ_adults: property.max_guests, occ_children: property.child_beds,
            occ_infants: property.infant_cots, default_occupancy: property.default_occupancy, room_kind: 'room',
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
          if (!property) throw new Error(`Import of ${productId} has no approved listing details`)
          const days = calendar ?? await listingCalendar(this.env, channelId, mapping.listing_id, property.timezone)
          if (!calendar) await save({ import_calendar: JSON.stringify(days) })
          await wrote('import_calendar')
          const results = [
            await channexRequest(this.env, '/restrictions', 'POST', { values: days.map(day => ({
              property_id: mapping.property_id, rate_plan_id: mapping.rate_plan_id, date: day.date, rate: day.rate, min_stay_arrival: day.minStay,
              max_stay: day.maxStay, closed_to_arrival: day.closedToArrival, closed_to_departure: day.closedToDeparture, stop_sell: day.availability === 0,
            })) }),
            await channexRequest(this.env, '/availability', 'POST', { values: days.map(day => ({ property_id: mapping.property_id, room_type_id: mapping.room_type_id, date: day.date, availability: day.availability })) }),
          ]
          for (const result of results) {
            const meta = provided(() => object(result.meta, 'Inventory result'))
            if (meta.message !== 'Success' || (meta.warnings !== undefined && (!Array.isArray(meta.warnings) || meta.warnings.length > 0))) {
              fail(502, 'PROVIDER_VERIFICATION_FAILED', 'Channex rejected part of the calendar. The import needs review before connecting Airbnb.')
            }
          }
          await save({ import_stage: 'verify_inventory' })
          break
        }
        case 'verify_inventory': {
          if (!calendar?.length) throw new Error(`Import of ${productId} has no source calendar to verify`)
          const matches = await this.inventoryMatches(mapping as MappingRow & { property_id: string; room_type_id: string; rate_plan_id: string }, calendar)
          if (!matches) return { product_id: productId, stage, waiting: true }
          await save({ import_stage: 'mapping' })
          break
        }
        case 'mapping': {
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
          await save({ import_stage: 'reservations', enabled: 1 })
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
          await save({ import_stage: 'complete', import_property: null, import_calendar: null })
          break
        }
        case 'complete':
          break
      }
      await wrote(null)
      return { product_id: productId, stage: mapping.import_stage, waiting: false }
    })
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
  private async inventoryMatches(mapping: MappingRow & { property_id: string; room_type_id: string; rate_plan_id: string }, days: ListingNight[]): Promise<boolean> {
    const query = new URLSearchParams({ 'filter[property_id]': mapping.property_id, 'filter[date][gte]': days[0]!.date, 'filter[date][lte]': days.at(-1)!.date })
    const availability = await channexRequest(this.env, `/availability?${query}`)
    query.set('filter[restrictions]', 'rate,min_stay_arrival,max_stay,closed_to_arrival,closed_to_departure,stop_sell')
    const restrictions = await channexRequest(this.env, `/restrictions?${query}`)
    return provided(() => {
      const available = object(object(availability.data, 'availability')[mapping.room_type_id], 'room type availability')
      const rates = object(object(restrictions.data, 'restrictions')[mapping.rate_plan_id], 'rate plan restrictions')
      return days.every((day) => {
        const count = available[day.date]
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new ChannexDataError(`availability on ${day.date} must be a non-negative integer`)
        const rule = object(rates[day.date], `restrictions on ${day.date}`)
        const rate = Number(rule.rate)
        if (!Number.isFinite(rate) || rate < 0) throw new ChannexDataError(`rate on ${day.date} must be a non-negative number`)
        // A new rate plan reads zero until its inventory update is applied, which is "not yet", not an error.
        return count === day.availability && rate === Number(day.rate) && rule.min_stay_arrival === day.minStay && rule.max_stay === day.maxStay
          && rule.closed_to_arrival === day.closedToArrival && rule.closed_to_departure === day.closedToDeparture && rule.stop_sell === (day.availability === 0)
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
      await execute(this.db, "UPDATE product_channel_mappings SET enabled = 0, updated_at = ? WHERE organization_id = ? AND provider = 'channex' AND channel_id = ?", [now(), this.organizationId, channel.id])
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
      if (error instanceof ChannexError && error.status === 404) return null
      throw error
    }
  }
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
    date: night.date, available: night.availability === 1, price_minor: minorUnits(night.rate, currency), min_stay_arrival: night.minStay,
    max_stay: night.maxStay === 0 ? null : night.maxStay, closed_to_arrival: night.closedToArrival, closed_to_departure: night.closedToDeparture,
  }
}
