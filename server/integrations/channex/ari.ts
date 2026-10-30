import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import type { StayHome, StayNight } from '~/server/domain/stays'
import { currencyFractionDigits, type CurrencyCode } from '~/shared/currencies'
import { channexGet, channexRequest, ChannexError, type ChannexEnv } from './client'
import { ChannexDataError, integer, object, string } from './data'
import { keptBookingSettings, listingMinimumNights, listingRecord } from './airbnb-listing'
import { HTTPError } from 'nitro'
import { STAY_CALENDAR_DAYS } from '~/shared/bookings'
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
 * availability call per home. Availability is the room's inventory: 0 while a
 * booking, a checkout hold or a linked calendar takes the night, else 1. A
 * host closing a night is stop_sell on the rate plan alone, and opening it
 * stop_sell false alone; neither touches availability (docs.channex.io ARI
 * and its certification: a stop sell is one restrictions update). Airbnb's
 * minimum is a rule of the arrival date. Its actual imported listing default
 * applies when that date has no override.
 *
 * A home's full sync is the same delivery over every night of the calendar
 * ahead, with nothing confirmed yet: an import's inventory, and a home that
 * syncs again after it stopped.
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
/** Crash-recovery window; a live delivery renews its property lease before it expires. */
const LEASE_MS = 120_000
/** A delivery sends again for nights changed while it ran, this many rounds at most. */
const ROUNDS = 3

export interface ChannexMapping { property_id: string; room_type_id: string; rate_plan_id: string }
export interface DeliveryLease { token: string; check(): Promise<void> }
type Mapping = ChannexMapping

/** A night's values as Channex takes them: availability on the room, price and rules on the rate plan. */
interface AriValues {
  availability: 0 | 1
  rate: string | null
  min_stay_arrival: number
  max_stay: number
  closed_to_arrival: boolean
  closed_to_departure: boolean
  stop_sell: boolean
}
type SentValues = Partial<AriValues>
const RESTRICTION_FIELDS = ['rate', 'min_stay_arrival', 'max_stay', 'closed_to_arrival', 'closed_to_departure', 'stop_sell'] as const

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
    availability: night.stay_id !== null || night.held_until !== null || night.calendar !== null ? 0 : 1,
    rate: night.price_minor === null ? null : rate(night.price_minor, home.currency),
    min_stay_arrival: night.min_stay_arrival,
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

/**
 * The task Channex created for an ARI call: its answer is `data: [{ id, type: 'task' }]`
 * (docs.channex.io ARI). A call Channex rejected in part may create none and
 * answer `data: []`; a call it took whole always names its task.
 */
export function ariTask(result: Record<string, unknown>, refused: boolean): string | null {
  if (!Array.isArray(result.data)) {
    if (refused) return null
    throw new ChannexDataError(`Channex's ARI answer has no data list: ${JSON.stringify(result).slice(0, 500)}`)
  }
  const tasks = result.data.map(entry => object(entry, 'ARI task')).filter(entry => entry.type === 'task')
  if (tasks.length > 1) throw new ChannexDataError(`Channex's ARI answer names ${tasks.length} tasks for one call`)
  if (tasks[0]) return string(tasks[0].id, 'ARI task id')
  if (!refused) throw new ChannexDataError(`Channex reported success for an ARI call without its task: ${JSON.stringify(result).slice(0, 500)}`)
  return null
}

/**
 * One ARI call to a property, as channel_sync_log keeps it: the rate limit
 * counts these rows, and task_id is the task Channex created, which Channex's
 * certification and support ask for.
 */
