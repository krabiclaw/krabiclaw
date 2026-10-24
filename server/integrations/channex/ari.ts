import { execute, queryFirst, type DbClient } from '~/server/db'
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
 * Channex. KrabiClaw is the master: after a write changes nights, their current
 * values go to Channex, and each night records what Channex took. Restrictions
 * are sent too, because nights here carry their price and stay rules.
 *
 * A refusal, a partial rejection (200 with meta.warnings) or an outcome
 * Channex never confirmed marks those nights needs_review with the reason and
 * is returned to the caller. It is not retried.
 */

interface Mapping { property_id: string; room_type_id: string; rate_plan_id: string }

function rate(minor: number, currency: CurrencyCode): string {
  return (minor / 10 ** currencyFractionDigits(currency)).toFixed(currencyFractionDigits(currency))
}

function today(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function rejection(result: Record<string, unknown>): string | null {
  const meta = object(result.meta, 'Channex ARI result')
  if (meta.message !== 'Success') return `Channex did not report success: ${JSON.stringify(meta).slice(0, 500)}`
  if (meta.warnings !== undefined && (!Array.isArray(meta.warnings) || meta.warnings.length > 0)) return `Channex rejected part of the update: ${JSON.stringify(meta.warnings).slice(0, 500)}`
  return null
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
 * Push these nights of one home. A home with no enabled Channex mapping has
 * nothing to push and returns null. Nights before today where the home is
 * are skipped: Channex does not take past dates.
 */
export async function pushStayNights(db: DbClient, env: ChannexEnv, organizationId: string, home: StayHome, nights: readonly StayNight[]): Promise<ChannelPush | null> {
  const mapping = await connectedMapping(db, env, organizationId, home.product_id)
  if (!mapping) return null
  const from = today(home.timezone)
  const pushed = nights.filter(night => night.date >= from)
  if (!pushed.length) return null
  const dates = JSON.stringify(pushed.map(night => night.date))
  const span = `${pushed[0]!.date}..${pushed.at(-1)!.date}`
  const mark = async (outcome: { state: 'pending' } | ChannelPush) => await execute(db, `
    INSERT INTO channel_night_pushes (organization_id, product_id, provider, date, state, detail, updated_at)
    SELECT ?, ?, 'channex', value, ?, ?, ? FROM json_each(?) WHERE true
    ON CONFLICT (product_id, provider, date) DO UPDATE SET state = excluded.state, detail = excluded.detail, updated_at = excluded.updated_at`,
  [organizationId, home.product_id, outcome.state, 'detail' in outcome ? outcome.detail : null, new Date().toISOString(), dates])
  const log = async (kind: 'availability' | 'restrictions', outcome: ChannelPush) => await execute(db, `INSERT INTO channel_sync_log (id, organization_id, product_id, provider, direction, kind, external_id, status, detail)
    VALUES (?, ?, ?, 'channex', 'outbound', ?, ?, ?, ?)`, [crypto.randomUUID(), organizationId, home.product_id, kind, mapping.property_id, outcome.state, outcome.detail ?? span])

  await mark({ state: 'pending' })
  const unpriced = pushed.find(night => night.price_minor === null)
  if (unpriced) {
    const outcome: ChannelPush = { state: 'needs_review', detail: `${unpriced.date} has no nightly price; Channex needs one for every night` }
    await mark(outcome)
    await log('restrictions', outcome)
    return outcome
  }
  const requests = [
    ['restrictions', () => channexRequest(env, '/restrictions', 'POST', { values: pushed.map(night => ({
      property_id: mapping.property_id, rate_plan_id: mapping.rate_plan_id, date: night.date, rate: rate(night.price_minor!, home.currency),
      min_stay_arrival: night.min_stay_arrival ?? home.min_nights, min_stay_through: night.min_stay_through ?? 1, max_stay: night.max_stay ?? 0,
      closed_to_arrival: night.closed_to_arrival, closed_to_departure: night.closed_to_departure, stop_sell: !night.available,
    })) })],
    ['availability', () => channexRequest(env, '/availability', 'POST', { values: pushed.map(night => ({
      property_id: mapping.property_id, room_type_id: mapping.room_type_id, date: night.date, availability: night.available ? 1 : 0,
    })) })],
  ] as const
  let outcome: ChannelPush = { state: 'pushed', detail: null }
  for (const [kind, send] of requests) {
    let step: ChannelPush
    try {
      const refused = rejection(await send())
      step = refused ? { state: 'needs_review', detail: refused } : { state: 'pushed', detail: null }
    } catch (error) {
      if (error instanceof ChannexDataError) step = { state: 'needs_review', detail: `Channex's answer to the ${kind} update was not readable; its outcome is unknown. ${error.message}` }
      else if (error instanceof ChannexError) step = { state: 'needs_review', detail: error.uncertain ? `Channex did not confirm the ${kind} update; its outcome is unknown. ${error.message}` : error.message }
      else throw error
    }
    await log(kind, step)
    if (step.state === 'needs_review') { outcome = step; break }
  }
  await mark(outcome)
  return outcome
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
