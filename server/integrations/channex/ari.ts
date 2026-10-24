import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import type { StayHome, StayNight } from '~/server/domain/stays'
import { currencyFractionDigits, type CurrencyCode } from '~/shared/currencies'
import { channexRequest, ChannexError, type ChannexEnv } from './client'
import { ChannexDataError, object } from './data'
import { HTTPError } from 'nitro'
import type { ChannelPush, SuccessfulChannelPush } from '~/shared/channel-push'

/** A raw push failure is not a persisted review outcome. Its writer must complete it. */
export type ChannelPushCompletion = ChannelPush | Error | null

/** Publish committed state before reporting every failed completion step. */
export async function completeChannelPush<T extends object>(outcome: ChannelPushCompletion, context: {
  product_id: string; updated_at?: string; ranges?: ReadonlyArray<readonly [string, string]>; stay_id?: string; version?: number
}, complete: () => Promise<T>): Promise<T & { channel_push: SuccessfulChannelPush | null }> {
  let completed: { ok: true; value: T } | { ok: false; error: unknown }
  try { completed = { ok: true, value: await complete() } } catch (error) { completed = { ok: false, error } }
  if (outcome instanceof Error || outcome?.state === 'needs_review') {
    const reason = outcome instanceof Error ? outcome.message : outcome.detail
    const failures = [reason, ...(!completed.ok ? [completed.error instanceof Error ? completed.error.message : String(completed.error)] : [])]
    throw new HTTPError({ statusCode: 503, message: `The changes were saved, but the channel update did not complete. ${failures.join(' ')} Reload the calendar before retrying.`,
      data: { ...context, ...(context.ranges ? { ranges: context.ranges.map(([from, to]) => ({ from, to })) } : {}),
        code: 'CHANNEL_PUSH_FAILED', field: 'channel_push', committed: true, reason,
        ...(outcome instanceof Error ? { channel_outcome: 'unknown' } : { channel_push: outcome }) },
      cause: !completed.ok ? new AggregateError([outcome, completed.error], failures.join(' ')) : outcome instanceof Error ? outcome : undefined })
  }
  if (!completed.ok) {
    const error = completed.error
    if (error instanceof HTTPError && error.data?.committed === true) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new HTTPError({ statusCode: 503, message: `The changes were saved, but their completion failed. ${reason}`,
      data: { ...context, ...(context.ranges ? { ranges: context.ranges.map(([from, to]) => ({ from, to })) } : {}),
        code: 'POST_WRITE_COMPLETION_FAILED', field: 'completion', committed: true, reason, channel_push: outcome }, cause: error })
  }
  return { ...completed.value, channel_push: outcome }
}

/**
 * Outbound availability, prices and stay rules for a home connected through
 * Channex. KrabiClaw is the master. A change marks its nights pending in
 * channel_night_pushes, the delivery outbox; delivery reads the home's due
 * pending nights as they are now and sends Channex only what differs from
 * what Channex last confirmed for each (sent_json): at most one restrictions
 * call and one availability call per home.
 *
 * Channex takes 10 restrictions and 10 availability calls per property per
 * minute and blocks the property for the rest of that minute after a 429
 * (docs.channex.io rate-limits). Delivery counts this home's calls in the last
 * minute from channel_sync_log and leaves the nights pending with their retry
 * time instead of exceeding the limit, and waits a minute after a 429. A call
 * Channex did not confirm is sent again after a doubling wait; ARI values are
 * absolute, so sending one twice changes nothing. A refusal, a partial
 * rejection (200 with meta.warnings), or a fifth unconfirmed attempt marks
 * those nights needs_review with the reason. The channex-ari-delivery task
 * delivers every pending night that comes due.
 */

const RATE_WINDOW_MS = 60_000
const CALLS_PER_WINDOW = 10
const MAX_ATTEMPTS = 5

interface Mapping { property_id: string; room_type_id: string; rate_plan_id: string }

