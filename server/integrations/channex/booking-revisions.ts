import { execute, queryFirst, type DbClient } from '~/server/db'
import { applyChannelBooking, type ChannelBooking } from '~/server/domain/stays'
import { currencyFractionDigits, isCurrencyCode } from '~/shared/currencies'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'
import { channexGet, channexList, channexRequest, type ChannexEnv } from './client'
import { ChannexDataError, integer, nullableString, object, string, type Resource } from './data'

import type { GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'

/**
 * Channel bookings arriving through Channex. A revision is the booking as the
 * channel sent it (docs.channex.io Bookings Collection: a booking is its
 * latest revision), so the revision itself is landed as a channel stay and
 * only then acknowledged; the booking is never read by id, which Channex's
 * certification refuses. Anything that stops short of the acknowledgement
 * throws, so the webhook answers non-2xx and Channex's unacknowledged-revision
 * feed brings it back.
 *
 * channel_sync_log records each outcome with ids only, never guest details.
 */

export type RevisionOutcome = { status: 'acknowledged'; stay_id: string; overbooked: boolean } | { status: 'ignored_disconnected' }

interface Mapping { organization_id: string; product_id: string; enabled: number }

// Channex's ota_name, lowercased. Its booking documentation shows Booking.com as both
// "Booking.com" and "BookingCom".
const CHANNELS: Record<string, ChannelBooking['channel']> = { 'airbnb': 'airbnb', 'vrbo': 'vrbo', 'booking.com': 'booking_com', 'bookingcom': 'booking_com' }

async function log(db: DbClient, entry: { organizationId: string | null; productId: string | null; revisionId: string; status: 'applied' | 'ignored_disconnected' | 'failed'; detail?: string }): Promise<string> {
  const id = crypto.randomUUID()
  await execute(db, `INSERT INTO channel_sync_log (id, organization_id, product_id, provider, direction, kind, external_id, status, detail)
    VALUES (?, ?, ?, 'channex', 'inbound', 'booking_revision', ?, ?, ?)`,
  [id, entry.organizationId, entry.productId, entry.revisionId, entry.status, entry.detail ?? null])
  return id
}

function minorUnits(amount: string, currency: string, bookingId: string): number {
  if (!isCurrencyCode(currency)) throw new ChannexDataError(`booking ${bookingId} is in unsupported currency ${currency}`)
  if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new ChannexDataError(`booking ${bookingId} amount must be a decimal string`)
  return Math.round(Number(amount) * 10 ** currencyFractionDigits(currency))
}

/**
 * The booking as the revision states it. Its order is the revision's time: a
 * booking keeps its creation time across modifications and cancellation, so
 * only the revision tells a later state from an earlier one, and a revision
 * older than the stay's current one changes nothing when it lands.
 */
function revisedBooking(revision: Resource, propertyId: string): ChannelBooking {
  const attributes = revision.attributes
  const bookingId = string(attributes.booking_id, 'booking_id')
  if (attributes.property_id !== propertyId) throw new ChannexDataError(`revision ${revision.id} does not belong to property ${propertyId}`)
  const status = string(attributes.status, 'booking status')
  if (status !== 'new' && status !== 'modified' && status !== 'cancelled') throw new ChannexDataError(`booking ${bookingId} has unknown status ${status}`)
  const channel = CHANNELS[string(attributes.ota_name, 'ota_name').toLowerCase()]
  if (!channel) throw new ChannexDataError(`booking ${bookingId} comes from ${String(attributes.ota_name)}, which KrabiClaw does not take yet`)
  const customer = object(attributes.customer, 'customer')
  const occupancy = object(attributes.occupancy, 'occupancy')
  const currency = string(attributes.currency, 'currency')
  return {
    provider: 'channex', external_booking_id: bookingId, channel,
    channel_booking_id: nullableString(attributes.ota_reservation_code ?? null, 'ota_reservation_code'),
    revision_id: revision.id, provider_updated_at: string(attributes.inserted_at, 'revision inserted_at'),
    cancelled: status === 'cancelled',
    check_in_date: string(attributes.arrival_date, 'arrival_date'), check_out_date: string(attributes.departure_date, 'departure_date'),
    adults: integer(occupancy.adults, 'adults', 1), children: integer(occupancy.children, 'children'), infants: integer(occupancy.infants, 'infants'),
    guest_name: nullableString(customer.name ?? null, 'customer.name'), guest_surname: nullableString(customer.surname ?? null, 'customer.surname'),
    guest_email: nullableString(customer.mail ?? null, 'customer.mail'), guest_phone: nullableString(customer.phone ?? null, 'customer.phone'),
    total_minor: minorUnits(string(attributes.amount, 'amount'), currency, bookingId), currency,
  }
}

/** One revision: read, land, acknowledge. Throws on anything short of the acknowledgement. */
export async function applyBookingRevision(db: DbClient, env: ChannexEnv & GuestInboxPublicationEnv, revisionId: string): Promise<RevisionOutcome> {
  let revision: Resource
  try {
    revision = await channexGet(env, `/booking_revisions/${encodeURIComponent(revisionId)}`, 'booking_revision')
  } catch (error) {
    await log(db, { organizationId: null, productId: null, revisionId, status: 'failed', detail: describeErrorForTelemetry(error) })
    throw error
  }
  return landBookingRevision(db, env, revision)
}


/**
 * The revisions of one booking that Channex has not had acknowledged, oldest
 * first, from its feed: how a booking that arrived some other way (a message
 * thread naming it) is landed before anything is built on it.
 */
export async function pendingBookingRevisions(env: ChannexEnv, propertyId: string, bookingId: string): Promise<Resource[]> {
  const revisions = await channexList(env, '/booking_revisions/feed', 'booking_revision', { 'filter[property_id]': propertyId, 'order[inserted_at]': 'asc' })
  return revisions.filter(revision => revision.attributes.booking_id === bookingId)
}

/** Land one revision Channex delivered and acknowledge it. */
export async function landBookingRevision(db: DbClient, env: ChannexEnv & GuestInboxPublicationEnv, revision: Resource): Promise<RevisionOutcome> {
  const revisionId = revision.id
  let mapping: Mapping | null = null
  try {
    const propertyId = string(revision.attributes.property_id, 'property_id')
    mapping = await queryFirst<Mapping>(db, "SELECT organization_id, product_id, enabled FROM product_channel_mappings WHERE provider = 'channex' AND property_id = ?", [propertyId])
    if (!mapping || mapping.enabled !== 1) {
      // D-G: a home nobody connected, or one disconnected, takes nothing; the revision is logged and acknowledged.
      await log(db, { organizationId: mapping?.organization_id ?? null, productId: mapping?.product_id ?? null, revisionId, status: 'ignored_disconnected', detail: `property ${propertyId}` })
      await channexRequest(env, `/booking_revisions/${encodeURIComponent(revisionId)}/ack`, 'POST', {})
      return { status: 'ignored_disconnected' }
    }
    const stay = await applyChannelBooking(db, env, mapping.organization_id, mapping.product_id, revisedBooking(revision, propertyId))
    // The outcome is recorded before the acknowledgement: once Channex drops the
    // revision from its feed it cannot be recovered from there. The row reads
    // `applied` until the acknowledgement is confirmed.
    const entry = await log(db, { organizationId: mapping.organization_id, productId: mapping.product_id, revisionId, status: 'applied', detail: stay.overbooked ? 'overbooked' : undefined })
    await channexRequest(env, `/booking_revisions/${encodeURIComponent(revisionId)}/ack`, 'POST', {})
    await execute(db, "UPDATE channel_sync_log SET status = 'acknowledged' WHERE id = ?", [entry])
    return { status: 'acknowledged', stay_id: stay.id, overbooked: stay.overbooked }
  } catch (error) {
    await log(db, { organizationId: mapping?.organization_id ?? null, productId: mapping?.product_id ?? null, revisionId, status: 'failed', detail: describeErrorForTelemetry(error) })
    throw error
  }
}

/**
 * Channex's unacknowledged revisions, oldest first: the required backup for a
 * webhook that never arrived or failed. Every revision is tried; the run fails
 * naming the ones that did not land.
 */
export async function runRevisionFeed(db: DbClient, env: ChannexEnv & GuestInboxPublicationEnv): Promise<{ acknowledged: number; ignored: number }> {
  const revisions = await channexList(env, '/booking_revisions/feed', 'booking_revision', { 'order[inserted_at]': 'asc' })
  let acknowledged = 0
  let ignored = 0
  const failures: string[] = []
  for (const revision of revisions) {
    try {
      const outcome = await landBookingRevision(db, env, revision)
      if (outcome.status === 'acknowledged') acknowledged += 1
      else ignored += 1
    } catch (error) {
      failures.push(`${revision.id}: ${describeErrorForTelemetry(error)}`)
    }
  }
  if (failures.length) throw new Error(`${failures.length} Channex booking revision(s) did not land: ${failures.join('; ')}`)
  return { acknowledged, ignored }
}
