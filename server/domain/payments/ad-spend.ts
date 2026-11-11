import {HTTPError} from 'nitro'
import {execute, queryAll, queryFirst, type DbClient} from '~/server/db'
import type {CloudflareEnv} from '~/server/utils/auth'
import {linkedAccountAccessToken} from '~/server/utils/auth'
import {getGoogleAdsCustomer, getGoogleAdsPerformanceSummary} from '~/server/utils/google-ads'
import {getMetaAdAccount, getMetaAdsPerformanceSummary} from '~/server/utils/meta-ads'
import {readIntegration} from '~/server/utils/organization-integrations'
import { addLocalDays, assertCalendarDate, instantDate, localDateAt } from '~/utils/timezone'
import { listServices } from '~/server/utils/organization-services'
import { localDateBounds } from '~/server/utils/analytics-calendar'
import { paymentUsageEventQuery } from './usage'

/** Closed managed days for one ads integration whose amount has not reached the usage outbox. */
export async function unrecordedDaysForIntegration(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
  ads: { provider: 'google_ads' | 'meta_ads'; account_id: string; target_id: string; created_at: string },
  now = new Date(),
  reportingDelayDays: 1 | 2 = 1,
): Promise<string[]> {
  instantDate(now)
  const connectedAt = instantDate(ads.created_at).toISOString()
  const periods = await queryAll<{ agreed_at: string; ended_at: string | null }>(db, "SELECT agreed_at,ended_at FROM organization_services WHERE organization_id=? AND service='managed_ads' ORDER BY agreed_at", [organizationId])
  const intervals = periods.map(period => ({ start: instantDate(period.agreed_at).toISOString(), end: period.ended_at === null ? null : instantDate(period.ended_at).toISOString() }))
  if (!intervals.some(period => period.end === null || period.end > connectedAt)) return []
  const { accessToken } = await linkedAccountAccessToken(env, ads.account_id)
  const isMeta = ads.provider === 'meta_ads'
  const timeZone = isMeta
    ? (await getMetaAdAccount(accessToken, ads.target_id)).timezoneName
    : (await getGoogleAdsCustomer(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, ads.target_id)).timeZone
  if (!timeZone) throw new Error(`Ads account ${ads.target_id} has no reporting timezone`)
  const throughDate = addLocalDays(localDateAt(now, timeZone), -reportingDelayDays)
  const prefix = isMeta ? `meta_ads:${ads.target_id}:%` : `google_ads:${ads.target_id}:%`
  const keyPrefix = isMeta ? `meta_ads:${ads.target_id}:` : `google_ads:${ads.target_id}:`
  const recorded = new Set((await queryAll<{ source_id: string }>(db, "SELECT idempotency_key AS source_id FROM usage_events WHERE organization_id=? AND resource='ad_spend' AND provider_occurred_at IS NOT NULL AND idempotency_key LIKE ?", [organizationId, prefix])).map(row => row.source_id))
  const missing: string[] = []
  // An agreement predating a connection still applies to its overlapping days.
  // Never charge before either consent or the current connection existed.
  const start = localDateAt(instantDate([intervals.map(period => period.start).sort()[0]!, connectedAt].sort().at(-1)!), timeZone)
  for (let date = start; date <= throughDate; date = addLocalDays(date, 1)) {
    const { end } = localDateBounds(date, timeZone)
    if (connectedAt < end && intervals.some(period => period.start < end && (period.end === null || period.end >= end)) && !recorded.has(`${keyPrefix}${date}`)) missing.push(date)
  }
  return missing
}

/** Closed managed days whose actual Google or Meta amount has not reached the usage outbox. */
export async function unrecordedAdSpendDays(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
  now = new Date(),
  reportingDelayDays: 1 | 2 = 1,
  providers: readonly ('google_ads' | 'meta_ads')[] = ['google_ads', 'meta_ads'],
): Promise<string[]> {
  instantDate(now)
  const missing: string[] = []
  for (const provider of providers) {
    const ads = await readIntegration(db, organizationId, provider)
    if (ads?.account_id && ads.target_id) {
      missing.push(...await unrecordedDaysForIntegration(db, env, organizationId, {
        provider,
        account_id: ads.account_id,
        target_id: ads.target_id,
        created_at: ads.created_at,
      }, now, reportingDelayDays))
    }
  }
  return missing
}

/** The connection is needed until the last managed days have been counted. */
export async function requireRecordedManagedSpend(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
  product?: 'google-ads' | 'meta-ads',
): Promise<void> {
  const providerLabel = product === 'meta-ads' ? 'Meta Ads' : 'Google Ads'
  const targetProvider: 'google_ads' | 'meta_ads' = product === 'meta-ads' ? 'meta_ads' : 'google_ads'
  if ((await listServices(db, organizationId)).managed_ads) throw new HTTPError({ statusCode: 409, message: `Turn off managed ads in Plan before changing ${providerLabel}.` })
  if ((await unrecordedAdSpendDays(db, env, organizationId, new Date(), 1, [targetProvider])).length) {
    throw new HTTPError({ statusCode: 409, message: `Keep ${providerLabel} connected until your prior managed spend has been counted. We count each day after two days; contact support if it remains pending.` })
  }
}

