import type {CloudflareEnv} from '~/server/utils/auth'
import {metronomeRequest} from './usage'
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Metronome billing configuration shape is invalid');return value as Record<string,unknown>}
/** Verify configured native billing instead of trusting a rate-card ID or name. */
export async function validatePaymentsRateCard(env:CloudflareEnv,at=new Date().toISOString(),contract?:{customer_id:string;contract_id:string}) {
 if(!env.METRONOME_RATE_CARD_ID)throw new Error('Payments Metronome rate card missing')
 const card=record((await metronomeRequest(env,'/v1/contract-pricing/rate-cards/get',{id:env.METRONOME_RATE_CARD_ID})).data)
 const credit=record(card.fiat_credit_type)
 if(credit.name!=='USD (cents)'||card.archived_at)throw new Error('Payments requires an active USD-cents native rate card')
 const result=contract
  ?await metronomeRequest(env,'/v1/contracts/getContractRateSchedule?limit=100',{...contract,at})
  :await metronomeRequest(env,'/v1/contract-pricing/rate-cards/getRates?limit=100',{rate_card_id:env.METRONOME_RATE_CARD_ID,at})
 // Captured volume and attributable Stripe cost are always priced; ad spend is priced where the Marketing plan is sold.
 if(result.next_page||!Array.isArray(result.data)||result.data.length<2||result.data.length>3)throw new Error('Payments rate card must contain the captured-volume and attributable-cost rates, and at most the ad-spend rate')
 const expected=new Set(['payments_captured_volume','payments_stripe_cost','payments_ad_spend'])
 let capturedVolumeRate:number|undefined,adSpendRate:number|null=null
 for(const value of result.data){
  const schedule=record(value),rate=record(contract?(schedule.override_rate??schedule.list_rate):schedule.rate)
  if(contract&&schedule.rate_card_id!==card.id)throw new Error('Payments contract rate card does not match its configured native card')
  if(schedule.entitled!==true||String(rate.rate_type).toUpperCase()!=='FLAT'||rate.minimum_config||rate.tiers||rate.custom_rate||schedule.commit_rate||schedule.pricing_group_values)throw new Error('Payments requires flat usage rates without minimums, commitments or pricing groups')
  const rateCredit=record(rate.credit_type)
  if(rateCredit.id!==credit.id)throw new Error('Payments rate currency units do not match USD cents')
  const product=record((await metronomeRequest(env,'/v1/contract-pricing/products/get',{id:schedule.product_id})).data),current=record(product.current)
  if(product.type!=='USAGE'||product.archived_at||current.quantity_conversion||current.quantity_rounding||current.pricing_group_key)throw new Error('Payments products must preserve exact unrounded usage quantities')
  if(typeof current.billable_metric_id!=='string')throw new Error('Payments usage product metric is missing')
  const metric=record((await metronomeRequest(env,`/v1/billable-metrics/${encodeURIComponent(current.billable_metric_id)}`)).data),filter=record(metric.event_type_filter)
  const events=Array.isArray(filter.in_values)?filter.in_values:[]
  const volume=events.length===1&&events[0]==='payments_captured_volume'
  const cost=events.length===2&&events.includes('payments_stripe_cost')&&events.includes('payments_stripe_cost_adjustment')
  const adSpend=events.length===1&&events[0]==='payments_ad_spend'
  const kind=volume?'payments_captured_volume':cost?'payments_stripe_cost':adSpend?'payments_ad_spend':null
  if(!kind||!expected.delete(kind)||metric.archived_at||metric.sql||String(metric.aggregation_type).toUpperCase()!=='SUM'||metric.aggregation_key!=='pricing_amount'||filter.not_in_values||(Array.isArray(metric.group_keys)&&metric.group_keys.length))throw new Error('Payments metric must sum exact pricing_amount for the designated native event types')
  if(typeof rate.price!=='number'||!Number.isFinite(rate.price)||rate.price<0)throw new Error('Payments requires a finite nonnegative native flat rate')
  if(cost&&rate.price!==1)throw new Error('Payments actual costs must be reimbursed at 1:1')
  if(volume)capturedVolumeRate=rate.price
  if(adSpend)adSpendRate=rate.price
  if(!Array.isArray(metric.property_filters)||!metric.property_filters.some(value=>record(value).name==='pricing_amount'&&record(value).exists===true))throw new Error('Payments aggregation property must exist')
  for(const value of metric.property_filters){const f=record(value);if(f.name==='pricing_amount'&&Object.keys(f).every(key=>['name','exists'].includes(key))&&f.exists===true)continue;if(f.name==='currency'&&f.exists===true&&Array.isArray(f.in_values)&&f.in_values.length===1&&f.in_values[0]==='USD'&&Object.keys(f).every(key=>['name','exists','in_values'].includes(key)))continue;throw new Error('Payments metric contains an unverified filter that could omit attributable usage')}
 }
 if(capturedVolumeRate===undefined||expected.has('payments_captured_volume')||expected.has('payments_stripe_cost'))throw new Error('Payments captured-volume or attributable-cost rate is missing')
 const percent=(rate:number)=>new Intl.NumberFormat('en-US',{style:'percent',useGrouping:false,maximumSignificantDigits:21}).format(rate).replace('%','')
 return {rate_card_id:card.id,currency:'USD',units:'cents',captured_volume_rate:capturedVolumeRate,captured_volume_rate_percent:percent(capturedVolumeRate),ad_spend_rate:adSpendRate,ad_spend_rate_percent:adSpendRate===null?null:percent(adSpendRate),validated_at:at}
}