/** A night's values as Channex takes them: availability on the room, price and rules on the rate plan. */
interface AriValues {
  availability: 0 | 1
  rate: string | null
  min_stay_arrival: number
  min_stay_through: number
  max_stay: number
  closed_to_arrival: boolean
  closed_to_departure: boolean
  stop_sell: boolean
}
type SentValues = Partial<AriValues>
const RESTRICTION_FIELDS = ['rate', 'min_stay_arrival', 'min_stay_through', 'max_stay', 'closed_to_arrival', 'closed_to_departure', 'stop_sell'] as const

interface OutboxRow { date: string; state: 'pending' | 'pushed' | 'needs_review'; detail: string | null; sent_json: string | null; attempts: number; retry_at: string | null; updated_at: string }

/** Reads a home's nights over [from, to) as they are now. */
export type StayNightReader = (from: string, to: string) => Promise<StayNight[]>

function rate(minor: number, currency: CurrencyCode): string {
  return (minor / 10 ** currencyFractionDigits(currency)).toFixed(currencyFractionDigits(currency))
}

function today(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + 1)
  return day.toISOString().slice(0, 10)
}

function clock(instant: string): string {
  return `${instant.slice(11, 16)} UTC`
}

function rejection(result: Record<string, unknown>): string | null {
  const meta = object(result.meta, 'Channex ARI result')
  if (meta.message !== 'Success') return `Channex did not report success: ${JSON.stringify(meta).slice(0, 500)}`
  if (meta.warnings !== undefined && (!Array.isArray(meta.warnings) || meta.warnings.length > 0)) return `Channex rejected part of the update: ${JSON.stringify(meta.warnings).slice(0, 500)}`
  return null
}

function ariValues(night: StayNight, home: StayHome): AriValues {
  return {
    availability: night.available ? 1 : 0,
    rate: night.price_minor === null ? null : rate(night.price_minor, home.currency),
    min_stay_arrival: night.min_stay_arrival ?? home.min_nights,
    min_stay_through: night.min_stay_through ?? 1,
    max_stay: night.max_stay ?? 0,
    closed_to_arrival: night.closed_to_arrival,
    closed_to_departure: night.closed_to_departure,
    stop_sell: !night.available,
  }
}

function sentValues(row: OutboxRow): SentValues {
  if (row.sent_json === null) return {}
  const sent = object(JSON.parse(row.sent_json), `channel_night_pushes.sent_json for ${row.date}`)
  return sent as SentValues
}

async function connectedMapping(db: DbClient, env: ChannexEnv, organizationId: string, productId: string): Promise<Mapping | null> {
  const mapping = await queryFirst<Mapping>(db, `SELECT property_id, room_type_id, rate_plan_id FROM product_channel_mappings
    WHERE organization_id = ? AND product_id = ? AND provider = 'channex' AND enabled = 1`, [organizationId, productId])
  if (mapping && (!env.CHANNEX_BASE_URL?.trim() || !env.CHANNEX_API_KEY?.trim())) throw new HTTPError({ statusCode: 503,
    message: 'CHANNEX_BASE_URL and CHANNEX_API_KEY are required to change a home connected to Channex',
    data: { code: 'CHANNEL_CONFIGURATION_REQUIRED', field: !env.CHANNEX_BASE_URL?.trim() ? 'CHANNEX_BASE_URL' : 'CHANNEX_API_KEY', product_id: productId } })
  return mapping
}

/**
 * Refuse a night change to a connected home that could not then be pushed.
 * Called before the write, so a change is never stored without its push.
 */
export async function requireChannelPush(db: DbClient, env: ChannexEnv, organizationId: string, productId: string): Promise<void> {
  await connectedMapping(db, env, organizationId, productId)
}

/**
 * Queue these nights of one home and deliver the home's due pending nights.
 * A home with no enabled Channex mapping has nothing to push and returns
 * null. Nights before today where the home is are skipped: Channex does not
 * take past dates. The outcome is these nights' state after delivery.
 */