export async function logAriCall(db: DbClient, call: { organizationId: string; productId: string; propertyId: string; kind: 'availability' | 'restrictions'; status: 'pushed' | 'needs_review' | 'failed'; detail: string; taskId: string | null }): Promise<void> {
  await execute(db, `INSERT INTO channel_sync_log (id, organization_id, product_id, provider, direction, kind, external_id, status, detail, task_id)
    VALUES (?, ?, ?, 'channex', 'outbound', ?, ?, ?, ?, ?)`, [crypto.randomUUID(), call.organizationId, call.productId, call.kind, call.propertyId, call.status, call.detail, call.taskId])
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

/** Native weekday defaults preserve only actual imported or authored weekday rules. */
export function calendarMinimumDefaults(home: Pick<StayHome, 'min_nights' | 'calendar_rules'>): number | number[] {
  return home.calendar_rules?.day_of_week_min_nights?.map(value => value === -1 ? home.min_nights : value) ?? home.min_nights
}

/** The canonical listing defaults also govern each new date Channex adds to its rolling state. */
export async function configureStayCalendar(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, mapping?: ChannexMapping, write: (action: () => Promise<void>) => Promise<void> = async action => action()): Promise<void> {
  let written = false
  try {
    const target = mapping ?? await connectedMapping(db, env, organizationId, home.product_id)
    if (!target) return
    const linked = await queryFirst<{ channel_id: string; listing_id: string; enabled: number }>(db, "SELECT channel_id, listing_id, enabled FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [organizationId, home.product_id])
    if (!linked) throw new ChannexDataError('The home has no Airbnb channel mapping')
    const channelPath = `/channels/${encodeURIComponent(linked.channel_id)}`
    const channel = await channexGet(env, channelPath, 'channel')
    if (channel.id !== linked.channel_id || channel.attributes.channel !== 'AirBNB') throw new ChannexDataError('Channex returned a different Airbnb channel for this home')
    if (!Array.isArray(channel.attributes.rate_plans)) throw new ChannexDataError('The Airbnb channel has no listing mappings')
    const mapped = channel.attributes.rate_plans.map(value => object(value, 'Mapping')).some(value => value.rate_plan_id === target.rate_plan_id && object(value.settings, 'Mapping settings').listing_id === linked.listing_id)
    if (linked.enabled === 1 && !mapped) throw new ChannexDataError('Channex has no Airbnb mapping for this connected home')
    const channelSettings = object(channel.attributes.settings, 'channel.settings')
    if (channelSettings.min_stay_type !== 'Arrival') {
      await write(async () => {
        written = true
        await channexRequest(env, channelPath, 'PUT', { channel: { channel: 'AirBNB', settings: { ...channelSettings, min_stay_type: 'Arrival' } } })
        const verified = await channexGet(env, channelPath, 'channel')
        if (verified.id !== linked.channel_id || object(verified.attributes.settings, 'channel.settings').min_stay_type !== 'Arrival') throw new ChannexDataError('Channex did not confirm Airbnb arrival minimums')
      })
    }
    const propertyPath = `/properties/${encodeURIComponent(target.property_id)}`
    const property = await channexGet(env, propertyPath, 'property')
    if (property.id !== target.property_id) throw new ChannexDataError('Channex returned a different property for this home')
    const propertySettings = object(property.attributes.settings, 'property.settings')
    const minimumType = string(propertySettings.min_stay_type, 'property.settings.min_stay_type')
    if (!['arrival', 'through', 'both'].includes(minimumType)) throw new ChannexDataError(`Channex returned an unknown minimum-stay type: ${minimumType}`)
    if (minimumType !== 'arrival') {
      await write(async () => {
        written = true
        await channexRequest(env, propertyPath, 'PUT', { property: { settings: { ...propertySettings, min_stay_type: 'arrival' } } })
        const verified = await channexGet(env, propertyPath, 'property')
        if (verified.id !== target.property_id || object(verified.attributes.settings, 'property.settings').min_stay_type !== 'arrival') throw new ChannexDataError('Channex did not confirm arrival-based minimum stay')
      })
    }
    if (mapped && await listingMinimumNights(env, linked.channel_id, linked.listing_id) !== home.min_nights) {
      const pushed = await pushAirbnbListingSettings(db, env, organizationId, home.product_id, { booking: {}, availability: { default_min_nights: home.min_nights } }, target, action => write(async () => {
        written = true
        await action()
      }))
      if (pushed?.state !== 'pushed') throw new ChannexDataError(pushed?.detail ?? 'Airbnb has no active listing mapping for its canonical default minimum')
    }
    const ratePath = `/rate_plans/${encodeURIComponent(target.rate_plan_id)}`
    const canonicalMinimum = calendarMinimumDefaults(home)
    const expectedMinimums = Array.isArray(canonicalMinimum) ? canonicalMinimum : [canonicalMinimum]
    const minimumMatches = (value: unknown): boolean => {
      const values = Array.isArray(value) ? value : [value]
      if (values.length !== 1 && values.length !== 7) throw new ChannexDataError('The rate plan has an invalid default arrival minimum')
      const actual = values.map(value => integer(value, 'rate_plan.min_stay_arrival', 1))
      return Array.from({ length: 7 }, (_, day) => day).every(day => actual[day % actual.length] === expectedMinimums[day % expectedMinimums.length])
    }
    if (home.base_price_minor === null) throw new HTTPError({ statusCode: 422, message: 'Set the home’s actual base price before syncing its rolling calendar.', data: { code: 'PRICE_REQUIRED', field: 'base_price_minor' } })
    const baseRate = rate(home.base_price_minor, home.currency)
    const options = (attributes: Record<string, unknown>) => {
      if (!Array.isArray(attributes.options) || !attributes.options.length) throw new ChannexDataError('The rate plan has no pricing options')
      const values = attributes.options.map(value => object(value, 'rate_plan.options'))
      if (values.filter(value => value.is_primary === true).length !== 1) throw new ChannexDataError('The rate plan must have exactly one primary pricing option')
      for (const value of values) {
        integer(value.occupancy, 'rate_plan.options.occupancy', 1)
        if (typeof value.is_primary !== 'boolean' || (typeof value.rate !== 'string' && typeof value.rate !== 'number') || String(value.rate).trim() === '' || !Number.isFinite(Number(value.rate)) || Number(value.rate) < 0) throw new ChannexDataError('The rate plan has an invalid pricing option')
      }
      return values
    }
    const defaults = await channexGet(env, ratePath, 'rate_plan')
    if (defaults.id !== target.rate_plan_id) throw new ChannexDataError('Channex returned a different rate plan for this home')
    const originalOptions = options(defaults.attributes)
    const minimumChanged = !minimumMatches(defaults.attributes.min_stay_arrival)
    const priceChanged = originalOptions.some(value => value.is_primary && Number(value.rate) !== Number(baseRate))
    if (minimumChanged || priceChanged) {
      await write(async () => {
        written = true
        await channexRequest(env, ratePath, 'PUT', { rate_plan: {
          ...(minimumChanged ? { min_stay_arrival: canonicalMinimum } : {}),
          ...(priceChanged ? { options: originalOptions.map(value => value.is_primary ? { ...value, rate: baseRate } : value) } : {}),
        } })
        const verified = await channexGet(env, ratePath, 'rate_plan')
        if (verified.id !== target.rate_plan_id || !minimumMatches(verified.attributes.min_stay_arrival) || options(verified.attributes).some(value => value.is_primary && Number(value.rate) !== Number(baseRate))) throw new ChannexDataError('Channex did not confirm the listing default minimum stay and base price')
      })
    }
  } catch (error) {
    if (error instanceof ChannexDataError) throw new ChannexError(`Channex returned invalid calendar defaults: ${error.message}`, 502, written, { code: 'INVALID_PROVIDER_RESPONSE', field: 'calendar_defaults' })
    throw error
  }
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
  return queueAndDeliver(db, env, organizationId, home, mapping, dates, read)
}

/**
 * Every night of the calendar ahead to the property the home is mapped to,
 * whether or not the mapping is enabled yet: an import's full sync, before the
 * listing syncs, and the full sync of a home that syncs again. What Channex
 * last confirmed is what the outbox holds; a caller resending the whole
 * calendar clears those confirmations first, under the same delivery lease.
 */
export async function pushStayCalendar(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, mapping: ChannexMapping, read: StayNightReader, lease?: DeliveryLease): Promise<ChannelPush> {
  const from = today(home.timezone)
  const outcome = await queueAndDeliver(db, env, organizationId, home, mapping, Array.from({ length: STAY_CALENDAR_DAYS }, (_, offset) => addDays(from, offset)), read, lease)
  if (!outcome) throw new Error(`The calendar of ${home.product_id} has no night from ${from} to send`)
  return outcome
}

/** Forget what Channex confirmed for a home: its next delivery sends every night whole. */
export async function forgetConfirmedNights(db: DbClient, productId: string, lease?: DeliveryLease): Promise<void> {
  await lease?.check()
  await execute(db, `UPDATE channel_night_pushes SET sent_json = NULL WHERE product_id = ? AND provider = 'channex'
    AND (? IS NULL OR EXISTS (SELECT 1 FROM product_channel_mappings m WHERE m.product_id = channel_night_pushes.product_id AND m.provider = 'channex' AND m.delivery_lease = ?))`, [productId, lease?.token ?? null, lease?.token ?? null])
  if (lease && !await queryFirst(db, "SELECT 1 FROM product_channel_mappings WHERE product_id = ? AND provider = 'channex' AND delivery_lease = ?", [productId, lease.token])) {
    throw new HTTPError({ statusCode: 409, message: 'The calendar delivery changed. Try the full sync again.', data: { code: 'CHANNEL_DELIVERY_CHANGED', product_id: productId } })
  }
}

function addDays(date: string, count: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10)
}

async function queueAndDeliver(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, mapping: Mapping, dates: readonly string[], read: StayNightReader, lease?: DeliveryLease): Promise<ChannelPush | null> {
  await lease?.check()
  const from = today(home.timezone)
  const queued = [...new Set(dates.filter(date => date >= from))].sort()
  if (!queued.length) return null
  // A night already pending keeps its attempt count and retry time: the property's pause holds, and the change goes
  // with the retry. Its updated_at still moves, so a delivery that read the night before this change leaves it pending.
  const inserted = await execute(db, `INSERT INTO channel_night_pushes (organization_id, product_id, provider, date, state, detail, attempts, retry_at, updated_at)
    SELECT ?, ?, 'channex', value, 'pending', NULL, 0, NULL, ? FROM json_each(?)
    WHERE ? IS NULL OR EXISTS (SELECT 1 FROM product_channel_mappings WHERE product_id = ? AND provider = 'channex' AND delivery_lease = ?)
    ON CONFLICT (product_id, provider, date) DO UPDATE SET state = 'pending', updated_at = excluded.updated_at,
      detail = CASE WHEN channel_night_pushes.state = 'pending' THEN channel_night_pushes.detail ELSE NULL END,
      attempts = CASE WHEN channel_night_pushes.state = 'pending' THEN channel_night_pushes.attempts ELSE 0 END,
      retry_at = CASE WHEN channel_night_pushes.state = 'pending' THEN channel_night_pushes.retry_at ELSE NULL END`,
  [organizationId, home.product_id, new Date().toISOString(), JSON.stringify(queued), lease?.token ?? null, home.product_id, lease?.token ?? null])
  if (lease && inserted.meta.changes !== queued.length) throw new HTTPError({ statusCode: 409, message: 'The calendar delivery changed. Try the full sync again.', data: { code: 'CHANNEL_DELIVERY_CHANGED', product_id: home.product_id } })
  // Every new date waits out the property's existing pause, including a newly opened rolling date.
  const pause = await queryFirst<{ retry_at: string; detail: string | null }>(db, `SELECT n.retry_at, n.detail FROM channel_night_pushes n
    WHERE n.product_id = ? AND n.provider = 'channex' AND n.state = 'pending' AND n.retry_at > ?
      AND (? IS NOT NULL OR EXISTS (SELECT 1 FROM channel_sync_log l WHERE l.product_id = n.product_id AND l.provider = n.provider
        AND l.direction = 'outbound' AND l.status = 'failed' AND substr(n.detail, 1, length(l.detail)) = l.detail))
    ORDER BY n.retry_at DESC LIMIT 1`, [home.product_id, new Date().toISOString(), lease?.token ?? null])
  if (pause) await execute(db, `UPDATE channel_night_pushes SET retry_at = ?, detail = ?
    WHERE product_id = ? AND provider = 'channex' AND date IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM product_channel_mappings WHERE product_id = ? AND provider = 'channex' AND delivery_lease = ?))`,
  [pause.retry_at, pause.detail, home.product_id, JSON.stringify(queued), lease?.token ?? null, home.product_id, lease?.token ?? null])
  await deliver(db, env, organizationId, home, mapping, read, lease)
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
 * Renew a live lock and drain renewal before cleanup. A returned error proves
 * ownership loss; a thrown renewal failure stays visible while renewal continues.
 */
export async function withLeaseHeartbeat<T>(interval: number, renew: () => Promise<Error | null>, action: (check: () => Promise<void>) => Promise<T>, cleanup: () => void | Promise<void>): Promise<T> {
  const failures: unknown[] = []
  let active = true
  let owned = true
  let renewal = Promise.resolve()
  const check = async () => {
    await renewal
    if (failures.length) throw failures[0]
  }
  // Keep protecting an in-flight action after a renewal error; its check retains the failure.
  const heartbeat = setInterval(() => {
    renewal = renewal.then(async () => {
      if (!active || !owned) return
      try {
        const lost = await renew()
        if (lost) {
          owned = false
          failures.push(lost)
        }
      } catch (error) { failures.push(error) }
    })
  }, interval)
  let value!: T
  try {
    value = await action(check)
  } catch (error) {
    if (!failures.includes(error)) failures.push(error)
  } finally {
    active = false
    clearInterval(heartbeat)
    await renewal
    try {
      await cleanup()
    } catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join('; '))
  return value
}

/** One renewable property lease for ordinary delivery and an explicit full sync's reset plus delivery. */
export async function withDeliveryLease<T>(db: DbClient, productId: string, action: (lease: DeliveryLease) => Promise<T>): Promise<T | null> {
  const token = crypto.randomUUID()
  const claimed = await execute(db, `UPDATE product_channel_mappings SET delivery_lease = ?, delivery_lease_until = ?
    WHERE product_id = ? AND provider = 'channex' AND (delivery_lease_until IS NULL OR delivery_lease_until <= ?)`,
  [token, new Date(Date.now() + LEASE_MS).toISOString(), productId, new Date().toISOString()])
  if (claimed.meta.changes !== 1) return null
  return withLeaseHeartbeat(LEASE_MS / 3, async () => {
    try {
      const renewed = await execute(db, "UPDATE product_channel_mappings SET delivery_lease_until = ? WHERE product_id = ? AND provider = 'channex' AND delivery_lease = ?", [new Date(Date.now() + LEASE_MS).toISOString(), productId, token])
      return renewed.meta.changes === 1 ? null : new HTTPError({ statusCode: 409, message: 'This home’s sync changed during the update. Its remaining changes stay queued.', data: { code: 'CHANNEL_DELIVERY_CHANGED', product_id: productId } })
    } catch (cause) {
      throw new HTTPError({ statusCode: 503, message: 'The calendar update could not continue. Its remaining changes stay queued.', data: { code: 'CHANNEL_DELIVERY_RENEWAL_FAILED', product_id: productId }, cause })
    }
  }, check => action({ token, check }), async () => {
    await execute(db, "UPDATE product_channel_mappings SET delivery_lease = NULL, delivery_lease_until = NULL WHERE product_id = ? AND provider = 'channex' AND delivery_lease = ?", [productId, token])
  })
}

async function deliver(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, mapping: Mapping, read: StayNightReader, lease?: DeliveryLease): Promise<void> {
  const send = async (held: DeliveryLease) => {
    for (let round = 0; round < ROUNDS; round++) if (!await sendDue(db, env, organizationId, home, mapping, read, held)) break
  }
  if (lease) await send(lease)
  else await withDeliveryLease(db, home.product_id, send)
}

/**
 * One delivery of the due pending nights; false when none was due or the lease was lost. Its
 * results are written only while it still holds the lease: a delivery that
 * outlived it leaves them to the one that took over, which sends again what
 * Channex has not confirmed to it.
 */
async function sendDue(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, mapping: Mapping, read: StayNightReader, lease: DeliveryLease): Promise<boolean> {
  await lease.check()
  if (!await queryFirst(db, "SELECT 1 FROM product_channel_mappings WHERE product_id = ? AND provider = 'channex' AND delivery_lease = ?", [home.product_id, lease.token])) return false
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
    const changed = (field: typeof RESTRICTION_FIELDS[number]) => before[field] !== values[field] && values[field] !== null
    return { row, values, restrictions: RESTRICTION_FIELDS.filter(changed), availability: before.availability !== values.availability }

  })

  const log = async (kind: 'availability' | 'restrictions', status: 'pushed' | 'needs_review' | 'failed', detail: string, taskId: string | null = null) =>
    await logAriCall(db, { organizationId, productId: home.product_id, propertyId: mapping.property_id, kind, status, detail, taskId })
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
      if (!await queryFirst(db, "SELECT 1 FROM product_channel_mappings WHERE product_id = ? AND provider = 'channex' AND delivery_lease = ?", [home.product_id, lease.token])) return false
      await lease.check()
      const result = await send(batch)
      const refused = refusals(result, kind, batch.map(change => change.row.date))
      const task = ariTask(result, refused.size > 0)
      for (const change of batch) {
        const reason = refused.get(change.row.date)
        if (reason) review(change.row.date, reason)
        else take(change)
      }
      await log(kind, refused.size ? 'needs_review' : 'pushed', refused.size ? [...new Set(refused.values())].join(' ') : span, task)
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
      const retryAt = new Date(Date.now() + Math.min(MAX_RETRY_MS, RATE_WINDOW_MS * 2 ** Math.max(...batch.map(change => change.row.attempts)))).toISOString()
      paused = (attempts) => {
        return { state: 'pending', detail: `${reason} Attempt ${attempts + 1}; sending again at ${clock(retryAt)}.`, attempts: attempts + 1, retry_at: retryAt }
      }
      wait(batch, paused)
    }
  }

  const held = `EXISTS (SELECT 1 FROM product_channel_mappings m WHERE m.product_id = channel_night_pushes.product_id AND m.provider = 'channex' AND m.delivery_lease = ?)`
  if (!await queryFirst(db, "SELECT 1 FROM product_channel_mappings WHERE product_id = ? AND provider = 'channex' AND delivery_lease = ?", [home.product_id, lease.token])) return false
  await execute(db, `UPDATE channel_night_pushes SET sent_json = json_extract(value, '$[1]')
    FROM json_each(?) WHERE product_id = ? AND provider = 'channex' AND date = json_extract(value, '$[0]') AND ${held}`,
  [JSON.stringify([...confirmed].map(([date, values]) => [date, JSON.stringify(values)])), home.product_id, lease.token])
  // What Channex confirmed is kept whatever the night's state; a night changed again since this delivery read it stays pending for the next.
  await execute(db, `UPDATE channel_night_pushes SET state = json_extract(value, '$.state'), detail = json_extract(value, '$.detail'), attempts = json_extract(value, '$.attempts'),
      retry_at = json_extract(value, '$.retry_at'), updated_at = ?
    FROM json_each(?) WHERE product_id = ? AND provider = 'channex' AND date = json_extract(value, '$.date') AND channel_night_pushes.updated_at = json_extract(value, '$.updated_at') AND ${held}`,
  [new Date().toISOString(), JSON.stringify(due.map((row) => {
    const outcome = outcomes.get(row.date)
    return { date: row.date, updated_at: row.updated_at, state: outcome?.state ?? 'pushed', detail: outcome?.detail ?? null,
      attempts: outcome?.state === 'pending' ? outcome.attempts : 0, retry_at: outcome?.state === 'pending' ? outcome.retry_at : null }
  })), home.product_id, lease.token])
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
 * mapping has nothing to push and returns null. Provider failures retain their
 * original error/proof for the caller's completion and connection cleanup.
 * The availability write is journaled only after required source reads.
 */
