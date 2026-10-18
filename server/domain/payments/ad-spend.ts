import {HTTPError} from 'nitro'
import {execute, queryAll, queryFirst, type DbClient} from '~/server/db'
import type {CloudflareEnv} from '~/server/utils/auth'
import {linkedAccountAccessToken} from '~/server/utils/auth'
import {getGoogleAdsCustomer, getGoogleAdsPerformanceSummary} from '~/server/utils/google-ads'
import {readIntegration} from '~/server/utils/organization-integrations'
import { addLocalDays, assertCalendarDate, instantDate, localDateAt } from '~/utils/timezone'
import { listServices } from '~/server/utils/organization-services'
import { localDateBounds } from '~/server/utils/analytics-calendar'

/** Closed managed days whose actual Google amount has not reached the usage outbox. */
export async function unrecordedAdSpendDays(db: DbClient, env: CloudflareEnv, organizationId: string, now = new Date(), reportingDelayDays: 1 | 2 = 1): Promise<string[]> {
 instantDate(now)
 const ads = await readIntegration(db, organizationId, 'google_ads')
 if (!ads) return []
 const connectedAt = instantDate(ads.created_at).toISOString()
 const periods = await queryAll<{ agreed_at: string; ended_at: string | null }>(db, "SELECT agreed_at,ended_at FROM organization_services WHERE organization_id=? AND service='managed_ads' ORDER BY agreed_at", [organizationId])
 const intervals = periods.map(period => ({ start: instantDate(period.agreed_at).toISOString(), end: period.ended_at === null ? null : instantDate(period.ended_at).toISOString() }))
 if (!intervals.some(period => period.end === null || period.end > connectedAt)) return []
 const { accessToken } = await linkedAccountAccessToken(env, ads.account_id)
 const { timeZone } = await getGoogleAdsCustomer(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, ads.target_id)
 const throughDate = addLocalDays(localDateAt(now, timeZone), -reportingDelayDays)
 const recorded = new Set((await queryAll<{ source_id: string }>(db, "SELECT source_id FROM payment_usage_events WHERE organization_id=? AND kind='ad_spend' AND source_id LIKE ?", [organizationId, `google_ads:${ads.target_id}:%`])).map(row => row.source_id))
 const missing: string[] = []
 // An agreement predating a connection still applies to its overlapping days.
 // Never charge before either consent or the current connection existed.
 const start = localDateAt(instantDate([intervals.map(period => period.start).sort()[0]!, connectedAt].sort().at(-1)!), timeZone)
 for (let date = start; date <= throughDate; date = addLocalDays(date, 1)) {
  const { end } = localDateBounds(date, timeZone)
  if (connectedAt < end && intervals.some(period => period.start < end && (period.end === null || period.end >= end)) && !recorded.has(`google_ads:${ads.target_id}:${date}`)) missing.push(date)
 }
 return missing
}

/** The connection is needed until Google's last managed days have been counted. */
export async function requireRecordedManagedSpend(db: DbClient, env: CloudflareEnv, organizationId: string): Promise<void> {
 if ((await listServices(db, organizationId)).managed_ads) throw new HTTPError({ statusCode: 409, message: 'Turn off managed ads in Plan before changing Google Ads or ending Payments billing.' })
 if ((await unrecordedAdSpendDays(db, env, organizationId)).length) {
  throw new HTTPError({ statusCode: 409, message: 'Keep Google Ads connected until your prior managed spend has been counted. We count each day after two days; contact support if it remains pending.' })
 }
}

/**
 * The managed ads service's usage fee: a share of what the business spent on Google
 * Ads, read from Google for one finished day and queued as an `ad_spend` usage
 * event. Metronome prices it at the rate on the Payments rate card and bills it
 * with the rest of the business's operating usage. Google reports an account in
 * its own currency; the fee is USD, so only USD accounts are billed and any
 * other currency fails here rather than being converted by guesswork.
 */
export async function recordAdSpend(db:DbClient,env:CloudflareEnv,organizationId:string,date:string):Promise<{amount:number}> {
 assertCalendarDate(date)
 const ads=await readIntegration(db,organizationId,'google_ads')
 if(!ads?.account_id||!ads.target_id)throw new HTTPError({statusCode:409,statusMessage:'Google Ads is not connected'})
 const {accessToken}=await linkedAccountAccessToken(env,ads.account_id)
 const customer=await getGoogleAdsCustomer(accessToken,env.GOOGLE_ADS_DEVELOPER_TOKEN,ads.target_id)
 const occurredAt=new Date(Date.parse(localDateBounds(date,customer.timeZone).end)-1).toISOString()
 const summary=await getGoogleAdsPerformanceSummary(accessToken,env.GOOGLE_ADS_DEVELOPER_TOKEN,ads.target_id,date,date)
 if(!Number.isSafeInteger(summary.costMicros)||summary.costMicros<0)throw new Error('Google Ads spend must be a nonnegative integer number of micros')
 const currency=summary.currencyCode||customer.currencyCode
 if(currency!=='USD')throw new Error(`Google Ads account ${ads.target_id} spends in ${currency}; the ad-spend fee is billed in USD only`)
 // Google counts in millionths of a dollar; the fee is priced in cents.
 const amount=Math.round(summary.costMicros/10_000)
 const sourceId=`google_ads:${ads.target_id}:${date}`
 const existing=await queryFirst<{organization_id:string;amount:number;provider_occurred_at:string}>(db,'SELECT organization_id,amount,provider_occurred_at FROM payment_usage_events WHERE source_id=?',[sourceId])
 if(existing&&existing.organization_id!==organizationId)throw new Error('Google Ads spend receipt belongs to another organization')
 if(existing&&existing.amount!==amount)throw new Error(`Google Ads spend for ${date} changed after it was queued (${existing.amount} → ${amount} cents); reconcile before billing`)
 if(existing&&existing.provider_occurred_at!==occurredAt)throw new Error('Google Ads spend receipt does not match its account reporting day; reconcile before billing')
 if(!existing)await execute(db,`INSERT INTO payment_usage_events(id,organization_id,payment_id,kind,currency,amount,source_id,provider_occurred_at,created_at) VALUES(?,?,NULL,'ad_spend','USD',?,?,?,?) ON CONFLICT(source_id) DO NOTHING`,[crypto.randomUUID(),organizationId,amount,sourceId,occurredAt,new Date().toISOString()])
 const recorded=await queryFirst<{organization_id:string;amount:number;provider_occurred_at:string}>(db,'SELECT organization_id,amount,provider_occurred_at FROM payment_usage_events WHERE source_id=?',[sourceId])
 if(!recorded||recorded.organization_id!==organizationId||recorded.amount!==amount||recorded.provider_occurred_at!==occurredAt)throw new Error('Google Ads spend receipt changed during capture; reconcile before billing')
 // Zero is an actual daily receipt too. Delivery and its acknowledgement are
 // owned by the existing usage outbox, never manufactured by this capture.
 return {amount}
}