export async function pushStayNights(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, dates: readonly string[], read: StayNightReader): Promise<ChannelPush | null> {
  const mapping = await connectedMapping(db, env, organizationId, home.product_id)
  if (!mapping) return null
  const from = today(home.timezone)
  const queued = [...new Set(dates.filter(date => date >= from))].sort()
  if (!queued.length) return null
  await execute(db, `INSERT INTO channel_night_pushes (organization_id, product_id, provider, date, state, detail, attempts, retry_at, updated_at)
    SELECT ?, ?, 'channex', value, 'pending', NULL, 0, NULL, ? FROM json_each(?) WHERE true
    ON CONFLICT (product_id, provider, date) DO UPDATE SET state = 'pending', detail = NULL, attempts = 0, retry_at = NULL, updated_at = excluded.updated_at`,
  [organizationId, home.product_id, new Date().toISOString(), JSON.stringify(queued)])
  await deliver(db, env, organizationId, home, mapping, read)
  const rows = await queryAll<{ state: OutboxRow['state']; detail: string | null }>(db, `SELECT state, detail FROM channel_night_pushes
    WHERE product_id = ? AND provider = 'channex' AND date IN (SELECT value FROM json_each(?)) ORDER BY state = 'needs_review' DESC, state = 'pending' DESC, date`,
  [home.product_id, JSON.stringify(queued)])
  const worst = rows[0]
  if (!worst || worst.state === 'pushed') return { state: 'pushed', detail: null }
  return { state: worst.state, detail: worst.detail ?? 'Waiting to send this change to the channel' }
}

/** Deliver one home's due pending nights now. A home with no enabled mapping has nothing to deliver. */
export async function deliverStayNights(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, read: StayNightReader): Promise<void> {
  const mapping = await connectedMapping(db, env, organizationId, home.product_id)
  if (mapping) await deliver(db, env, organizationId, home, mapping, read)
}

