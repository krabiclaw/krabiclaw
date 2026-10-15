import { HTTPError } from 'nitro'
import { execute, queryFirst, type DbClient } from '~/server/db'
import { channexCreate, channexGet, channexRequest, ChannexError, type ChannexEnv } from './client'
import { ChannexDataError, object, relationship, string, type JsonRecord, type Resource } from './data'

/**
 * An organization's Airbnb account, connected through Channex: start a
 * single-use sign-in, complete it from the callback, read the account's
 * listings, and disconnect. Ported from the lodging Worker's AirbnbService.
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

export interface AirbnbListing { id: string; title: string; city: string; country_code: string }

/** Where Airbnb sends the person back after signing in: the native app. */
export const AIRBNB_CALLBACK = 'krabiclaw://airbnb/callback'
const SIGN_IN_LIFETIME_MS = 2 * 60 * 60 * 1000

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
  private readonly env: ChannexEnv
  private readonly organizationId: string
  private readonly userId: string

  constructor(db: DbClient, env: ChannexEnv, organizationId: string, userId: string) {
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
    const taken = await execute(this.db, 'UPDATE channex_connections SET operation_id = ?, updated_at = ? WHERE organization_id = ? AND operation_id IS NULL', [operationId, now(), this.organizationId])
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

  /** The channel, verified to be this organization's Airbnb channel and to map only its properties. */
  private async channel(row: ConnectionRow, channelId: string, allowedProperties: ReadonlySet<string>): Promise<Resource & { properties: string[]; ratePlans: JsonRecord[]; active: boolean }> {
    const channel = await channexGet(this.env, `/channels/${encodeURIComponent(channelId)}`, 'channel')
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
      return { ...channel, properties, ratePlans, active: attributes.is_active }
    })
  }

  async status(): Promise<{ status: ConnectionStatus; connected_at: string | null; listing_count: number }> {
    const row = await this.row()
    if (!row) return { status: 'not_connected', connected_at: null, listing_count: 0 }
    if (row.status !== 'connected') return { status: row.status, connected_at: row.connected_at, listing_count: 0 }
    const channel = await this.channel(row, row.channel_id!, new Set())
    return { status: row.status, connected_at: row.connected_at, listing_count: channel.ratePlans.length }
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
        const group = await channexCreate(this.env, '/groups', { group: { title: `Krabiclaw ${this.organizationId}` } }, 'group')
        await this.save(row, { group_id: group.id, pending_step: null })
      }
      if (!row.setup_property_id) {
        await this.save(row, { pending_step: 'create_setup_property' })
        const property = await channexCreate(this.env, '/properties', { property: { title: 'Krabiclaw connection setup', currency: 'USD', property_type: 'apartment', group_id: row.group_id } }, 'property')
        await this.save(row, { setup_property_id: property.id, pending_step: null })
      }
      const state = crypto.randomUUID() + crypto.randomUUID()
      const title = `Krabiclaw ${crypto.randomUUID()}`
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
      const channel = await this.channel(row, channelId, new Set())
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

  /** The listings on the connected Airbnb account. */
  async listings(): Promise<AirbnbListing[]> {
    const row = await this.connected()
    await this.channel(row, row.channel_id, new Set())
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

  /**
   * Removes the connection one mapping per call (each removal is verified
   * before the next), then deactivates and deletes the channel and the setup
   * property. `disconnected: false` means call again.
   */
  async disconnect(): Promise<{ disconnected: boolean }> {
    return await this.locked(async (row) => {
      if (!row.channel_id) fail(409, 'NOT_CONNECTED', 'There is no completed Airbnb connection to disconnect.')
      let channel = await this.channel(row, row.channel_id, new Set())
      const path = `/channels/${encodeURIComponent(channel.id)}`
      await this.save(row, { status: 'disconnecting' })
      const first = channel.ratePlans[0]
      if (first !== undefined) {
        const mappingId = provided(() => string(first.id, 'Mapping id'))
        await this.save(row, { pending_step: `remove_mapping:${mappingId}` })
        await channexRequest(this.env, `${path}/mappings/${encodeURIComponent(mappingId)}`, 'DELETE')
        channel = await this.channel(row, channel.id, new Set())
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
}
