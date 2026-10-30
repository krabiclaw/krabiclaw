import { channexList, channexRequest, type ChannexEnv } from './client'
import { ChannexDataError, integer, nullableString, object, resource, string, type Resource } from './data'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'

/**
 * An Airbnb guest asking to change a confirmed booking (docs.channex.io
 * "Airbnb Booking Requests", Alteration request): a live feed event whose
 * `payload.bms` is the booking as it would be after the change, answered with
 * `POST /live_feed/{id}/resolve`. Accepting changes nothing here directly:
 * once Airbnb confirms, the booking arrives as a new revision. Declining, and
 * a guest withdrawing on Airbnb, send no notification; the event itself is the
 * only record, so it is read back.
 *
 * `bms` is read as Channex staging served it on 2026-10-30, which differs from
 * a booking revision's attributes: `amount` is an integer in minor units,
 * occupancy is `occ_adults`/`occ_children`/`occ_infants`, and Airbnb's own
 * reservation (`raw_message.reservation`) says who asked, since a host can
 * propose a change on Airbnb that the guest then answers.
 */
export interface AlterationRequest {
  id: string
  propertyId: string
  bookingId: string
  /** The booking's Airbnb conversation in Channex, when the event names it. */
  messageThreadId: string | null
  insertedAt: string
  /** Who asked on Airbnb: a guest's request waits on the host, a host's change on the guest. */
  initiatedBy: 'guest' | 'host'
  /** Airbnb's outcome once resolved, from `payload.status`; null while it waits. */
  outcome: 'accepted' | 'declined' | 'withdrawn' | null
  after: { check_in_date: string; check_out_date: string; adults: number; children: number; infants: number; total_minor: number; currency: CurrencyCode }
}

const OUTCOMES = { ACCEPTED: 'accepted', DECLINED: 'declined', CANCELED: 'withdrawn' } as const

export function alterationRequest(event: Resource): AlterationRequest {
  const attributes = event.attributes
  if (attributes.event !== 'alteration_request') throw new ChannexDataError(`live feed event ${event.id} is ${String(attributes.event)}, not an alteration request`)
  const payload = object(attributes.payload, 'alteration_request.payload')
  if (typeof payload.resolved !== 'boolean') throw new ChannexDataError(`alteration request ${event.id} has no resolved flag`)
  const status = payload.resolved ? string(payload.status, 'alteration_request.payload.status') : null
  if (status !== null && !(status in OUTCOMES)) throw new ChannexDataError(`alteration request ${event.id} has unknown status ${status}`)
  const bms = object(payload.bms, 'alteration_request.payload.bms')
  const bookingId = string(bms.booking_id, 'bms.booking_id')
  const currency = string(bms.currency, 'bms.currency')
  if (!isCurrencyCode(currency)) throw new ChannexDataError(`alteration request ${event.id} is in unsupported currency ${currency}`)
  const initiatedBy = object(object(bms.raw_message, 'bms.raw_message').reservation, 'bms.raw_message.reservation').initiated_by
  if (initiatedBy !== 'guest' && initiatedBy !== 'host') throw new ChannexDataError(`alteration request ${event.id} was initiated by ${String(initiatedBy)}, not the guest or the host`)
  return {
    id: event.id,
    propertyId: string(attributes.property_id, 'alteration_request.property_id'),
    bookingId,
    messageThreadId: nullableString(payload.message_thread_id ?? null, 'alteration_request.payload.message_thread_id'),
    insertedAt: string(attributes.inserted_at, 'alteration_request.inserted_at'),
    initiatedBy,
    outcome: status === null ? null : OUTCOMES[status as keyof typeof OUTCOMES],
    after: {
      check_in_date: string(bms.arrival_date, 'bms.arrival_date'), check_out_date: string(bms.departure_date, 'bms.departure_date'),
      adults: integer(bms.occ_adults, 'bms.occ_adults', 1), children: integer(bms.occ_children, 'bms.occ_children'), infants: integer(bms.occ_infants, 'bms.occ_infants'),
      total_minor: integer(bms.amount, 'bms.amount'), currency,
    },
  }
}

export async function readAlterationRequest(env: ChannexEnv, id: string): Promise<AlterationRequest> {
  const body = await channexRequest(env, `/live_feed/${encodeURIComponent(id)}`)
  return alterationRequest(resource(body.data, 'live_feed_event'))
}

/** The alteration requests of one property, or of the whole account, newest first, as Channex lists them. */
export async function listAlterationRequests(env: ChannexEnv, propertyId?: string): Promise<AlterationRequest[]> {
  const filter = { 'filter[event]': 'alteration_request', ...(propertyId ? { 'filter[property_id]': propertyId } : {}) }
  return (await channexList(env, '/live_feed', 'live_feed_event', filter)).map(alterationRequest)
}

/**
 * Answer one request and read back what Channex stored. Resolving one already
 * resolved returns it unchanged, so the outcome read back, not the decision
 * sent, is the answer.
 */
export async function resolveAlterationRequest(env: ChannexEnv, id: string, decision: 'accept' | 'decline'): Promise<AlterationRequest> {
  await channexRequest(env, `/live_feed/${encodeURIComponent(id)}/resolve`, 'POST', { resolution: { accept: decision } })
  return readAlterationRequest(env, id)
}