export async function pushAirbnbListingSettings(db: DbClient, env: ChannexEnv, organizationId: string, productId: string, settings: AirbnbListingSettings, target?: ChannexMapping, writeAvailability: (action: () => Promise<void>) => Promise<void> = async action => action()): Promise<ChannelPush | null> {
  const mapping = target ?? await connectedMapping(db, env, organizationId, productId)
  if (!mapping) return null
  const row = await queryFirst<{ channel_id: string; listing_id: string }>(db, "SELECT channel_id, listing_id FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex'", [organizationId, productId])
  const path = `/channels/${encodeURIComponent(row!.channel_id)}`
  const channel = object((await channexRequest(env, path)).data, 'channel')
  const ratePlans = object(channel.attributes, 'channel.attributes').rate_plans
  const listing = Array.isArray(ratePlans) ? ratePlans.map(entry => object(entry, 'Mapping')).find(entry => entry.rate_plan_id === mapping.rate_plan_id && object(entry.settings, 'Mapping settings').listing_id === row!.listing_id) : undefined
  if (!listing || typeof listing.id !== 'string') return { state: 'needs_review', detail: 'Channex has no mapping for this listing; its settings were not sent to Airbnb' }
  const mappingId = encodeURIComponent(listing.id)
  if (Object.keys(settings.booking).length) {
    const kept = await keptBookingSettings(env, row!.channel_id, row!.listing_id)
    const controls = settings.booking.guest_controls
    await channexRequest(env, `${path}/execute/update_booking_setting`, 'PUT', { channel_rate_plan_id: listing.id, data: {
      ...settings.booking, instant_booking_allowed_category: kept.instantBooking, listing_expectations_for_guests: kept.expectations,
      ...(controls === undefined ? {} : { guest_controls: { ...kept.guestControls, ...object(controls, 'guest_controls') } }),
    } })
  }
  if (Object.keys(settings.availability).length) {
    const availabilityPath = `${path}/mappings/${mappingId}/availability_settings`
    const attributes = object((await listingRecord(env, row!.channel_id, row!.listing_id)).availability_rules, 'Airbnb availability rules')
    // This is a full settings update. Preserve the provider's required controls instead of inventing notice or turnover policies.
    for (const field of ['booking_lead_time', 'max_days_notice', 'default_max_nights', 'turnover_days']) {
      if (typeof attributes[field] !== 'number' || !Number.isFinite(attributes[field])) throw new ChannexDataError(`Airbnb availability settings are missing ${field}`)
    }
    const fields = ['booking_lead_time', 'max_days_notice', 'allow_rtb_beyond_max_days_notice', 'default_min_nights', 'default_max_nights', 'allow_rtb_above_max_nights', 'day_of_week_check_in', 'day_of_week_check_out', 'seasonal_min_nights', 'turnover_days']
    const kept = Object.fromEntries(fields.filter(field => attributes[field] !== undefined && attributes[field] !== null).map(field => [field, attributes[field]]))
    await writeAvailability(async () => {
      await channexRequest(env, availabilityPath, 'PUT', { availability_settings: { ...kept, ...settings.availability } })
      if (settings.availability.default_min_nights !== undefined && await listingMinimumNights(env, row!.channel_id, row!.listing_id) !== settings.availability.default_min_nights) throw new ChannexDataError('Airbnb has not confirmed the listing default minimum stay; read the listing before retrying')
    })
  }
  return { state: 'pushed', detail: null }
}