async function deliver(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, mapping: Mapping, read: StayNightReader): Promise<void> {
  const now = new Date().toISOString()
  const due = await queryAll<OutboxRow>(db, `SELECT date, state, detail, sent_json, attempts, retry_at, updated_at FROM channel_night_pushes
    WHERE product_id = ? AND provider = 'channex' AND state = 'pending' AND date >= ? AND (retry_at IS NULL OR retry_at <= ?) ORDER BY date`,
  [home.product_id, today(home.timezone), now])
  if (!due.length) return
  const nights = new Map((await read(due[0]!.date, nextDay(due.at(-1)!.date))).map(night => [night.date, night]))

  const settle = async (rows: readonly OutboxRow[], change: { state: OutboxRow['state']; detail: string | null; attempts?: number; retry_at?: string | null }) => {
    if (!rows.length) return
    // A night changed again since this delivery read it stays pending for its next delivery.
    await execute(db, `UPDATE channel_night_pushes SET state = ?, detail = ?, attempts = ?, retry_at = ?, updated_at = ?
      WHERE product_id = ? AND provider = 'channex' AND (date, updated_at) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`,
    [change.state, change.detail, change.attempts ?? 0, change.retry_at ?? null, new Date().toISOString(), home.product_id, JSON.stringify(rows.map(row => [row.date, row.updated_at]))])
  }
  const log = async (kind: 'availability' | 'restrictions', status: 'pushed' | 'needs_review' | 'failed', detail: string) => await execute(db, `INSERT INTO channel_sync_log (id, organization_id, product_id, provider, direction, kind, external_id, status, detail)
    VALUES (?, ?, ?, 'channex', 'outbound', ?, ?, ?, ?)`, [crypto.randomUUID(), organizationId, home.product_id, kind, mapping.property_id, status, detail])

  const unpriced = due.filter(row => nights.get(row.date)?.price_minor === null)
  await settle(unpriced, { state: 'needs_review', detail: `${unpriced[0]?.date} has no nightly price; Channex needs one for every night` })
  const sendable = due.filter(row => !unpriced.includes(row))
  const sent = new Map(sendable.map(row => [row.date, sentValues(row)]))
  const changes = sendable.map(row => {
    const values = ariValues(nights.get(row.date)!, home)
    const before = sent.get(row.date)!
    return { row, values, restrictions: RESTRICTION_FIELDS.filter(field => before[field] !== values[field]), availability: before.availability !== values.availability }
  })
  const restrictions = changes.filter(change => change.restrictions.length)
  const availability = changes.filter(change => change.availability)
  const unchanged = changes.filter(change => !change.restrictions.length && !change.availability).map(change => change.row)
  await settle(unchanged, { state: 'pushed', detail: null })
  if (!restrictions.length && !availability.length) return

  const recent = await queryAll<{ kind: 'availability' | 'restrictions'; calls: number; first: string }>(db, `SELECT kind, COUNT(*) AS calls, MIN(created_at) AS first FROM channel_sync_log
    WHERE provider = 'channex' AND direction = 'outbound' AND external_id = ? AND created_at > ? GROUP BY kind`,
  [mapping.property_id, new Date(Date.now() - RATE_WINDOW_MS).toISOString()])
  const limited = recent.filter(window => window.calls >= CALLS_PER_WINDOW && (window.kind === 'restrictions' ? restrictions.length : availability.length))
  const pending = changes.filter(change => change.restrictions.length || change.availability).map(change => change.row)
  if (limited.length) {
    const retryAt = new Date(Math.max(...limited.map(window => Date.parse(window.first))) + RATE_WINDOW_MS).toISOString()
    await settle(pending, { state: 'pending', detail: `Channex takes ${CALLS_PER_WINDOW} updates a minute for this home; this one goes at ${clock(retryAt)}`, retry_at: retryAt })
    return
  }

  const confirmed = new Map(sendable.map(row => [row.date, { ...sent.get(row.date)! }]))
  const requests = [
    ['restrictions', restrictions, () => channexRequest(env, '/restrictions', 'POST', { values: restrictions.map(change => ({
      property_id: mapping.property_id, rate_plan_id: mapping.rate_plan_id, date: change.row.date,
      ...Object.fromEntries(change.restrictions.map(field => [field, change.values[field]])),
    })) }), (change: typeof changes[number]) => { for (const field of change.restrictions) Object.assign(confirmed.get(change.row.date)!, { [field]: change.values[field] }) }],
    ['availability', availability, () => channexRequest(env, '/availability', 'POST', { values: availability.map(change => ({
      property_id: mapping.property_id, room_type_id: mapping.room_type_id, date: change.row.date, availability: change.values.availability,
    })) }), (change: typeof changes[number]) => { confirmed.get(change.row.date)!.availability = change.values.availability }],
  ] as const
  for (const [kind, batch, send, take] of requests) {
    if (!batch.length) continue
    const span = `${batch[0]!.row.date}..${batch.at(-1)!.row.date}`
    let refused: string | null
    try {
      refused = rejection(await send())
    } catch (error) {
      const unconfirmed = error instanceof ChannexDataError || (error instanceof ChannexError && (error.uncertain || error.providerStatus >= 500 || error.data.code === 'SYNC_SLICE_ENDED'))
      if (error instanceof ChannexError && error.providerStatus === 429) {
        const retryAt = new Date(Date.now() + RATE_WINDOW_MS).toISOString()
        await log(kind, 'failed', `Channex answered 429 for ${span}; waiting a minute`)
        await settle(pending, { state: 'pending', detail: `Channex asked KrabiClaw to slow down for this home; this change goes at ${clock(retryAt)}`, retry_at: retryAt })
        return
      }
      if (!unconfirmed) {
        if (!(error instanceof ChannexError)) throw error
        refused = error.message
      } else {
        const attempts = Math.max(...pending.map(row => row.attempts)) + 1
        const reason = `Channex did not confirm the ${kind} update (attempt ${attempts} of ${MAX_ATTEMPTS}). ${error instanceof Error ? error.message : String(error)}`
        await log(kind, 'failed', reason)
        if (attempts >= MAX_ATTEMPTS) await settle(pending, { state: 'needs_review', detail: reason, attempts })
        else {
          const retryAt = new Date(Date.now() + RATE_WINDOW_MS * 2 ** (attempts - 1)).toISOString()
          await settle(pending, { state: 'pending', detail: `${reason} Sending again at ${clock(retryAt)}.`, attempts, retry_at: retryAt })
        }
        await recordSent(db, home.product_id, confirmed)
        return
      }
    }
    if (refused) {
      await log(kind, 'needs_review', refused)
      await settle(pending, { state: 'needs_review', detail: refused })
      await recordSent(db, home.product_id, confirmed)
      return
    }
    await log(kind, 'pushed', span)
    batch.forEach(take)
  }
  await recordSent(db, home.product_id, confirmed)
  await settle(pending, { state: 'pushed', detail: null })
}

