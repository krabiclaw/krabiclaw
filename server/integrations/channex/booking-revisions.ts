import { execute, queryFirst, type DbClient } from '~/server/db'
import { applyChannelBooking, type ChannelBooking } from '~/server/domain/stays'
import { currencyFractionDigits, isCurrencyCode } from '~/shared/currencies'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'
import { channexGet, channexList, channexRequest, type ChannexEnv } from './client'
import { ChannexDataError, integer, nullableString, object, string } from './data'

/**
 * Airbnb bookings arriving through Channex. A revision names a booking that
 * changed; the booking's current state is read and landed as a channel stay,
 * and only then is the revision acknowledged. Anything that stops short of
 * the acknowledgement throws, so the webhook answers non-2xx and Channex's
 * unacknowledged-revision feed brings it back.
 *
 * channel_sync_log records each outcome with ids only, never guest details.
 */

export type RevisionOutcome = { status: 'acknowledged'; stay_id: string; overbooked: boolean } | { status: 'ignored_disconnected' }

interface Mapping { organization_id: string; product_id: string; enabled: number }

const CHANNELS: Record<string, ChannelBooking['channel']> = { airbnb: 'airbnb', vrbo: 'vrbo' }

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
 * The booking's current state, read from Channex and checked against the
 * property the revision named. Its order is its current revision's time: a
 * booking keeps its creation time across modifications and cancellation, so
 * only the revision tells a later state from an earlier one.
 */
async function currentBooking(env: ChannexEnv, bookingId: string, propertyId: string, delivered: { id: string; insertedAt: string }): Promise<ChannelBooking> {
  const booking = await channexGet(env, `/bookings/${encodeURIComponent(bookingId)}`, 'booking')
  const attributes = booking.attributes
  if (booking.id !== bookingId || attributes.property_id !== propertyId) throw new ChannexDataError(`booking ${bookingId} does not belong to property ${propertyId}`)
  const status = string(attributes.status, 'booking status')
  if (status !== 'new' && status !== 'modified' && status !== 'cancelled') throw new ChannexDataError(`booking ${bookingId} has unknown status ${status}`)
  const channel = CHANNELS[string(attributes.ota_name, 'ota_name').toLowerCase()]
  if (!channel) throw new ChannexDataError(`booking ${bookingId} comes from ${String(attributes.ota_name)}, which Krabiclaw does not take yet`)
  const currentRevision = string(attributes.revision_id, 'revision_id')
  const revisedAt = currentRevision === delivered.id
    ? delivered.insertedAt
    : string((await channexGet(env, `/booking_revisions/${encodeURIComponent(currentRevision)}`, 'booking_revision')).attributes.inserted_at, 'revision inserted_at')
  const customer = object(attributes.customer, 'customer')
  const occupancy = object(attributes.occupancy, 'occupancy')
  const currency = string(attributes.currency, 'currency')
  return {
    provider: 'channex', external_booking_id: booking.id, channel,
    channel_booking_id: nullableString(attributes.ota_reservation_code ?? null, 'ota_reservation_code'),
    revision_id: currentRevision, provider_updated_at: revisedAt,
    cancelled: status === 'cancelled',
    check_in_date: string(attributes.arrival_date, 'arrival_date'), check_out_date: string(attributes.departure_date, 'departure_date'),
    adults: integer(occupancy.adults, 'adults', 1), children: integer(occupancy.children, 'children'), infants: integer(occupancy.infants, 'infants'),
    guest_name: nullableString(customer.name ?? null, 'customer.name'), guest_surname: nullableString(customer.surname ?? null, 'customer.surname'),
    guest_email: nullableString(customer.mail ?? null, 'customer.mail'), guest_phone: nullableString(customer.phone ?? null, 'customer.phone'),
    total_minor: minorUnits(string(attributes.amount, 'amount'), currency, booking.id), currency,
  }
}

/** One revision: read, land, acknowledge. Throws on anything short of the acknowledgement. */
export async function applyBookingRevision(db: DbClient, env: ChannexEnv, revisionId: string): Promise<RevisionOutcome> {
  let mapping: Mapping | null = null
  try {
    const revision = await channexGet(env, `/booking_revisions/${encodeURIComponent(revisionId)}`, 'booking_revision')
    const propertyId = string(revision.attributes.property_id, 'property_id')
    mapping = await queryFirst<Mapping>(db, "SELECT organization_id, product_id, enabled FROM product_channel_mappings WHERE provider = 'channex' AND property_id = ?", [propertyId])
    if (!mapping || mapping.enabled !== 1) {
      // D-G: a home nobody connected, or one disconnected, takes nothing; the revision is logged and acknowledged.
      await log(db, { organizationId: mapping?.organization_id ?? null, productId: mapping?.product_id ?? null, revisionId, status: 'ignored_disconnected', detail: `property ${propertyId}` })
      await channexRequest(env, `/booking_revisions/${encodeURIComponent(revisionId)}/ack`, 'POST', {})
      return { status: 'ignored_disconnected' }
    }
    const booking = await currentBooking(env, string(revision.attributes.booking_id, 'booking_id'), propertyId, { id: revision.id, insertedAt: string(revision.attributes.inserted_at, 'revision inserted_at') })
    const stay = await applyChannelBooking(db, mapping.organization_id, mapping.product_id, booking)
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
export async function runRevisionFeed(db: DbClient, env: ChannexEnv): Promise<{ acknowledged: number; ignored: number }> {
  const revisions = await channexList(env, '/booking_revisions/feed', 'booking_revision', { 'order[inserted_at]': 'asc' })
  let acknowledged = 0
  let ignored = 0
  const failures: string[] = []
  for (const revision of revisions) {
    try {
      const outcome = await applyBookingRevision(db, env, revision.id)
      if (outcome.status === 'acknowledged') acknowledged += 1
      else ignored += 1
    } catch (error) {
      failures.push(`${revision.id}: ${describeErrorForTelemetry(error)}`)
    }
  }
  if (failures.length) throw new Error(`${failures.length} Channex booking revision(s) did not land: ${failures.join('; ')}`)
  return { acknowledged, ignored }
}
