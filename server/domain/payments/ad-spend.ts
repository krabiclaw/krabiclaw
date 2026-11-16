import {HTTPError} from 'nitro'
import {execute, queryAll, queryFirst, type DbClient} from '~/server/db'
import type {CloudflareEnv} from '~/server/utils/auth'
import {linkedAccountAccessToken} from '~/server/utils/auth'
import {getGoogleAdsCustomer, getGoogleAdsPerformanceSummary} from '~/server/utils/google-ads'
import {getMetaAdAccount, getMetaAdsPerformanceSummary} from '~/server/utils/meta-ads'
import {readIntegration} from '~/server/utils/organization-integrations'
import { addLocalDays, instantDate, isValidTimezone, localDateAt } from '~/utils/timezone'
import { listServices } from '~/server/utils/organization-services'
import { localDateBounds } from '~/server/utils/analytics-calendar'
import { deliverPaymentsUsage, paymentUsageEventQuery } from './usage'
import { publishEvent, type EventsEnv } from '~/server/events'

const ADS_PROVIDERS = ['google_ads', 'meta_ads'] as const
const REPORTING_DELAY_DAYS = 2
type AdsProvider = (typeof ADS_PROVIDERS)[number]
type AdsConnection = { provider: AdsProvider; account_id: string; target_id: string; created_at: string }
type ReportingAccount = {
  provider: AdsProvider
  targetId: string
  accessToken: string
  timeZone: string
  currency: string
}
type ManagedPeriod = { start: string; end: string | null }

async function readManagedPeriods(db: DbClient, organizationId: string): Promise<ManagedPeriod[]> {
  const periods = await queryAll<{ agreed_at: string; ended_at: string | null }>(db,
    "SELECT agreed_at,ended_at FROM organization_services WHERE organization_id=? AND service='managed_ads' ORDER BY agreed_at", [organizationId])
  return periods.map(period => ({
    start: instantDate(period.agreed_at).toISOString(),
    end: period.ended_at === null ? null : instantDate(period.ended_at).toISOString(),
  }))
}

async function readAdsConnection(db: DbClient, organizationId: string, provider: AdsProvider): Promise<AdsConnection | null> {
  const ads = await readIntegration(db, organizationId, provider)
  return ads?.account_id && ads.target_id ? { provider, account_id: ads.account_id, target_id: ads.target_id, created_at: ads.created_at } : null
}

async function readReportingAccount(env: CloudflareEnv, ads: AdsConnection): Promise<ReportingAccount> {
  const { accessToken } = await linkedAccountAccessToken(env, ads.account_id)
  const shared = { provider: ads.provider, targetId: ads.target_id, accessToken }
  if (ads.provider === 'meta_ads') {
    const account = await getMetaAdAccount(accessToken, ads.target_id)
    if (!isValidTimezone(account.timezone_name)) throw new Error(`Meta Ads account ${ads.target_id} has no valid reporting timezone`)
    return { ...shared, timeZone: account.timezone_name, currency: account.currency }
  }
  const account = await getGoogleAdsCustomer(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, ads.target_id)
  return { ...shared, timeZone: account.timeZone, currency: account.currencyCode }
}

async function managedSpendPlan(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
  ads: AdsConnection,
  periods: ManagedPeriod[],
  now: Date,
  reportingDelayDays: 1 | 2,
): Promise<{ account: ReportingAccount; days: string[]; next: number | null } | null> {
  const connectedAt = instantDate(ads.created_at).toISOString()
  const intervals = periods.filter(period => period.end === null || period.end > connectedAt)
  if (intervals.length === 0) return null

  const account = await readReportingAccount(env, ads)
  const { timeZone } = account
  const throughDate = addLocalDays(localDateAt(now, timeZone), -reportingDelayDays)
  const keyPrefix = `${ads.provider}:${ads.target_id}:`
  const recorded = new Set((await queryAll<{ source_id: string }>(db,
    "SELECT idempotency_key AS source_id FROM usage_events WHERE organization_id=? AND resource='ad_spend' AND provider_occurred_at IS NOT NULL AND idempotency_key LIKE ?",
    [organizationId, `${keyPrefix}%`])).map(row => row.source_id))

  const missing = new Set<string>()
  let nextDay: string | null = null
  for (const interval of intervals) {
    // Every eligible local day closes after both consent and the connection
    // began, and on or before the agreement ended.
    const from = interval.start > connectedAt ? interval.start : connectedAt
    const firstDay = localDateAt(instantDate(from), timeZone)
    for (let date = firstDay; date <= throughDate; date = addLocalDays(date, 1)) {
      const { end } = localDateBounds(date, timeZone)
      if (interval.end !== null && end > interval.end) break
      if (from < end && !recorded.has(`${keyPrefix}${date}`)) missing.add(date)
    }

    let futureDay = firstDay > throughDate ? firstDay : addLocalDays(throughDate, 1)
    while (recorded.has(`${keyPrefix}${futureDay}`)) futureDay = addLocalDays(futureDay, 1)
    const { end } = localDateBounds(futureDay, timeZone)
    if (from < end && (interval.end === null || end <= interval.end) && (nextDay === null || futureDay < nextDay)) {
      nextDay = futureDay
    }
  }

  return {
    account,
    days: [...missing].sort(),
    next: nextDay === null ? null : Date.parse(localDateBounds(addLocalDays(nextDay, reportingDelayDays), timeZone).start),
  }
}