/** What Channex confirmed for each night, kept whatever state the night is in now. */
async function recordSent(db: DbClient, productId: string, confirmed: ReadonlyMap<string, SentValues>): Promise<void> {
  await execute(db, `UPDATE channel_night_pushes SET sent_json = json_extract(value, '$[1]')
    FROM json_each(?) WHERE product_id = ? AND provider = 'channex' AND date = json_extract(value, '$[0]')`,
  [JSON.stringify([...confirmed].map(([date, values]) => [date, JSON.stringify(values)])), productId])
}

/**
 * The listing settings Airbnb takes through Channex for a mapped listing, each
 * section sent only when it has something: booking settings (check-in window,
 * checkout, house rules, cancellation) and availability settings (minimum
 * stay). Title, description, photos, amenities, guest count and the arrival
 * guide have no write path through Channex and stay Airbnb's.
 */
export interface AirbnbListingSettings {
  booking: Record<string, unknown>
  availability: Record<string, unknown>
}

/**
 * Push a connected home's Airbnb listing settings. A home with no enabled
 * mapping has nothing to push and returns null. A refusal, or a write Channex
 * did not confirm, is returned as needs_review with its reason, as a night
 * push's is; it is not retried.
 */
export async function pushAirbnbListingSettings(db: DbClient, env: ChannexEnv, organizationId: string, productId: string, settings: AirbnbListingSettings): Promise<ChannelPush | null> {
  const mapping = await connectedMapping(db, env, organizationId, productId)
  if (!mapping) return null
  const row = await queryFirst<{ channel_id: string }>(db, "SELECT channel_id FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [organizationId, productId])
  const path = `/channels/${encodeURIComponent(row!.channel_id)}`
  try {
    const channel = object((await channexRequest(env, path)).data, 'channel')
    const ratePlans = object(channel.attributes, 'channel.attributes').rate_plans
    const listing = Array.isArray(ratePlans) ? ratePlans.map(entry => object(entry, 'Mapping')).find(entry => entry.rate_plan_id === mapping.rate_plan_id) : undefined
    if (!listing || typeof listing.id !== 'string') return { state: 'needs_review', detail: 'Channex has no mapping for this listing; its settings were not sent to Airbnb' }
    const mappingId = encodeURIComponent(listing.id)
    if (Object.keys(settings.booking).length) await channexRequest(env, `${path}/execute/update_booking_setting`, 'PUT', { channel_rate_plan_id: listing.id, data: settings.booking })
    if (Object.keys(settings.availability).length) await channexRequest(env, `${path}/mappings/${mappingId}/availability_settings`, 'PUT', { availability_settings: settings.availability })
    return { state: 'pushed', detail: null }
  } catch (error) {
    if (error instanceof ChannexDataError) return { state: 'needs_review', detail: `Channex's answer to the listing settings update was not readable; its outcome is unknown. ${error.message}` }
    if (error instanceof ChannexError) return { state: 'needs_review', detail: error.uncertain ? `Channex did not confirm the listing settings update; its outcome is unknown. ${error.message}` : `Airbnb refused the listing settings: ${error.message}` }
    throw error
  }
}
