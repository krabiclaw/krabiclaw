import { execute, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { StayHome, StayNight } from '~/server/domain/stays'
import { currencyFractionDigits, type CurrencyCode } from '~/shared/currencies'
import { channexGet, channexRequest, ChannexError, type ChannexEnv } from './client'
import { ChannexDataError, integer, object, string } from './data'
import { keptBookingSettings } from './airbnb-listing'
import { HTTPError } from 'nitro'
import { STAY_CALENDAR_DAYS } from '~/shared/bookings'
import type { ChannelPush, SuccessfulChannelPush } from '~/shared/channel-push'
import { scheduleBusinessWake, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'

/** A raw push failure is not a persisted review outcome. Its writer must complete it. */
export type ChannelPushCompletion = ChannelPush | Error | null

/** Publish committed state before reporting every failed completion step. */
export async function completeChannelPush<T extends object>(outcome: ChannelPushCompletion, context: {
  product_id: string; updated_at?: string; ranges?: ReadonlyArray<readonly [string, string]>; booking_id?: string; version?: number
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
 * Channex. Blawby is the master. A change marks its nights pending in
 * channel_night_pushes, the delivery outbox; delivery reads the home's due
 * pending nights as they are now and sends Channex only what differs from
 * what Channex last confirmed for each (sent_json), contiguous nights with
 * the same change as one date range: at most one restrictions call and one
 * availability call per home. Availability is 0 when a booking takes the
 * night, else 1. Closing a night sets stop_sell on the rate plan, and opening
 * it clears stop_sell. Neither touches availability (docs.channex.io ARI
 * and its certification: a stop sell is one restrictions update). Airbnb's
 * minimum is a rule of the arrival date. The saved home minimum applies
 * when that date has no weekday or nightly override.
 *
 * A home's full sync is the same delivery over every night of the calendar
 * ahead, with nothing confirmed yet: an import's inventory, and a home that
 * syncs again after it stopped.
 *
 * Channex takes 10 restrictions and 10 availability calls per property per
 * minute (docs.channex.io/docs/rate-limits). Delivery counts this property's
 * calls in the last minute from channel_sync_log and leaves the nights pending
 * instead of exceeding the limit; the next delivery sends them because they
 * are pending. A call Channex did not confirm (a 429, a 5xx, the network, an
 * unreadable answer) is logged as failed with Channex's answer and its nights
 * stay pending with that reason. ARI values are absolute, so a night sent
 * twice changes nothing. Only a refusal or a partial rejection (200 with
 * meta.warnings, by the dates it names) marks nights needs_review with
 * Channex's reason. Pending nights schedule a wake for their business.
 */

const RATE_WINDOW_MS = 60_000
const CALLS_PER_WINDOW = 10
/** A night changed while a delivery had it in flight: that delivery sent the old value, so the night stays pending for the next. */
const CHANGED_DURING_DELIVERY = 'This change was saved while a delivery was under way; the next delivery sends it'
const DEFAULTS_PENDING = 'Channex rate plan defaults are pending.'
const MAPPING_MISSING = 'Channex has no Airbnb mapping for this connected home'

export interface ChannexMapping { property_id: string; room_type_id: string; rate_plan_id: string }
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

interface OutboxRow { date: string; state: 'pending' | 'pushed' | 'needs_review'; detail: string | null; sent_json: string | null; updated_at: string }
type Outcome = { state: 'pending' | 'needs_review'; detail: string }

/** Reads a home's nights over [from, to) as they are now. */
type AriHome = Pick<StayHome, 'product_id' | 'timezone' | 'currency' | 'min_nights' | 'calendar_rules' | 'base_price_minor'>
type NightDelivery = { next: number | null; failure?: HTTPError }
export type NightQueue = 'dates' | 'defaults' | 'saved'

export type StayNightReader = (from: string, to: string) => Promise<StayNight[]>

function rate(minor: number, currency: CurrencyCode): string {
  return (minor / 10 ** currencyFractionDigits(currency)).toFixed(currencyFractionDigits(currency))
}

function today(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + 1)
  return day.toISOString().slice(0, 10)
}

function clock(instant: string): string {
  return `${instant.slice(11, 16)} UTC`
}

function ariValues(night: StayNight, home: AriHome): AriValues {
  return {
    availability: night.booking_id === null ? 1 : 0,
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

/** The mapped rate plan's defaults govern each new date Channex adds to its rolling calendar. */
export async function configureStayCalendar(db: DbClient, env: ChannexEnv, organizationId: string, home: AriHome, mapping?: ChannexMapping): Promise<void> {
  try {
    const target = mapping ?? await connectedMapping(db, env, organizationId, home.product_id)
    if (!target) return
    const linked = await queryFirst<{
      channel_id: string | null; listing_id: string | null; enabled: number; import_stage: string
    }>(db, `SELECT CASE WHEN c.status = 'connected' AND c.channel_id = m.channel_id THEN m.channel_id END AS channel_id,
      m.listing_id, m.enabled, m.import_stage FROM product_channel_mappings m
      LEFT JOIN channex_connections c ON c.organization_id = m.organization_id
      WHERE m.organization_id = ? AND m.product_id = ? AND m.provider = 'channex'`, [organizationId, home.product_id])
    if (!linked) throw new ChannexDataError('The home has no Channex property mapping')
    const channelId = linked.import_stage === 'draft' ? null : linked.channel_id
    if (channelId !== null) {
      const channelPath = `/channels/${encodeURIComponent(channelId)}`
      const channel = await channexGet(env, channelPath, 'channel')
      if (channel.id !== channelId || channel.attributes.channel !== 'AirBNB') throw new ChannexDataError('Channex returned a different Airbnb channel for this home')
      if (!Array.isArray(channel.attributes.rate_plans)) throw new ChannexDataError('The Airbnb channel has no listing mappings')
      const mapped = channel.attributes.rate_plans.map(value => object(value, 'Mapping')).some(value => value.rate_plan_id === target.rate_plan_id && object(value.settings, 'Mapping settings').listing_id === linked.listing_id)
      if (linked.enabled === 1 && ['reservations', 'messages', 'complete'].includes(linked.import_stage) && !mapped) {
        throw new ChannexError(MAPPING_MISSING, 404, { code: 'CHANNEL_MAPPING_NOT_FOUND', field: 'rate_plan_id' })
      }
      const channelSettings = object(channel.attributes.settings, 'channel.settings')
      if (channelSettings.min_stay_type !== 'Arrival') await channexRequest(env, channelPath, 'PUT', { channel: { channel: 'AirBNB', settings: { ...channelSettings, min_stay_type: 'Arrival' } } })
    }
    const propertyPath = `/properties/${encodeURIComponent(target.property_id)}`
    const property = await channexGet(env, propertyPath, 'property')
    if (property.id !== target.property_id) throw new ChannexDataError('Channex returned a different property for this home')
    const propertySettings = object(property.attributes.settings, 'property.settings')
    const minimumType = string(propertySettings.min_stay_type, 'property.settings.min_stay_type')
    if (!['arrival', 'through', 'both'].includes(minimumType)) throw new ChannexDataError(`Channex returned an unknown minimum-stay type: ${minimumType}`)
    if (minimumType !== 'arrival') await channexRequest(env, propertyPath, 'PUT', { property: { settings: { ...propertySettings, min_stay_type: 'arrival' } } })
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
      await channexRequest(env, ratePath, 'PUT', { rate_plan: {
        ...(minimumChanged ? { min_stay_arrival: canonicalMinimum } : {}),
        ...(priceChanged ? { options: originalOptions.map(value => value.is_primary ? { ...value, rate: baseRate } : value) } : {}),
      } })
    }
  } catch (error) {
    if (error instanceof ChannexDataError) throw new ChannexError(`Channex returned invalid calendar defaults: ${error.message}`, 502, { code: 'INVALID_PROVIDER_RESPONSE', field: 'calendar_defaults' })
    throw error
  }
}

/**
 * Queue these nights of one home and deliver the home's pending nights.
 * A home with no enabled Channex mapping has nothing to push and returns
 * null. Nights before today where the home is are skipped: Channex does not
 * take past dates. The outcome is these nights' state after delivery: pending
 * while Channex's rate limit or an unconfirmed call holds them.
 */
export async function pushStayNights(db: DbClient, env: ChannexEnv & GuestInboxPublicationEnv, organizationId: string, home: AriHome, dates: readonly string[], read: StayNightReader, queue: NightQueue = 'dates'): Promise<ChannelPush | null> {
  const mapping = await connectedMapping(db, env, organizationId, home.product_id)
  if (!mapping) return null
  return queueAndDeliver(db, env, organizationId, home, mapping, dates, read, queue)
}

/**
 * Every night of the calendar ahead to the property the home is mapped to,
 * whether or not the mapping is enabled yet: an import's full sync, before the
 * listing syncs, and the full sync of a home that syncs again. What Channex
 * last confirmed is what the outbox holds; a caller resending the whole
 * calendar clears those confirmations first.
 */
export async function pushStayCalendar(db: DbClient, env: ChannexEnv & GuestInboxPublicationEnv, organizationId: string, home: AriHome, mapping: ChannexMapping, read: StayNightReader): Promise<ChannelPush> {
  const from = today(home.timezone)
  const outcome = await queueAndDeliver(db, env, organizationId, home, mapping, calendarDates(from), read)
  if (!outcome) throw new Error(`The calendar of ${home.product_id} has no night from ${from} to send`)
  return outcome
}

/** Forget what Channex confirmed for a home: its next delivery sends every night whole. */
export async function forgetConfirmedNights(db: DbClient, productId: string): Promise<void> {
  await execute(db, "UPDATE channel_night_pushes SET sent_json = NULL WHERE product_id = ? AND provider = 'channex'", [productId])
}

function addDays(date: string, count: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10)
}

function calendarDates(from: string): string[] {
  return Array.from({ length: STAY_CALENDAR_DAYS }, (_, offset) => addDays(from, offset))
}

export function pendingChannelNightsQuery(
  organizationId: string, productId: string, dates: readonly string[] | BatchQuery, updatedAt: string, guard?: BatchQuery, detail: string | null = null,
): BatchQuery {
  const source = 'query' in dates ? dates : { query: 'SELECT value AS date FROM json_each(?)', params: [JSON.stringify(dates)] }
  // Move the revision even if the night is pending, so an older delivery cannot clear it.
  return {
    query: `INSERT INTO channel_night_pushes (organization_id, product_id, provider, date, state, detail, updated_at)
      SELECT ?, ?, 'channex', dates.date, 'pending', ?, ? FROM (${source.query}) dates WHERE ${guard?.query ?? 'true'}
      ON CONFLICT (product_id, provider, date) DO UPDATE SET state = 'pending',
        updated_at = CASE WHEN excluded.updated_at > channel_night_pushes.updated_at THEN excluded.updated_at
          ELSE strftime('%Y-%m-%dT%H:%M:%fZ', channel_night_pushes.updated_at, '+0.001 seconds') END,
        detail = COALESCE(excluded.detail, CASE WHEN channel_night_pushes.state = 'pending' THEN channel_night_pushes.detail END)`,
    params: [organizationId, productId, detail, updatedAt, ...(source.params ?? []), ...(guard?.params ?? [])],
  }
}

/** Put the delivery in the save's own batch and schedule recovery if immediate delivery did not finish. */
export function pendingConnectedChannelNightsQuery(organizationId: string, productId: string, dates: readonly string[] | BatchQuery, updatedAt: string, detail: string | null = null): BatchQuery {
  const pending = pendingChannelNightsQuery(organizationId, productId, dates, updatedAt, {
    query: "EXISTS (SELECT 1 FROM product_channel_mappings WHERE organization_id = ? AND product_id = ? AND provider = 'channex' AND enabled = 1)",
    params: [organizationId, productId],
  }, detail)
  return { ...pending, event: { type: 'business.wake', organization_id: organizationId, kind: 'channex_ari', due_at: Date.parse(updatedAt) + RATE_WINDOW_MS } }
}

export function pendingConnectedChannelCalendarQuery(organizationId: string, productId: string, timezone: string, updatedAt: string): BatchQuery {
  return pendingConnectedChannelNightsQuery(organizationId, productId, calendarDates(today(timezone, new Date(updatedAt))), updatedAt, DEFAULTS_PENDING)
}

async function queueAndDeliver(db: DbClient, env: ChannexEnv & GuestInboxPublicationEnv, organizationId: string, home: AriHome, mapping: Mapping, dates: readonly string[], read: StayNightReader, queue: NightQueue = 'dates'): Promise<ChannelPush | null> {
  const from = today(home.timezone)
  const queued = [...new Set(dates.filter(date => date >= from))].sort()
  if (!queued.length) return null
  if (queue !== 'saved') {
    const pending = pendingChannelNightsQuery(organizationId, home.product_id, queued, new Date().toISOString(), undefined, queue === 'defaults' ? DEFAULTS_PENDING : null)
    await execute(db, pending.query, pending.params)
  }
  const { next, failure } = await deliver(db, env, organizationId, home, mapping, read)
  if (next !== null) await scheduleBusinessWake(env, organizationId, 'channex_ari', next)
  if (failure) throw failure
  const rows = await queryAll<{ state: OutboxRow['state']; detail: string | null }>(db, `SELECT state, detail FROM channel_night_pushes
    WHERE product_id = ? AND provider = 'channex' AND date IN (SELECT value FROM json_each(?)) ORDER BY state = 'needs_review' DESC, state = 'pending' DESC, date`,
  [home.product_id, JSON.stringify(queued)])
  const worst = rows[0]
  if (!worst || worst.state === 'pushed') return { state: 'pushed', detail: null }
  return { state: worst.state, detail: worst.detail ?? CHANGED_DURING_DELIVERY }
}

/** Deliver one home's pending nights now. A home with no enabled mapping has nothing to deliver. */
export async function deliverStayNights(db: DbClient, env: ChannexEnv, organizationId: string, home: AriHome, read: StayNightReader, newDates: readonly string[]): Promise<number | null> {
  const mapping = await connectedMapping(db, env, organizationId, home.product_id)
  if (!mapping) return null
  if (newDates.length) {
    const pending = pendingChannelNightsQuery(organizationId, home.product_id, newDates, new Date().toISOString())
    await execute(db, pending.query, pending.params)
  }
  return (await deliver(db, env, organizationId, home, mapping, read)).next
}

/**
 * One delivery of the home's pending nights: what differs from what Channex
 * last confirmed, as at most one restrictions call and one availability call.
 * A night changed again since this delivery read it stays pending for the
 * next; two deliveries of the same home send the same absolute values.
 */
async function deliver(db: DbClient, env: ChannexEnv, organizationId: string, home: AriHome, mapping: Mapping, read: StayNightReader): Promise<NightDelivery> {
  const due = await queryAll<OutboxRow>(db, `SELECT date, state, detail, sent_json, updated_at FROM channel_night_pushes
    WHERE product_id = ? AND provider = 'channex' AND state = 'pending' ORDER BY date`, [home.product_id])
  if (!due.length) return { next: null }
  const from = today(home.timezone)
  const current = due.filter(row => row.date >= from)
  const defaults = current.filter(row => row.detail?.startsWith(DEFAULTS_PENDING))
  let defaultsFailure: { error: ChannexError; retryAt: number } | null = null
  if (defaults.length) {
    try {
      await configureStayCalendar(db, env, organizationId, home, mapping)
    } catch (cause) {
      if (!(cause instanceof ChannexError) && !(cause instanceof HTTPError && cause.data?.code === 'PRICE_REQUIRED')) throw cause
      const retry = cause instanceof ChannexError && (cause.providerStatus === 429 || cause.providerStatus >= 500)
      if (retry && cause.data.code === 'CHANNEX_REQUEST_FAILED') {
        // A temporary settings outage cannot stop booking occupancy from reaching the mapped room.
        defaultsFailure = { error: cause, retryAt: Date.now() + RATE_WINDOW_MS }
      } else {
        await execute(db, `UPDATE channel_night_pushes SET state = ?, detail = ?
          FROM json_each(?) WHERE organization_id = ? AND product_id = ? AND provider = 'channex' AND state = 'pending'
            AND date = json_extract(value, '$.date') AND updated_at = json_extract(value, '$.updated_at')`,
        [retry ? 'pending' : 'needs_review', retry ? `${DEFAULTS_PENDING} ${cause.message}` : cause.message,
          JSON.stringify(due.map(({ date, updated_at }) => ({ date, updated_at }))), organizationId, home.product_id])
        return { next: retry ? Date.now() + RATE_WINDOW_MS : null, failure: cause }
      }
    }
    if (!defaultsFailure) for (const row of defaults) row.detail = null
  }
  const outcomes = new Map<string, Outcome>()
  for (const row of due) if (row.date < from) outcomes.set(row.date, { state: 'needs_review', detail: `${row.date} passed before Channex confirmed it; Channex does not take past dates` })
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
  const recent = await queryAll<{ kind: 'availability' | 'restrictions'; calls: number; first: string; last_failed: string | null }>(db, `SELECT kind, COUNT(*) AS calls, MIN(created_at) AS first,
      MAX(CASE WHEN status = 'failed' THEN created_at END) AS last_failed FROM channel_sync_log
    WHERE provider = 'channex' AND direction = 'outbound' AND external_id = ? AND created_at > ? GROUP BY kind`,
  [mapping.property_id, new Date(Date.now() - RATE_WINDOW_MS).toISOString()])
  const confirmed = new Map(current.map(row => [row.date, { ...sent.get(row.date)! }]))
  let next = defaultsFailure?.retryAt ?? Infinity
  // A night still to be sent stays pending, even with a part Channex refused: its next delivery sends what differs again.
  const wait = (rows: ReadonlyArray<{ row: OutboxRow }>, at: number, detail?: string) => {
    next = Math.min(next, at)
    for (const { row } of rows) outcomes.set(row.date, { state: 'pending', detail: detail ?? row.detail ?? CHANGED_DURING_DELIVERY })
  }
  const review = (date: string, detail: string) => { if (outcomes.get(date)?.state !== 'pending') outcomes.set(date, { state: 'needs_review', detail }) }

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
    if (!batch.length || (defaultsFailure && kind === 'restrictions')) continue
    const window = recent.find(entry => entry.kind === kind)
    if (window) {
      const rateLimit = window.calls >= CALLS_PER_WINDOW ? Date.parse(window.first) + RATE_WINDOW_MS : 0
      const failedUntil = window.last_failed ? Date.parse(window.last_failed) + RATE_WINDOW_MS : 0
      if (Math.max(rateLimit, failedUntil) > Date.now()) {
        const at = Math.max(rateLimit, failedUntil)
        wait(batch, at, at === rateLimit ? `Channex takes ${CALLS_PER_WINDOW} ${kind} updates a minute for this home; this one goes after ${clock(new Date(at).toISOString())}` : undefined)
        continue
      }
    }
    const span = `${batch[0]!.row.date}..${batch.at(-1)!.row.date}`
    try {
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
      const unconfirmed = error instanceof ChannexDataError || error.providerStatus === 429 || error.providerStatus >= 500
      if (!unconfirmed) {
        await log(kind, 'needs_review', error.message)
        for (const change of batch) review(change.row.date, `Channex refused the ${kind} update: ${error.message}`)
        continue
      }
      const reason = `Channex did not confirm the ${kind} update for ${span}: ${error.message}`
      await log(kind, 'failed', reason)
      wait(batch, Date.now() + RATE_WINDOW_MS, reason)
    }
  }

  if (defaultsFailure) {
    for (const row of current) {
      const availabilityDetail = outcomes.get(row.date)?.detail
      const detail = `${DEFAULTS_PENDING} ${defaultsFailure.error.message}`
      outcomes.set(row.date, { state: 'pending', detail: availabilityDetail && !availabilityDetail.startsWith(DEFAULTS_PENDING) ? `${detail} ${availabilityDetail}` : detail })
    }
  }

  // A night changed since this delivery read it may have had its availability changed by Channex itself
  // (a channel booking): the availability this delivery read is not recorded as confirmed, so the next one sends it.
  const readAt = new Map(current.map(row => [row.date, row.updated_at]))
  await execute(db, `UPDATE channel_night_pushes SET sent_json = CASE WHEN channel_night_pushes.updated_at = json_extract(value, '$[2]')
      THEN json_extract(value, '$[1]') ELSE json_remove(json_extract(value, '$[1]'), '$.availability') END
    FROM json_each(?) WHERE product_id = ? AND provider = 'channex' AND date = json_extract(value, '$[0]')`,
  [JSON.stringify([...confirmed].map(([date, values]) => [date, JSON.stringify(values), readAt.get(date)])), home.product_id])
  // What Channex last received is kept whatever the night's state. A night changed since this delivery read it was sent
  // its old value, so it stays pending with that reason and the next delivery sends what differs.
  const finalized = await queryAll<{ date: string; state: OutboxRow['state'] }>(db, `UPDATE channel_night_pushes SET
      state = CASE WHEN channel_night_pushes.updated_at = json_extract(value, '$.updated_at') THEN json_extract(value, '$.state') ELSE 'pending' END,
      detail = CASE WHEN channel_night_pushes.updated_at = json_extract(value, '$.updated_at') THEN json_extract(value, '$.detail')
        WHEN instr(channel_night_pushes.detail, ?) = 1 THEN channel_night_pushes.detail ELSE ? END,
      updated_at = ?
    FROM json_each(?) WHERE product_id = ? AND provider = 'channex' AND date = json_extract(value, '$.date')
    RETURNING date, state`,
  [DEFAULTS_PENDING, CHANGED_DURING_DELIVERY, new Date().toISOString(), JSON.stringify(due.map((row) => {
    const outcome = outcomes.get(row.date)
    return { date: row.date, updated_at: row.updated_at, state: outcome?.state ?? 'pushed', detail: outcome?.detail ?? null }
  })), home.product_id])
  if (finalized.some(row => row.state === 'pending' && outcomes.get(row.date)?.state !== 'pending')) next = Math.min(next, Date.now())
  return { next: Number.isFinite(next) ? next : null, ...(defaultsFailure ? { failure: defaultsFailure.error } : {}) }
}

export async function activeAirbnbMapping(db: DbClient, organizationId: string, productId: string) {
  return await queryFirst<{ channel_id: string; listing_id: string; rate_plan_id: string }>(db, `SELECT m.channel_id, m.listing_id, m.rate_plan_id
    FROM product_channel_mappings m JOIN channex_connections c ON c.organization_id = m.organization_id AND c.channel_id = m.channel_id
    WHERE m.organization_id = ? AND m.product_id = ? AND m.provider = 'channex' AND c.status = 'connected'
      AND m.enabled = 1 AND m.import_stage IN ('reservations', 'messages', 'complete')`, [organizationId, productId])
}

/**
 * Have Channex send the listing's whole calendar to Airbnb. Channex sends Airbnb
 * a night only when its value changes, so a night changed on Airbnb itself stays
 * as Airbnb has it until this runs. A home with no Airbnb listing has nothing to
 * send; a listing Channex no longer maps is the home's nights needing review.
 */
export async function syncAirbnbListing(db: DbClient, env: ChannexEnv, organizationId: string, productId: string): Promise<void> {
  const mapping = await activeAirbnbMapping(db, organizationId, productId)
  if (!mapping) return
  try {
    await channexRequest(env, `/meta/airbnb/${encodeURIComponent(mapping.channel_id)}/full_sync_listing`, 'POST', { listing_id: mapping.listing_id })
  } catch (error) {
    if (!(error instanceof ChannexError) || error.providerStatus !== 404) throw error
    await execute(db, `UPDATE channel_night_pushes SET state = 'needs_review', detail = ? WHERE organization_id = ? AND product_id = ? AND provider = 'channex' AND date >= date('now', '-1 day')`,
      [MAPPING_MISSING, organizationId, productId])
  }
}

/**
 * Push the changed check-in, checkout, house rules or cancellation settings
 * for a connected Airbnb home. The mapped rate plan carries dated stay rules.
 */
export async function pushAirbnbBookingSettings(env: ChannexEnv, row: NonNullable<Awaited<ReturnType<typeof activeAirbnbMapping>>>, booking: Record<string, unknown>): Promise<ChannelPush | null> {
  if (!Object.keys(booking).length) return null
  const path = `/channels/${encodeURIComponent(row.channel_id)}`
  const channel = object((await channexRequest(env, path)).data, 'channel')
  const ratePlans = object(channel.attributes, 'channel.attributes').rate_plans
  const listing = Array.isArray(ratePlans) ? ratePlans.map(entry => object(entry, 'Mapping')).find(entry => entry.rate_plan_id === row.rate_plan_id && object(entry.settings, 'Mapping settings').listing_id === row.listing_id) : undefined
  if (!listing || typeof listing.id !== 'string') return { state: 'needs_review', detail: 'Channex has no mapping for this listing; its settings were not sent to Airbnb' }
  const kept = await keptBookingSettings(env, row.channel_id, row.listing_id)
  const controls = booking.guest_controls
  await channexRequest(env, `${path}/execute/update_booking_setting`, 'PUT', { channel_rate_plan_id: listing.id, data: {
    ...booking, instant_booking_allowed_category: kept.instantBooking, listing_expectations_for_guests: kept.expectations,
    ...(controls === undefined ? {} : { guest_controls: { ...kept.guestControls, ...object(controls, 'guest_controls') } }),
  } })
  return { state: 'pushed', detail: null }
}
