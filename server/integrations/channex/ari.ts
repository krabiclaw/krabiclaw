import { execute, queryFirst, type DbClient } from '~/server/db'
import type { StayHome, StayNight } from '~/server/domain/stays'
import { currencyFractionDigits, type CurrencyCode } from '~/shared/currencies'
import { channexRequest, ChannexError, type ChannexEnv } from './client'
import { ChannexDataError, object } from './data'

/**
 * Outbound availability, prices and stay rules for a home connected through
 * Channex. KrabiClaw is the master: after a write changes nights, their current
 * values go to Channex, and each night records what Channex took. Ported from
 * the lodging Worker's ari.ts, with restrictions added because nights here
 * also carry their price and stay rules.
 *
 * A refusal, a partial rejection (200 with meta.warnings) or an outcome
 * Channex never confirmed marks those nights needs_review with the reason and
 * is returned to the caller. It is not retried.
 */

export interface ChannelPush {
  state: 'pushed' | 'needs_review'
  detail: string | null
}

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
  if (mapping && (!env.CHANNEX_BASE_URL?.trim() || !env.CHANNEX_API_KEY?.trim())) throw new Error('CHANNEX_BASE_URL and CHANNEX_API_KEY are required to change a home connected to Channex')
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
