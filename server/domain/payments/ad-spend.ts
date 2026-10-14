import {HTTPError} from 'nitro'
import {execute, queryFirst, type DbClient} from '~/server/db'
import type {CloudflareEnv} from '~/server/utils/auth'
import {linkedAccountAccessToken} from '~/server/utils/auth'
import {getGoogleAdsPerformanceSummary} from '~/server/utils/google-ads'
import {readIntegration} from '~/server/utils/organization-integrations'
import {deliverPaymentsUsage} from './usage'

/**
 * The Marketing plan's usage fee: a share of what the business spent on Google
 * Ads, read from Google for one finished day and queued as an `ad_spend` usage
 * event. Metronome prices it at the rate on the Payments rate card and bills it
 * with the rest of the business's operating usage. Google reports an account in
 * its own currency; the fee is USD, so only USD accounts are billed and any
 * other currency fails here rather than being converted by guesswork.
 */
export async function recordAdSpend(db:DbClient,env:CloudflareEnv,organizationId:string,date:string):Promise<{amount:number;delivered:number}> {
 if(!/^\d{4}-\d{2}-\d{2}$/u.test(date))throw new Error('Ad spend date must be a calendar day')
 const ads=await readIntegration(db,organizationId,'google_ads')
 if(!ads?.account_id||!ads.target_id)throw new HTTPError({statusCode:409,statusMessage:'Google Ads is not connected'})
 const {accessToken}=await linkedAccountAccessToken(env,ads.account_id)
 const summary=await getGoogleAdsPerformanceSummary(accessToken,env.GOOGLE_ADS_DEVELOPER_TOKEN,ads.target_id,date,date)
 if(summary.costMicros===0)return {amount:0,delivered:0}
 if(summary.currencyCode!=='USD')throw new Error(`Google Ads account ${ads.target_id} spends in ${summary.currencyCode}; the ad-spend fee is billed in USD only`)
 // Google counts in millionths of a dollar; the fee is priced in cents.
 const amount=Math.round(summary.costMicros/10_000)
 const sourceId=`google_ads:${ads.target_id}:${date}`
 const existing=await queryFirst<{amount:number}>(db,'SELECT amount FROM payment_usage_events WHERE source_id=?',[sourceId])
 if(existing&&existing.amount!==amount)throw new Error(`Google Ads spend for ${date} changed after it was queued (${existing.amount} → ${amount} cents); reconcile before billing`)
 if(!existing)await execute(db,`INSERT INTO payment_usage_events(id,organization_id,payment_id,kind,currency,amount,source_id,provider_occurred_at,created_at) VALUES(?,?,NULL,'ad_spend','USD',?,?,?,?)`,[crypto.randomUUID(),organizationId,amount,sourceId,`${date}T23:59:59.999Z`,new Date().toISOString()])
 const {delivered}=await deliverPaymentsUsage(db,env,organizationId)
 return {amount,delivered}
}