/** Closed managed days whose actual Google or Meta amount has not reached the usage outbox. */
export async function unrecordedAdSpendDays(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
  now = new Date(),
  reportingDelayDays: 1 | 2 = 1,
  providers: readonly AdsProvider[] = ADS_PROVIDERS,
): Promise<string[]> {
  instantDate(now)
  const missing: string[] = []
  let periods: ManagedPeriod[] | undefined
  for (const provider of providers) {
    const ads = await readAdsConnection(db, organizationId, provider)
    if (!ads) continue
    periods ??= await readManagedPeriods(db, organizationId)
    if (!periods.length) break
    const plan = await managedSpendPlan(db, env, organizationId, ads, periods, now, reportingDelayDays)
    if (plan) missing.push(...plan.days)
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
  const targetProvider: AdsProvider = product === 'meta-ads' ? 'meta_ads' : 'google_ads'
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
): Promise<void> {
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
}

/** Capture the closed day from its provider into the existing payments meter outbox. */
async function recordReportingDay(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
  account: ReportingAccount,
  date: string,
): Promise<void> {
  const { provider, targetId, accessToken, timeZone } = account
  const occurredAt = new Date(Date.parse(localDateBounds(date, timeZone).end) - 1).toISOString()
  let amount: number
  if (provider === 'meta_ads') {
    const summary = await getMetaAdsPerformanceSummary(accessToken, targetId, date, date)
    if (!account.currency) throw new Error(`Meta Ads account ${targetId} has no currency configured`)
    if (account.currency !== 'USD') throw new Error(`Meta Ads account ${targetId} spends in ${account.currency}; the ad-spend fee is billed in USD only`)
    amount = summary.costCents
  } else {
    const summary = await getGoogleAdsPerformanceSummary(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, targetId, date, date)
    if (!Number.isSafeInteger(summary.costMicros) || summary.costMicros < 0) throw new Error('Google Ads spend must be a nonnegative integer number of micros')
    const currency = summary.currencyCode || account.currency
    if (currency !== 'USD') throw new Error(`Google Ads account ${targetId} spends in ${currency}; the ad-spend fee is billed in USD only`)
    // Google counts in millionths of a dollar; the fee is priced in cents.
    amount = Math.round(summary.costMicros / 10_000)
  }
  await persistAdSpendReceipt(db, organizationId, `${provider}:${targetId}:${date}`, amount, occurredAt, date, provider === 'meta_ads' ? 'Meta Ads' : 'Google Ads')
}

/** Capture all eligible days for this business, then wake at its next reporting deadline. */
export async function runScheduledManagedAdSpend(env: CloudflareEnv, organizationId: string, nowMs: number): Promise<{ next: number | null }> {
  const now = instantDate(new Date(nowMs))
  const periods = await readManagedPeriods(env.DB, organizationId)
  let next: number | null = null
  if (periods.length) {
    for (const provider of ADS_PROVIDERS) {
      const ads = await readAdsConnection(env.DB, organizationId, provider)
      if (!ads) continue
      const plan = await managedSpendPlan(env.DB, env, organizationId, ads, periods, now, REPORTING_DELAY_DAYS)
      if (!plan) continue
      for (const day of plan.days) await recordReportingDay(env.DB, env, organizationId, plan.account, day)
      if (plan.next !== null && (next === null || plan.next < next)) next = plan.next
    }
  }

  const pending = await queryFirst<{ pending: number }>(env.DB, `SELECT 1 AS pending FROM usage_events
    WHERE organization_id=? AND resource='ad_spend' AND provider_occurred_at IS NOT NULL AND delivery_at IS NULL LIMIT 1`, [organizationId])
  if (pending) await deliverPaymentsUsage(env.DB, env, organizationId)
  return { next }
}

export function publishManagedAdSpendWake(env: EventsEnv, organizationId: string): Promise<void> {
  return publishEvent(env, { type: 'business.wake', organization_id: organizationId, kind: 'ad_spend', due_at: Date.now() })
}

/** One cutover event adopts previously connected agreements and pending meter delivery. */
export async function enqueueOutstandingManagedAdSpend(env: CloudflareEnv): Promise<void> {
  const organizations = await queryAll<{ organization_id: string }>(env.DB, `
    SELECT s.organization_id
      FROM organization_services s JOIN organization_integrations i
        ON i.organization_id=s.organization_id AND i.provider IN ('google_ads', 'meta_ads') AND i.status IS NOT 'setting_up'
     WHERE s.service='managed_ads' AND (s.ended_at IS NULL OR s.ended_at > i.created_at)
    UNION
    SELECT organization_id FROM usage_events WHERE resource='ad_spend' AND provider_occurred_at IS NOT NULL AND delivery_at IS NULL`)
  for (const row of organizations) await publishManagedAdSpendWake(env, row.organization_id)
}