async function persistAdSpendReceipt(
  db: DbClient,
  organizationId: string,
  sourceId: string,
  amount: number,
  occurredAt: string,
  date: string,
  providerLabel: string,
): Promise<{ amount: number }> {
  const existing = await queryFirst<{ organization_id: string; amount: number; provider_occurred_at: string }>(
    db,
    "SELECT organization_id,quantity AS amount,provider_occurred_at FROM usage_events WHERE idempotency_key=? AND resource='ad_spend' AND provider_occurred_at IS NOT NULL",
    [sourceId],
  )
  if (existing && existing.organization_id !== organizationId) throw new Error(`${providerLabel} spend receipt belongs to another organization`)
  if (existing && existing.amount !== amount) throw new Error(`${providerLabel} spend for ${date} changed after it was queued (${existing.amount} → ${amount} cents); reconcile before billing`)
  if (existing && existing.provider_occurred_at !== occurredAt) throw new Error(`${providerLabel} spend receipt does not match its account reporting day; reconcile before billing`)
  if (!existing) {
    const write = paymentUsageEventQuery({ organizationId, sourceId, kind: 'ad_spend', currency: 'USD', amount, occurredAt })
    await execute(db, write.query, write.params)
  }
  const recorded = await queryFirst<{ organization_id: string; amount: number; provider_occurred_at: string }>(
    db,
    "SELECT organization_id,quantity AS amount,provider_occurred_at FROM usage_events WHERE idempotency_key=? AND resource='ad_spend' AND provider_occurred_at IS NOT NULL",
    [sourceId],
  )
  if (!recorded || recorded.organization_id !== organizationId || recorded.amount !== amount || recorded.provider_occurred_at !== occurredAt) {
    throw new Error(`${providerLabel} spend receipt changed during capture; reconcile before billing`)
  }
  return { amount }
}

/**
 * The managed ads service's usage fee: a share of what the business spent on Google
 * Ads, read from Google for one finished day and queued as an `ad_spend` usage
 * event, which the outbox reports to the Stripe ad-spend meter and the
 * Business subscription bills at its metered rate. Google reports an account in
 * its own currency; the fee is USD, so only USD accounts are billed and any
 * other currency fails here rather than being converted by guesswork.
 */
export async function recordAdSpend(db: DbClient, env: CloudflareEnv, organizationId: string, date: string): Promise<{ amount: number }> {
  assertCalendarDate(date)
  const ads = await readIntegration(db, organizationId, 'google_ads')
  if (!ads?.account_id || !ads.target_id) throw new HTTPError({ statusCode: 409, statusMessage: 'Google Ads is not connected' })
  const { accessToken } = await linkedAccountAccessToken(env, ads.account_id)
  const customer = await getGoogleAdsCustomer(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, ads.target_id)
  const occurredAt = new Date(Date.parse(localDateBounds(date, customer.timeZone).end) - 1).toISOString()
  const summary = await getGoogleAdsPerformanceSummary(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, ads.target_id, date, date)
  if (!Number.isSafeInteger(summary.costMicros) || summary.costMicros < 0) throw new Error('Google Ads spend must be a nonnegative integer number of micros')
  const currency = summary.currencyCode || customer.currencyCode
  if (currency !== 'USD') throw new Error(`Google Ads account ${ads.target_id} spends in ${currency}; the ad-spend fee is billed in USD only`)
  // Google counts in millionths of a dollar; the fee is priced in cents.
  const amount = Math.round(summary.costMicros / 10_000)
  return persistAdSpendReceipt(db, organizationId, `google_ads:${ads.target_id}:${date}`, amount, occurredAt, date, 'Google Ads')
}

/**
 * The managed ads service's usage fee for Meta Ads: reads from Meta for one
 * finished day and queues an `ad_spend` usage event with kind='ad_spend'.
 */
export async function recordMetaAdSpend(db: DbClient, env: CloudflareEnv, organizationId: string, date: string): Promise<{ amount: number }> {
  assertCalendarDate(date)
  const ads = await readIntegration(db, organizationId, 'meta_ads')
  if (!ads?.account_id || !ads.target_id) throw new HTTPError({ statusCode: 409, statusMessage: 'Meta Ads is not connected' })
  const { accessToken } = await linkedAccountAccessToken(env, ads.account_id)
  const account = await getMetaAdAccount(accessToken, ads.target_id)
  const timezone = account.timezoneName
  if (!timezone) throw new Error(`Meta Ads account ${ads.target_id} has no reporting timezone`)
  const occurredAt = new Date(Date.parse(localDateBounds(date, timezone).end) - 1).toISOString()
  const summary = await getMetaAdsPerformanceSummary(accessToken, ads.target_id, date, date)
  const currency = account.currency
  if (!currency) throw new Error(`Meta Ads account ${ads.target_id} has no currency configured`)
  if (currency !== 'USD') throw new Error(`Meta Ads account ${ads.target_id} spends in ${currency}; the ad-spend fee is billed in USD only`)
  return persistAdSpendReceipt(db, organizationId, `meta_ads:${ads.target_id}:${date}`, summary.costCents, occurredAt, date, 'Meta Ads')
}
