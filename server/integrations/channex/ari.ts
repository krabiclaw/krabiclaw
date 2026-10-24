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
 * what Channex last confirmed for each (sent_json), contiguous nights with
 * the same change as one date range: at most one restrictions call and one
 * availability call per home. A booking or hold changes availability alone;
 * stop_sell is the host closing a night (docs.channex.io ARI: availability is
 * the room's inventory, stop_sell a rate plan restriction).
 *
 * One delivery runs per property at a time, under a lease on its mapping.
 * Channex takes 10 restrictions and 10 availability calls per property per
 * minute (docs.channex.io rate-limits). Delivery counts this property's calls
 * in the last minute from channel_sync_log and leaves the nights pending with
 * their retry time instead of exceeding the limit. A 429, or a call Channex
 * did not confirm (5xx, the network, an unreadable answer), pauses the
 * property: a minute, doubling with each further attempt up to an hour, and
 * the nights stay pending with the reason until Channex confirms them. ARI
 * values are absolute, so sending one twice changes nothing. Only a refusal
 * or a partial rejection (200 with meta.warnings, by the dates it names)
 * marks nights needs_review with Channex's reason. The channex-ari-delivery
 * task delivers every pending night that comes due.
 */

const RATE_WINDOW_MS = 60_000
const CALLS_PER_WINDOW = 10
const MAX_RETRY_MS = 3_600_000
/** How long a delivery holds its property; a run that dies releases it by expiry. */
const LEASE_MS = 120_000
/** A delivery sends again for nights changed while it ran, this many rounds at most. */
const ROUNDS = 3

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
type Outcome = { state: 'pending'; detail: string; attempts: number; retry_at: string } | { state: 'needs_review'; detail: string }

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

function ariValues(night: StayNight, home: StayHome): AriValues {
  return {
    availability: night.available ? 1 : 0,
    rate: night.price_minor === null ? null : rate(night.price_minor, home.currency),
    min_stay_arrival: night.min_stay_arrival ?? home.min_nights,
    min_stay_through: night.min_stay_through ?? 1,
    max_stay: night.max_stay ?? 0,
    closed_to_arrival: night.closed_to_arrival,
    closed_to_departure: night.closed_to_departure,
    stop_sell: night.closed,
  }
}

function sentValues(row: OutboxRow): SentValues {
  if (row.sent_json === null) return {}
  const sent = object(JSON.parse(row.sent_json), `channel_night_pushes.sent_json for ${row.date}`)
  return sent as SentValues
}

/** Contiguous nights carrying the same change, as Channex's inclusive date ranges. */
function dateRanges(nights: ReadonlyArray<{ date: string; change: Record<string, unknown> }>): Array<Record<string, unknown> & { date_from: string; date_to: string }> {
  const ranges: Array<{ date_from: string; date_to: string; key: string; change: Record<string, unknown> }> = []
  for (const night of nights) {
    const key = JSON.stringify(night.change)
    const last = ranges.at(-1)
    if (last && last.key === key && nextDay(last.date_to) === night.date) last.date_to = night.date
    else ranges.push({ date_from: night.date, date_to: night.date, key, change: night.change })
  }
  return ranges.map(range => ({ date_from: range.date_from, date_to: range.date_to, ...range.change }))
}

/** The nights of this call a warning names by its echoed date or date range; null when it echoes no date. */
function warnedDates(warning: unknown, dates: readonly string[]): string[] | null {
  if (!warning || typeof warning !== 'object' || Array.isArray(warning)) return null
  const echo = warning as Record<string, unknown>
  if (typeof echo.date === 'string') return dates.filter(date => date === echo.date)
  if (typeof echo.date_from === 'string' && typeof echo.date_to === 'string') return dates.filter(date => date >= (echo.date_from as string) && date <= (echo.date_to as string))
  return null
}

/** Each refused night of a 200 answer with its reason; every night when Channex did not report success or named no dates. */
function refusals(result: Record<string, unknown>, kind: string, dates: readonly string[]): Map<string, string> {
  const meta = object(result.meta, 'Channex ARI result')
  if (meta.message !== 'Success') return new Map(dates.map(date => [date, `Channex did not report success for the ${kind} update: ${JSON.stringify(meta).slice(0, 500)}`]))
  if (meta.warnings === undefined) return new Map()
  if (!Array.isArray(meta.warnings)) return new Map(dates.map(date => [date, `Channex answered the ${kind} update with unreadable warnings: ${JSON.stringify(meta.warnings).slice(0, 500)}`]))
  const refused = new Map<string, string>()
  for (const warning of meta.warnings) {
    const reason = `Channex rejected part of the ${kind} update: ${JSON.stringify(warning).slice(0, 500)}`
    // A warning whose dates name none of this call's nights is still a refusal of the call.
    const named = warnedDates(warning, dates)
    for (const date of named?.length ? named : dates) if (!refused.has(date)) refused.set(date, reason)
  }
  return refused
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
 * take past dates. The outcome is these nights' state after delivery: pending
 * while a rate limit, a retry or another delivery of the home holds them.
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
  return { state: worst.state, detail: worst.detail ?? 'Another delivery to Channex for this home is under way; this change goes with it or right after' }
}

/** Deliver one home's due pending nights now. A home with no enabled mapping has nothing to deliver. */
export async function deliverStayNights(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, read: StayNightReader): Promise<void> {
  const mapping = await connectedMapping(db, env, organizationId, home.product_id)
  if (mapping) await deliver(db, env, organizationId, home, mapping, read)
}

/**
 * Hold the property's lease and send its due nights, again for nights changed
 * meanwhile. Another delivery holding the lease sends them instead.
 */
async function deliver(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, mapping: Mapping, read: StayNightReader): Promise<void> {
  const lease = crypto.randomUUID()
  const claimed = await execute(db, `UPDATE product_channel_mappings SET delivery_lease = ?, delivery_lease_until = ?
    WHERE product_id = ? AND provider = 'channex' AND enabled = 1 AND (delivery_lease_until IS NULL OR delivery_lease_until <= ?)`,
  [lease, new Date(Date.now() + LEASE_MS).toISOString(), home.product_id, new Date().toISOString()])
  if (claimed.meta.changes !== 1) return
  try {
    for (let round = 0; round < ROUNDS; round++) if (!await sendDue(db, env, organizationId, home, mapping, read)) break
  } finally {
    await execute(db, "UPDATE product_channel_mappings SET delivery_lease = NULL, delivery_lease_until = NULL WHERE product_id = ? AND provider = 'channex' AND delivery_lease = ?", [home.product_id, lease])
  }
}

/** One delivery of the due pending nights; false when none was due. */
async function sendDue(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, mapping: Mapping, read: StayNightReader): Promise<boolean> {
  const now = new Date().toISOString()
  const due = await queryAll<OutboxRow>(db, `SELECT date, state, detail, sent_json, attempts, retry_at, updated_at FROM channel_night_pushes
    WHERE product_id = ? AND provider = 'channex' AND state = 'pending' AND (retry_at IS NULL OR retry_at <= ?) ORDER BY date`, [home.product_id, now])
  if (!due.length) return false
  const outcomes = new Map<string, Outcome>()
  const from = today(home.timezone)
  for (const row of due) if (row.date < from) outcomes.set(row.date, { state: 'needs_review', detail: `${row.date} passed before Channex confirmed it; Channex does not take past dates` })
  const current = due.filter(row => row.date >= from)
  const nights = current.length ? new Map((await read(current[0]!.date, nextDay(current.at(-1)!.date))).map(night => [night.date, night])) : new Map<string, StayNight>()

  const sent = new Map(current.map(row => [row.date, sentValues(row)]))
  const changes = current.map((row) => {
    const values = ariValues(nights.get(row.date)!, home)
    const before = sent.get(row.date)!
    // A night without a price sends its other values; the price is what needs review.
    if (values.rate === null) outcomes.set(row.date, { state: 'needs_review', detail: `${row.date} has no nightly price; Channex needs one for every night` })
    return { row, values, restrictions: RESTRICTION_FIELDS.filter(field => before[field] !== values[field] && values[field] !== null), availability: before.availability !== values.availability }
  })

  const log = async (kind: 'availability' | 'restrictions', status: 'pushed' | 'needs_review' | 'failed', detail: string) => await execute(db, `INSERT INTO channel_sync_log (id, organization_id, product_id, provider, direction, kind, external_id, status, detail)
    VALUES (?, ?, ?, 'channex', 'outbound', ?, ?, ?, ?)`, [crypto.randomUUID(), organizationId, home.product_id, kind, mapping.property_id, status, detail])
  const recent = await queryAll<{ kind: 'availability' | 'restrictions'; calls: number; first: string }>(db, `SELECT kind, COUNT(*) AS calls, MIN(created_at) AS first FROM channel_sync_log
    WHERE provider = 'channex' AND direction = 'outbound' AND external_id = ? AND created_at > ? GROUP BY kind`,
  [mapping.property_id, new Date(Date.now() - RATE_WINDOW_MS).toISOString()])
  const confirmed = new Map(current.map(row => [row.date, { ...sent.get(row.date)! }]))
  // A night still to be sent stays pending, even with a part Channex refused: its next delivery sends what differs again.
  const wait = (rows: ReadonlyArray<{ row: OutboxRow }>, outcome: (attempts: number) => Outcome) => {
    for (const { row } of rows) outcomes.set(row.date, outcome(row.attempts))
  }
  const review = (date: string, detail: string) => { if (outcomes.get(date)?.state !== 'pending') outcomes.set(date, { state: 'needs_review', detail }) }
  let paused: ((attempts: number) => Outcome) | null = null

  const requests = [
    ['restrictions', changes.filter(change => change.restrictions.length), (batch: typeof changes) => channexRequest(env, '/restrictions', 'POST', { values: dateRanges(batch.map(change => ({
      date: change.row.date, change: Object.fromEntries(change.restrictions.map(field => [field, change.values[field]])),
    }))).map(range => ({ property_id: mapping.property_id, rate_plan_id: mapping.rate_plan_id, ...range })) }),
    (change: typeof changes[number]) => { for (const field of change.restrictions) Object.assign(confirmed.get(change.row.date)!, { [field]: change.values[field] }) }],
    ['availability', changes.filter(change => change.availability), (batch: typeof changes) => channexRequest(env, '/availability', 'POST', { values: dateRanges(batch.map(change => ({
      date: change.row.date, change: { availability: change.values.availability },
    }))).map(range => ({ property_id: mapping.property_id, room_type_id: mapping.room_type_id, ...range })) }),
    (change: typeof changes[number]) => { confirmed.get(change.row.date)!.availability = change.values.availability }],
  ] as const
  for (const [kind, batch, send, take] of requests) {
    if (!batch.length) continue
    if (paused) { wait(batch, paused); continue }
    const window = recent.find(entry => entry.kind === kind && entry.calls >= CALLS_PER_WINDOW)
    if (window) {
      const retryAt = new Date(Date.parse(window.first) + RATE_WINDOW_MS).toISOString()
      wait(batch, attempts => ({ state: 'pending', detail: `Channex takes ${CALLS_PER_WINDOW} ${kind} updates a minute for this home; this one goes at ${clock(retryAt)}`, attempts, retry_at: retryAt }))
      continue
    }
    const span = `${batch[0]!.row.date}..${batch.at(-1)!.row.date}`
    try {
      const refused = refusals(await send(batch), kind, batch.map(change => change.row.date))
      for (const change of batch) {
        const reason = refused.get(change.row.date)
        if (reason) review(change.row.date, reason)
        else take(change)
      }
      await log(kind, refused.size ? 'needs_review' : 'pushed', refused.size ? [...new Set(refused.values())].join(' ') : span)
    } catch (error) {
      if (!(error instanceof ChannexDataError || error instanceof ChannexError)) throw error
      const limited = error instanceof ChannexError && error.providerStatus === 429
      const unconfirmed = error instanceof ChannexDataError || error.uncertain || error.providerStatus >= 500
      if (!limited && !unconfirmed) {
        await log(kind, 'needs_review', error.message)
        for (const change of batch) review(change.row.date, `Channex refused the ${kind} update: ${error.message}`)
        continue
      }
      // Channex says to pause the property after any failed call: a minute, then doubling.
      const reason = limited ? `Channex asked KrabiClaw to slow down for this home (${span})` : `Channex did not confirm the ${kind} update for ${span}. ${error.message}`
      await log(kind, 'failed', reason)
      paused = (attempts) => {
        const retryAt = new Date(Date.now() + Math.min(MAX_RETRY_MS, RATE_WINDOW_MS * 2 ** attempts)).toISOString()
        return { state: 'pending', detail: `${reason} Attempt ${attempts + 1}; sending again at ${clock(retryAt)}.`, attempts: attempts + 1, retry_at: retryAt }
      }
      wait(batch, paused)
    }
  }

  await execute(db, `UPDATE channel_night_pushes SET sent_json = json_extract(value, '$[1]')
    FROM json_each(?) WHERE product_id = ? AND provider = 'channex' AND date = json_extract(value, '$[0]')`,
  [JSON.stringify([...confirmed].map(([date, values]) => [date, JSON.stringify(values)])), home.product_id])
  // What Channex confirmed is kept whatever the night's state; a night changed again since this delivery read it stays pending for the next.
  await execute(db, `UPDATE channel_night_pushes SET state = json_extract(value, '$.state'), detail = json_extract(value, '$.detail'), attempts = json_extract(value, '$.attempts'),
      retry_at = json_extract(value, '$.retry_at'), updated_at = ?
    FROM json_each(?) WHERE product_id = ? AND provider = 'channex' AND date = json_extract(value, '$.date') AND channel_night_pushes.updated_at = json_extract(value, '$.updated_at')`,
  [new Date().toISOString(), JSON.stringify(due.map((row) => {
    const outcome = outcomes.get(row.date)
    return { date: row.date, updated_at: row.updated_at, state: outcome?.state ?? 'pushed', detail: outcome?.detail ?? null,
      attempts: outcome?.state === 'pending' ? outcome.attempts : 0, retry_at: outcome?.state === 'pending' ? outcome.retry_at : null }
  })), home.product_id])
  return true
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
 * did not confirm, is returned as needs_review with its reason; listing
 * settings have no outbox, so it is not retried.
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
