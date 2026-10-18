import {HTTPError} from 'nitro'
import {execute, queryAll, queryFirst, type DbClient} from '~/server/db'
import type {CloudflareEnv} from '~/server/utils/auth'
import {linkedAccountAccessToken} from '~/server/utils/auth'
import {getGoogleAdsCustomer, getGoogleAdsPerformanceSummary} from '~/server/utils/google-ads'
import {readIntegration} from '~/server/utils/organization-integrations'
import { addLocalDays, assertCalendarDate, instantDate } from '~/utils/timezone'
import { listServices } from '~/server/utils/organization-services'

/** Closed managed days whose actual Google amount has not reached the usage outbox. */
export async function unrecordedAdSpendDays(db: DbClient, organizationId: string, throughDate: string): Promise<string[]> {
 assertCalendarDate(throughDate)
 const ads = await readIntegration(db, organizationId, 'google_ads')
 if (!ads) return []
 const connectedAt = instantDate(ads.created_at).toISOString()
 const periods = await queryAll<{ agreed_at: string; ended_at: string | null }>(db, "SELECT agreed_at,ended_at FROM organization_services WHERE organization_id=? AND service='managed_ads' ORDER BY agreed_at", [organizationId])
 const intervals = periods.map(period => ({ start: instantDate(period.agreed_at).toISOString(), end: period.ended_at === null ? null : instantDate(period.ended_at).toISOString() }))
 if (!intervals.length) return []
 const recorded = new Set((await queryAll<{ source_id: string }>(db, "SELECT source_id FROM payment_usage_events WHERE organization_id=? AND kind='ad_spend' AND source_id LIKE ?", [organizationId, `google_ads:${ads.target_id}:%`])).map(row => row.source_id))
 const missing: string[] = []
 // An agreement predating a connection still applies to its overlapping days.
 // Never charge before either consent or the current connection existed.
 const start = [intervals.map(period => period.start).sort()[0]!, connectedAt].sort().at(-1)!.slice(0, 10)
 for (let date = start; date <= throughDate; date = addLocalDays(date, 1)) {
  const close = `${date}T23:59:59.999Z`
  if (connectedAt <= close && intervals.some(period => period.start <= close && (period.end === null || period.end > close)) && !recorded.has(`google_ads:${ads.target_id}:${date}`)) missing.push(date)
 }
 return missing
}

/** The connection is needed until Google's last managed days have been counted. */
export async function requireRecordedManagedSpend(db: DbClient, organizationId: string): Promise<void> {
 if ((await listServices(db, organizationId)).managed_ads) throw new HTTPError({ statusCode: 409, message: 'Turn off managed ads in Plan before changing Google Ads or ending Payments billing.' })
 if ((await unrecordedAdSpendDays(db, organizationId, new Date().toISOString().slice(0, 10))).length) {
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
 if(!/^\d{4}-\d{2}-\d{2}$/u.test(date))throw new Error('Ad spend date must be a calendar day')
 const ads=await readIntegration(db,organizationId,'google_ads')
 if(!ads?.account_id||!ads.target_id)throw new HTTPError({statusCode:409,statusMessage:'Google Ads is not connected'})
 const {accessToken}=await linkedAccountAccessToken(env,ads.account_id)
 const summary=await getGoogleAdsPerformanceSummary(accessToken,env.GOOGLE_ADS_DEVELOPER_TOKEN,ads.target_id,date,date)
 if(!Number.isSafeInteger(summary.costMicros)||summary.costMicros<0)throw new Error('Google Ads spend must be a nonnegative integer number of micros')
 const currency=summary.currencyCode||((await getGoogleAdsCustomer(accessToken,env.GOOGLE_ADS_DEVELOPER_TOKEN,ads.target_id)).currencyCode)
 if(currency!=='USD')throw new Error(`Google Ads account ${ads.target_id} spends in ${currency}; the ad-spend fee is billed in USD only`)
 // Google counts in millionths of a dollar; the fee is priced in cents.
 const amount=Math.round(summary.costMicros/10_000)
 const sourceId=`google_ads:${ads.target_id}:${date}`
 const existing=await queryFirst<{organization_id:string;amount:number}>(db,'SELECT organization_id,amount FROM payment_usage_events WHERE source_id=?',[sourceId])
 if(existing&&existing.organization_id!==organizationId)throw new Error('Google Ads spend receipt belongs to another organization')
 if(existing&&existing.amount!==amount)throw new Error(`Google Ads spend for ${date} changed after it was queued (${existing.amount} → ${amount} cents); reconcile before billing`)
 if(!existing)await execute(db,`INSERT INTO payment_usage_events(id,organization_id,payment_id,kind,currency,amount,source_id,provider_occurred_at,created_at) VALUES(?,?,NULL,'ad_spend','USD',?,?,?,?) ON CONFLICT(source_id) DO NOTHING`,[crypto.randomUUID(),organizationId,amount,sourceId,`${date}T23:59:59.999Z`,new Date().toISOString()])
 const recorded=await queryFirst<{organization_id:string;amount:number}>(db,'SELECT organization_id,amount FROM payment_usage_events WHERE source_id=?',[sourceId])
 if(!recorded||recorded.organization_id!==organizationId||recorded.amount!==amount)throw new Error('Google Ads spend receipt changed during capture; reconcile before billing')
 // Zero is an actual daily receipt too. Delivery and its acknowledgement are
 // owned by the existing usage outbox, never manufactured by this capture.
 return {amount}
}
