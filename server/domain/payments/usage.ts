import type Stripe from 'stripe'
import {HTTPError} from 'nitro'
import {execute,queryAll,queryFirst,type DbClient} from '~/server/db'
import {getOrganizationBillingStatus,getStripe,hasOrganizationEntitlement} from '~/server/utils/billing'
import type {CloudflareEnv} from '~/server/utils/auth'
import type {CurrencyCode} from '~/shared/currencies'
import type {FinancialPrincipal} from './index'
import {validatePaymentsRateCard} from './rate-card'
import {tokenHash} from './buyer'
import {describeErrorForTelemetry} from '~/shared/error-telemetry'
import {stripeLivemodeFromKey} from '~/server/utils/stripe-connect'
import {recordPaymentsVolumeBilled} from '~/server/domain/booking-analytics'
import { readPaymentsBillingBasis } from './fx'

export function metronomeCurrencyAmount(minor:number,currency:CurrencyCode):string {
 if(currency!=='USD')throw new Error('Payments usage billing requires USD cents')
 if(!Number.isSafeInteger(minor)) throw new Error('Metronome requires exact integer minor units')
 return String(minor)
}
export async function metronomeRequest(env:CloudflareEnv,path:string,body?:unknown,key?:string):Promise<Record<string,unknown>> {
 if(!env.METRONOME_API_KEY) throw new HTTPError({statusCode:503,statusMessage:'Metronome is not configured'})
 const response=await fetch(`https://api.metronome.com${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${env.METRONOME_API_KEY}`,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)})
 const raw=await response.text()
 let result:unknown
 try {result=raw.trim()?JSON.parse(raw):null} catch {
  throw new HTTPError({statusCode:502,statusMessage:`Metronome response is invalid (${response.status})`,data:{provider_status:response.status}})
 }
 if(!response.ok) {
  const message=result&&typeof result==='object'&&!Array.isArray(result)&&'message' in result&&typeof result.message==='string'
   ?describeErrorForTelemetry(new Error(result.message.replaceAll(env.METRONOME_API_KEY,'[key redacted]').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email redacted]')),500):''
  throw new HTTPError({statusCode:502,statusMessage:`Metronome request failed (${response.status})${message?`: ${message}`:''}`,data:{provider_status:response.status}})
 }
 if(path==='/v1/ingest'&&!raw.trim())return {}
 if(path==='/v1/ingest'&&result===null)return {}
 if(!result || typeof result!=='object' || Array.isArray(result)) throw new Error('Metronome response is invalid')
 return result as Record<string,unknown>
}
export interface BillingAccount {organization_id:string;stripe_billing_customer_id:string;metronome_customer_id:string|null;metronome_contract_id:string|null;contract_start_at:string;currency:string;status:string;updated_at:string}
/** Native contract and collection authority, shared by acceptance and servicing. */
export async function getPaymentsBillingContract(env:CloudflareEnv,account:BillingAccount):Promise<Record<string,unknown>> {
 if(!account.metronome_customer_id||!account.metronome_contract_id)throw new HTTPError({statusCode:409,statusMessage:'Payments usage billing is not configured'})
 if(account.currency!=='USD')throw new Error('Payments usage billing requires a USD-cent contract')
 const native=(await metronomeRequest(env,'/v2/contracts/get',{customer_id:account.metronome_customer_id,contract_id:account.metronome_contract_id})).data as Record<string,unknown>|undefined
 if(!native||native.id!==account.metronome_contract_id||native.customer_id!==account.metronome_customer_id||native.uniqueness_key!==`payments:${account.organization_id}`||native.archived_at||native.rate_card_id!==env.METRONOME_RATE_CARD_ID||typeof native.starting_at!=='string'||Date.parse(native.starting_at)!==Date.parse(account.contract_start_at))throw new Error('Native Payments contract does not match its billing mapping')
 if(native.ending_before!==undefined&&native.ending_before!==null&&(typeof native.ending_before!=='string'||!Number.isFinite(Date.parse(native.ending_before))))throw new Error('Native Payments contract end date is invalid')
 let cursor:string|null=null
 for(let page=0;page<100;page++){
  const listed=await metronomeRequest(env,'/v2/contracts/list',{customer_id:account.metronome_customer_id,limit:20,...(cursor?{cursor}:{})})
  if(!Array.isArray(listed.data))throw new Error('Native Metronome contract list is invalid')
  for(const value of listed.data){
   if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Native Metronome contract shape is invalid')
   const other=value as Record<string,unknown>
   if(other.id===native.id||other.archived_at)continue
   const start=typeof other.starting_at==='string'?Date.parse(other.starting_at):NaN,end=other.ending_before===undefined||other.ending_before===null?Infinity:typeof other.ending_before==='string'?Date.parse(other.ending_before):NaN
   if(!Number.isFinite(start)||Number.isNaN(end)||start>=end)throw new Error('Native Metronome contract period is invalid')
   if(start<(typeof native.ending_before==='string'?Date.parse(native.ending_before):Infinity)&&Date.parse(native.starting_at)<end)throw new Error('Payments requires an exclusive native usage contract; overlapping contracts would rate the same usage')
  }
  cursor=typeof listed.cursor==='string'?listed.cursor:null
  if(!cursor)break
  if(page===99)throw new Error('Native Payments contract history requires bounded operator review')
 }
 const collection=native.customer_billing_provider_configuration as Record<string,unknown>|undefined,configuration=collection?.configuration as Record<string,unknown>|undefined,delivery=collection?.delivery_method_configuration as Record<string,unknown>|undefined
 const platform=await getStripe(env).accounts.retrieveCurrent()
 if(!collection||collection.archived_at||collection.customer_id!==account.metronome_customer_id||collection.billing_provider!=='stripe'||collection.delivery_method!=='direct_to_billing_provider'||configuration?.stripe_customer_id!==account.stripe_billing_customer_id||configuration.stripe_collection_method!=='charge_automatically'||delivery?.stripe_account_id!==platform.id)throw new Error('Native Payments collection requires automatic invoices for its operating Stripe customer and platform')
 return native
}
function providerId(result:Record<string,unknown>):string {
 const data=result.data
 if(!data || typeof data!=='object' || !('id' in data) || typeof data.id!=='string') throw new Error('Metronome provider identity missing')
 return data.id
}
/**
 * Payments fees are billed by a Metronome contract on the business's own Stripe
 * customer. A business gets it when its plan includes Payments: on the Stripe
 * subscription event that grants it. Stripe redelivers that event until set-up succeeds.
 */
export async function setUpPaymentsBilling(db:DbClient,stripe:Stripe,env:CloudflareEnv,organizationId:string) {
 const existing=await queryFirst<BillingAccount>(db,'SELECT * FROM payment_billing_accounts WHERE organization_id=?',[organizationId])
 if(existing?.status==='active'&&existing.metronome_contract_id)return existing
 if(!env.METRONOME_RATE_CARD_ID) throw new HTTPError({statusCode:503,statusMessage:'Payments USD Metronome rate card must be configured'})
 await validatePaymentsRateCard(env)
 const billing=await getOrganizationBillingStatus(env,db,organizationId)
 if(!billing.stripeCustomerId) throw new HTTPError({statusCode:409,statusMessage:'Tenant operating billing customer is required'})
 const customer=await stripe.customers.retrieve(billing.stripeCustomerId)
 if(customer.deleted)throw new Error('The business’s Stripe customer was deleted')
 if(!customer.invoice_settings.default_payment_method){
  // Fees are charged to the card the plan is paid with; Checkout keeps it on the subscription, Metronome reads the customer's default.
  const subscription=billing.stripeSubscriptionId?await stripe.subscriptions.retrieve(billing.stripeSubscriptionId):null
  const card=typeof subscription?.default_payment_method==='string'?subscription.default_payment_method:subscription?.default_payment_method?.id
  if(!card)throw new HTTPError({statusCode:409,statusMessage:'The business has no card to bill Payments fees to'})
  await stripe.customers.update(billing.stripeCustomerId,{invoice_settings:{default_payment_method:card}})
 }
 const nativePlatform=await stripe.accounts.retrieveCurrent()
 const deliveries:Record<string,unknown>[]=[]
 let deliveryCursor:string|null=null
 for(let page=0;page<100;page++){
  const listed=await metronomeRequest(env,'/v1/listConfiguredBillingProviders',{...(deliveryCursor?{next_page:deliveryCursor}:{})})
  if(!Array.isArray(listed.data))throw new Error('Native Metronome billing providers are invalid')
  for(const value of listed.data){
   if(!value||typeof value!=='object')throw new Error('Native Metronome billing provider shape invalid')
   const row=value as Record<string,unknown>,configuration=row.delivery_method_configuration as Record<string,unknown>|undefined
   if(row.billing_provider==='stripe'&&row.delivery_method==='direct_to_billing_provider'&&configuration?.stripe_account_id===nativePlatform.id)deliveries.push(row)
  }
  deliveryCursor=typeof listed.next_page==='string'?listed.next_page:null
  if(!deliveryCursor)break
  if(page===99)throw new Error('Native Metronome billing providers require bounded operator review')
 }
 if(deliveries.length!==1||typeof deliveries[0]!.delivery_method_id!=='string')throw new Error('A unique Metronome delivery connection for this Stripe platform is required')
 const deliveryMethodId=deliveries[0]!.delivery_method_id
 // Metronome requires contract starts on a UTC hour boundary.
 const start=new Date();start.setUTCMinutes(0,0,0)
 const now=existing?.contract_start_at??start.toISOString()
 await execute(db,`INSERT INTO payment_billing_accounts(organization_id,stripe_billing_customer_id,currency,status,contract_start_at,updated_at) VALUES(?,?,'USD','provisioning',?,?) ON CONFLICT(organization_id) DO NOTHING`,[organizationId,billing.stripeCustomerId,now,now])
 const reserved=await queryFirst<BillingAccount>(db,'SELECT * FROM payment_billing_accounts WHERE organization_id=?',[organizationId])
 if(!reserved||reserved.stripe_billing_customer_id!==billing.stripeCustomerId)throw new Error('Operating customer changed during Payments billing setup; resolve native billing mapping')
 const known=reserved.metronome_customer_id?null:await metronomeRequest(env,`/v1/customers?ingest_alias=${encodeURIComponent(`payments:${organizationId}`)}`)
 if(known&&!Array.isArray(known.data))throw new HTTPError({statusCode:502,statusMessage:'Metronome customer list is invalid; billing setup stopped'})
 const knownRows=known?known.data as unknown[]:[]
 if(knownRows.length>1)throw new Error('Payments Metronome ingest alias is ambiguous')
 const knownId=knownRows.length?providerId({data:knownRows[0]}):null
 const metronomeCustomer=reserved.metronome_customer_id??knownId??providerId(await metronomeRequest(env,'/v1/customers',{name:`Payments ${organizationId}`,ingest_aliases:[`payments:${organizationId}`],customer_billing_provider_configurations:[{billing_provider:'stripe',configuration:{stripe_customer_id:billing.stripeCustomerId,stripe_collection_method:'charge_automatically'},delivery_method_id:deliveryMethodId}]},`payments-customer:${organizationId}`))
 const customerWrite=await execute(db,"UPDATE payment_billing_accounts SET metronome_customer_id=?,updated_at=CASE WHEN status='closing' THEN updated_at ELSE ? END WHERE organization_id=? AND (metronome_customer_id IS NULL OR metronome_customer_id=?)",[metronomeCustomer,new Date().toISOString(),organizationId,metronomeCustomer])
 if(customerWrite.meta.changes!==1)throw new Error('Payments customer mapping changed during native setup')
 const configurations=await metronomeRequest(env,'/v1/getCustomerBillingProviderConfigurations',{customer_id:metronomeCustomer})
 if(!Array.isArray(configurations.data))throw new Error('Native Metronome collection configurations are invalid')
 const matchingConfigurations=configurations.data.filter(value=>{
  if(!value||typeof value!=='object')return false
  const row=value as Record<string,unknown>,config=row.configuration as Record<string,unknown>|undefined,delivery=row.delivery_method_configuration as Record<string,unknown>|undefined
  return !row.archived_at&&row.billing_provider==='stripe'&&row.customer_id===metronomeCustomer&&row.delivery_method_id===deliveryMethodId&&row.delivery_method==='direct_to_billing_provider'&&config?.stripe_customer_id===billing.stripeCustomerId&&config?.stripe_collection_method==='charge_automatically'&&delivery?.stripe_account_id===nativePlatform.id
 }) as Record<string,unknown>[]
 if(matchingConfigurations.length!==1||typeof matchingConfigurations[0]!.id!=='string')throw new Error('A unique operating Stripe customer collection mapping in this platform account is required')
 const billingConfigurationId=matchingConfigurations[0]!.id
 let contract:string|null=null,cursor:string|null=null,attachConfiguration=false
 const others:Record<string,unknown>[]=[]
 for(let page=0;page<100;page++){
  const listed=await metronomeRequest(env,'/v2/contracts/list',{customer_id:metronomeCustomer,include_archived:true,limit:20,...(cursor?{cursor}:{})})
  if(!Array.isArray(listed.data))throw new Error('Native Metronome contract list is invalid')
  for(const value of listed.data){
   if(!value||typeof value!=='object')throw new Error('Native Metronome contract shape invalid')
   const row=value as Record<string,unknown>
   if(row.uniqueness_key!==`payments:${organizationId}`){if(!row.archived_at)others.push(row);continue}
   if(contract||row.archived_at||row.rate_card_id!==env.METRONOME_RATE_CARD_ID||typeof row.starting_at!=='string'||Date.parse(row.starting_at)!==Date.parse(reserved.contract_start_at))throw new Error('Existing native Payments contract conflicts with immutable setup')
   if(reserved.metronome_contract_id&&reserved.metronome_contract_id!==row.id)throw new Error('Persisted Payments contract conflicts with native setup')
   const configuration=row.customer_billing_provider_configuration as Record<string,unknown>|undefined
   if(configuration&&configuration.id!==billingConfigurationId)throw new Error('Existing native Payments contract uses a different billing configuration')
   if(!configuration){
    if(!Array.isArray(row.billing_provider_configuration_schedule)||row.billing_provider_configuration_schedule.length)throw new Error('Existing native Payments contract has an unresolved billing configuration schedule')
    attachConfiguration=true
   }
   contract=providerId({data:row})
  }
  cursor=typeof listed.cursor==='string'?listed.cursor:null
  if(!cursor)break
  if(page===99)throw new Error('Native Payments contracts require bounded operator review')
 }
 if(reserved.metronome_contract_id&&!contract)throw new Error('Persisted Payments contract is missing from native setup')
 if(attachConfiguration)await metronomeRequest(env,'/v2/contracts/edit',{customer_id:metronomeCustomer,contract_id:contract,uniqueness_key:`payments-collection:${organizationId}:${billingConfigurationId}`,add_billing_provider_configuration_update:{billing_provider_configuration:{billing_provider_configuration_id:billingConfigurationId},schedule:{effective_at:'START_OF_CURRENT_PERIOD'}}})
 contract??=providerId(await metronomeRequest(env,'/v1/contracts/create',{customer_id:metronomeCustomer,rate_card_id:env.METRONOME_RATE_CARD_ID,starting_at:reserved.contract_start_at,uniqueness_key:`payments:${organizationId}`,billing_provider_configuration:{billing_provider_configuration_id:billingConfigurationId}},`payments-contract:${organizationId}`))
 const verifiedContract=await getPaymentsBillingContract(env,{...reserved,metronome_customer_id:metronomeCustomer,metronome_contract_id:contract})
 const verifiedConfiguration=verifiedContract?.customer_billing_provider_configuration as Record<string,unknown>|undefined
 if(verifiedContract?.id!==contract||verifiedConfiguration?.id!==billingConfigurationId)throw new Error('Native Payments contract collection mapping was not applied')
 if(typeof verifiedContract.ending_before==='string'){
  // A business back on a plan with Payments: its one contract is reopened, as updateEndDate without an end does natively.
  // Reopened, it runs open-ended, so no other live contract of this customer may end after it starts.
  const start=Date.parse(String(verifiedContract.starting_at))
  if(others.some(other=>other.ending_before===undefined||other.ending_before===null||Date.parse(String(other.ending_before))>start))throw new Error('Reopening the Payments contract would overlap another Metronome contract of this customer')
  await metronomeRequest(env,'/v1/contracts/updateEndDate',{customer_id:metronomeCustomer,contract_id:contract},`payments-reopen:${contract}:${Date.parse(verifiedContract.ending_before)}`)
  if((await getPaymentsBillingContract(env,{...reserved,metronome_customer_id:metronomeCustomer,metronome_contract_id:contract})).ending_before)throw new Error('Native Payments contract did not reopen')
 }
 const contractWrite=await execute(db,"UPDATE payment_billing_accounts SET metronome_contract_id=?,status='active',updated_at=? WHERE organization_id=? AND metronome_customer_id=? AND (metronome_contract_id IS NULL OR metronome_contract_id=?)",[contract,new Date().toISOString(),organizationId,metronomeCustomer,contract])
 if(contractWrite.meta.changes!==1)throw new Error('Payments contract mapping changed during native setup')
 return await queryFirst<BillingAccount>(db,'SELECT * FROM payment_billing_accounts WHERE organization_id=?',[organizationId])
}
/** Better Auth Stripe records the subscription; when it now includes Payments, its fees billing is set up. A throw makes Stripe redeliver. */
export async function setUpPaymentsBillingForSubscriptionEvent(db:DbClient,stripe:Stripe,env:CloudflareEnv,event:Stripe.Event) {
 if(event.account||!['checkout.session.completed','customer.subscription.created','customer.subscription.updated'].includes(event.type))return
 const object=event.data.object as Stripe.Subscription|Stripe.Checkout.Session
 if(object.object==='checkout.session'&&object.mode!=='subscription')return
 const customerId=typeof object.customer==='string'?object.customer:object.customer?.id
 if(!customerId)return
 const organizations=await queryAll<{id:string}>(db,'SELECT id FROM organization WHERE "stripeCustomerId"=?',[customerId])
 if(organizations.length>1)throw new Error('Stripe customer belongs to more than one organization')
 if(organizations[0]&&await hasOrganizationEntitlement(env,organizations[0].id,'payments'))await setUpPaymentsBilling(db,stripe,env,organizations[0].id)
}
export async function paymentsBillingPricing(db:DbClient,env:CloudflareEnv,organizationId:string) {
 const account=await queryFirst<BillingAccount>(db,'SELECT * FROM payment_billing_accounts WHERE organization_id=?',[organizationId])
 if(!account?.metronome_customer_id||!account.metronome_contract_id)return {account,contract:null,pricing:null}
 const contract=await getPaymentsBillingContract(env,account)
 const at=new Date().toISOString()
 const pricing=Date.parse(String(contract.starting_at))<=Date.parse(at)&&(typeof contract.ending_before!=='string'||Date.parse(contract.ending_before)>Date.parse(at))
  ?{...await validatePaymentsRateCard(env,at,{customer_id:account.metronome_customer_id,contract_id:account.metronome_contract_id}),livemode:stripeLivemodeFromKey(env.STRIPE_SECRET_KEY!)}:null
 return {account,contract,pricing}
}
export async function paymentsUsageStatus(db:DbClient,env:CloudflareEnv,organizationId:string) {
 const {account,contract:native,pricing}=await paymentsBillingPricing(db,env,organizationId)
 const pending=await queryAll<{currency:string;kind:string;event_count:number;amount:number;billing_amount:number;invalid_basis:number;error:string|null}>(db,`SELECT currency,kind,COUNT(*) AS event_count,SUM(amount) AS amount,
  SUM(CASE WHEN billing_basis_json IS NULL AND currency='USD' THEN amount ELSE json_extract(billing_basis_json,'$.amount') END) AS billing_amount,
  SUM(CASE WHEN billing_basis_json IS NULL THEN currency<>'USD' ELSE
   COALESCE(json_extract(billing_basis_json,'$.currency')<>'USD'
    OR json_extract(billing_basis_json,'$.source_currency')<>currency
    OR json_extract(billing_basis_json,'$.source_amount')<>amount
    OR json_type(billing_basis_json,'$.amount')<>'integer',1) END) AS invalid_basis,
  MAX(error) AS error FROM payment_usage_events WHERE organization_id=? AND delivery_at IS NULL GROUP BY currency,kind`,[organizationId])
 if(pending.some(row=>row.invalid_basis!==0||!Number.isSafeInteger(row.billing_amount)))throw new Error('Accrued Payments usage is missing its native currency billing receipt')
 if(!account?.metronome_customer_id||!account.metronome_contract_id||!native)return {configured:false,account:null,pending,pricing:null,invoices:[],credits:[],source:'Metronome configuration missing; durable accrued events retained',refreshed_at:null}
 const stripe=getStripe(env)
 const invoices=await metronomeInvoices(env,account.metronome_customer_id,account.metronome_contract_id)
 const negative=await queryAll<{id:string;source_id:string;kind:string;currency:string;amount:number;provider_occurred_at:string;error:string|null;billing_basis_json:string|null}>(db,"SELECT id,source_id,kind,currency,amount,provider_occurred_at,error,billing_basis_json FROM payment_usage_events WHERE organization_id=? AND kind IN ('stripe_cost','stripe_cost_adjustment') AND amount<0 AND delivery_at IS NULL AND billing_timestamp IS NULL",[organizationId])
 const credits=negative.map(event=>{
  const basis=readPaymentsBillingBasis(event.billing_basis_json,event.amount,event.currency)
  return {id:event.id,source_id:event.source_id,kind:event.kind,currency:basis.currency,amount:basis.amount,source_currency:event.currency,source_amount:event.amount,fx_quote_id:basis.fx_quote?.id??null,provider_occurred_at:event.provider_occurred_at,error:event.error}
 }).filter(event=>usageBillingDecision(event,invoices,undefined,account.contract_start_at).requiresCredit)
 const collected=[]
 for(const invoice of invoices){
  let collection_invoice=null
  const external=invoice.external_invoice as Record<string,unknown>|undefined|null
  if(external){
   if(external.billing_provider_type!=='stripe'||typeof external.invoice_id!=='string')throw new Error('Metronome invoice collection identity is invalid')
   const collection=await stripe.invoices.retrieve(external.invoice_id)
   const customerId=typeof collection.customer==='string'?collection.customer:collection.customer?.id
   if(collection.id!==external.invoice_id||customerId!==account.stripe_billing_customer_id||collection.metadata?.metronome_id!==invoice.id||collection.livemode!==stripeLivemodeFromKey(env.STRIPE_SECRET_KEY!))throw new Error('Stripe invoice collection does not match the Payments customer and Metronome invoice')
   collection_invoice={id:collection.id,status:collection.status,currency:collection.currency.toUpperCase(),total:collection.total,amount_due:collection.amount_due,amount_paid:collection.amount_paid,amount_remaining:collection.amount_remaining,hosted_invoice_url:collection.hosted_invoice_url,invoice_pdf:collection.invoice_pdf}
  }
  collected.push({...invoice,id:invoice.id,collection_invoice})
 }
 const status=typeof native.ending_before==='string'?(Date.parse(native.ending_before)<=Date.now()?'closed':'closing'):['closed','closing'].includes(account.status)?'servicing':account.status
 return {configured:true,pending,pricing,account:{...account,status},invoices:collected,credits,source:'Metronome',refreshed_at:new Date().toISOString()}
}
export async function deliverPaymentsUsage(db:DbClient,env:CloudflareEnv,organizationId:string) {
 const events=await queryAll<{id:string;payment_id:string|null;kind:string;currency:CurrencyCode;amount:number;source_id:string;provider_occurred_at:string;created_at:string;billing_timestamp:string|null;billing_basis_json:string|null}>(db,`SELECT * FROM payment_usage_events WHERE organization_id=? AND delivery_at IS NULL AND dead_letter_at IS NULL ORDER BY created_at`,[organizationId])
 if(!events.length)return {delivered:0}
 const account=await queryFirst<BillingAccount>(db,'SELECT * FROM payment_billing_accounts WHERE organization_id=?',[organizationId])
 if(!account?.metronome_customer_id||!account.metronome_contract_id) throw new Error('Payments billing mapping missing; accrued usage remains undelivered')
 const native=await getPaymentsBillingContract(env,account)
 const invoices=await metronomeInvoices(env,account.metronome_customer_id,account.metronome_contract_id)
 const pricedEvents=events.map(event=>{
  const basis=readPaymentsBillingBasis(event.billing_basis_json,event.amount,event.currency)
  if(basis.currency!==account.currency)throw new Error('Payments billing basis does not match its native contract')
  return {event,basis}
 })
 if(typeof native.ending_before==='string'&&Date.parse(native.ending_before)<=Date.now()&&pricedEvents.some(({event,basis})=>!usageBillingDecision({...event,amount:basis.amount},invoices,undefined,account.contract_start_at).requiresCredit)){
  // updateEndDate without ending_before is the native documented reopening path.
  // Only historical accrued events reach this path; it grants no new acceptance.
  await metronomeRequest(env,'/v1/contracts/updateEndDate',{customer_id:account.metronome_customer_id,contract_id:account.metronome_contract_id},`payments-servicing:${account.metronome_contract_id}:${events[0]!.id}`)
  const reopened=await getPaymentsBillingContract(env,account)
  if(reopened.ending_before)throw new Error('Native Payments contract did not reopen for historical usage')
  await execute(db,"UPDATE payment_billing_accounts SET status='servicing',updated_at=? WHERE organization_id=?",[new Date().toISOString(),organizationId])
 }
 let delivered=0
 for(const {event,basis} of pricedEvents){
  const billingEvent = { ...event, amount: basis.amount }
  const decision=usageBillingDecision(billingEvent,invoices,undefined,account.contract_start_at)
  if(event.billing_timestamp && usageBillingDecision({...billingEvent,provider_occurred_at:event.billing_timestamp},invoices,undefined,account.contract_start_at).adjustment){
   await execute(db,'UPDATE payment_usage_events SET error=?,dead_letter_at=? WHERE id=?',['Previously attempted usage period has closed; reconcile native acceptance before retiming this event',new Date().toISOString(),event.id]);continue
  }
  if(decision.requiresCredit){await execute(db,'UPDATE payment_usage_events SET error=?,dead_letter_at=? WHERE id=?',['Closed-period actual-cost credit requires native Stripe credit memo settlement; retained for owner servicing',new Date().toISOString(),event.id]);continue}
  const timestamp=event.billing_timestamp ?? decision.timestamp
  await execute(db,'UPDATE payment_usage_events SET billing_timestamp=COALESCE(billing_timestamp,?) WHERE id=?',[timestamp,event.id])
  if(Date.now()-Date.parse(timestamp)>34*86400000){
   await execute(db,'UPDATE payment_usage_events SET error=?,dead_letter_at=? WHERE id=?',['Metronome idempotency window exceeded; reconcile provider acceptance before retry',new Date().toISOString(),event.id])
   continue
  }
  try {
   await metronomeRequest(env,'/v1/ingest',[{transaction_id:`payments:${await tokenHash(event.source_id)}`,customer_id:account.metronome_customer_id,timestamp,event_type:`payments_${event.kind}`,properties:{amount_minor:String(event.amount),source_currency:event.currency,currency:basis.currency,pricing_amount:metronomeCurrencyAmount(basis.amount,basis.currency),...(basis.fx_quote?{fx_quote_id:basis.fx_quote.id}:{}),provider_occurred_at:event.provider_occurred_at,payment_source:event.source_id,billing_adjustment:decision.adjustment?'closed_period_roll_forward':'original_period'}}])
   if(event.kind==='captured_volume'){if(!event.payment_id)throw new Error(`Captured volume ${event.id} has no payment`);await recordPaymentsVolumeBilled(db,{organizationId,paymentId:event.payment_id,volumeMinor:basis.amount,currency:basis.currency})}
   await execute(db,'UPDATE payment_usage_events SET delivery_at=?,error=NULL WHERE id=?',[new Date().toISOString(),event.id]);delivered++
  }catch(error){
   const status=error instanceof HTTPError?error.data?.provider_status:undefined
   await execute(db,'UPDATE payment_usage_events SET error=?,dead_letter_at=? WHERE id=?',[error instanceof Error?error.message:String(error),typeof status==='number' && status>=400 && status<500 && status!==429?new Date().toISOString():null,event.id])
   throw error
  }
 }
 return {delivered}
}

/** Provider invoice boundaries, not an application-invented grace period. */
export async function metronomeInvoices(env:CloudflareEnv,customerId:string,contractId:string):Promise<Record<string,unknown>[]> {
 const rows:Record<string,unknown>[]=[];let cursor:string|null=null
 for(let page=0;page<100;page++){
  const result=await metronomeRequest(env,`/v1/customers/${encodeURIComponent(customerId)}/invoices?limit=100&contract_id=${encodeURIComponent(contractId)}${cursor?`&next_page=${encodeURIComponent(cursor)}`:''}`)
  if(!Array.isArray(result.data))throw new Error('Metronome invoice list is invalid')
  for(const invoice of result.data){
   if(!invoice||typeof invoice!=='object'||Array.isArray(invoice)||typeof invoice.id!=='string'||!invoice.id||invoice.contract_id!==contractId||invoice.customer_id!==customerId)throw new Error('Metronome invoice does not match the configured Payments contract')
   const credit=invoice.credit_type as Record<string,unknown>|undefined
   if(credit?.name!=='USD (cents)'||typeof credit.id!=='string'||typeof invoice.total!=='number'||!Number.isFinite(invoice.total))throw new Error('Metronome Payments invoice must contain its native USD-cent amount')
   rows.push(invoice as Record<string,unknown>)
  }
  cursor=typeof result.next_page==='string'?result.next_page:null
  if(!cursor)return rows
 }
 throw new Error('Metronome invoice history exceeded bounded pagination; reconciliation requires operator review')
}
export function usageBillingDecision(event:{kind:string;amount:number;provider_occurred_at:string},invoices:Record<string,unknown>[],now=new Date().toISOString(),contractStartAt?:string):{timestamp:string;adjustment:boolean;requiresCredit:boolean} {
 const original=Date.parse(event.provider_occurred_at)
 if(!Number.isFinite(original)||!Number.isFinite(Date.parse(now)))throw new Error('Usage source timestamp invalid')
 if(contractStartAt!==undefined&&!Number.isFinite(Date.parse(contractStartAt)))throw new Error('Usage contract start timestamp invalid')
 const periods=invoices.filter(invoice=>{
  if(invoice.type!=='USAGE')return false
  const start=typeof invoice.start_timestamp==='string'?Date.parse(invoice.start_timestamp):NaN,end=typeof invoice.end_timestamp==='string'?Date.parse(invoice.end_timestamp):NaN
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||!['DRAFT','FINALIZED','VOID'].includes(String(invoice.status)))throw new Error('Metronome usage invoice period is invalid')
  return start<=original&&original<end
 })
 const current=periods.filter(invoice=>invoice.status!=='VOID')
 if(current.length>1)throw new Error('Metronome usage invoice period is ambiguous')
 const period=current[0]??periods[0]
 const old=Date.parse(now)-original>34*86400000
 const closed=period && period.status!=='DRAFT'
 const beforeStart=contractStartAt!==undefined&&original<Date.parse(contractStartAt)
 return {timestamp:!old&&!closed&&!beforeStart?event.provider_occurred_at:now,adjustment:Boolean(old||closed||beforeStart),requiresCredit:event.amount<0&&Boolean(old||closed||beforeStart)}
}
/** Negative closed-period/final credits are settled in native Stripe A/R, never dropped by a zero-floor metric. */
export async function reconcileNativeBillingCredit(db:DbClient,stripe:Stripe,env:CloudflareEnv,principal:FinancialPrincipal,eventId:string,creditNoteId:string) {
 const {assertRoleAllows}=await import('~/server/utils/member-access')
 await assertRoleAllows({organizationId:principal.organizationId,role:principal.role,permissions:{billing:['update']}})
 const account=await queryFirst<BillingAccount>(db,'SELECT * FROM payment_billing_accounts WHERE organization_id=?',[principal.organizationId])
 const event=await queryFirst<{id:string;kind:string;amount:number;currency:string;provider_occurred_at:string;delivery_at:string|null;credit_note_id:string|null;billing_timestamp:string|null;billing_basis_json:string|null}>(db,"SELECT * FROM payment_usage_events WHERE id=? AND organization_id=? AND kind IN ('stripe_cost','stripe_cost_adjustment') AND amount<0",[eventId,principal.organizationId])
 if(!account||!event)throw new HTTPError({statusCode:404,statusMessage:'Unsettled actual-cost credit not found'})
 if(event.delivery_at&&event.credit_note_id!==creditNoteId)throw new HTTPError({statusCode:409,statusMessage:'Cost credit has already been delivered'})
 if(event.billing_timestamp)throw new HTTPError({statusCode:409,statusMessage:'Reconcile native usage acceptance before settling a previously attempted cost credit'})
 await getPaymentsBillingContract(env,account)
 const invoices=await metronomeInvoices(env,account.metronome_customer_id!,account.metronome_contract_id!)
 const basis = readPaymentsBillingBasis(event.billing_basis_json, event.amount, event.currency)
 if(!usageBillingDecision({...event,amount:basis.amount},invoices,undefined,account.contract_start_at).requiresCredit)throw new HTTPError({statusCode:409,statusMessage:'This cost credit is still eligible for native usage delivery'})
 const note=await stripe.creditNotes.retrieve(creditNoteId)
 const invoiceId=typeof note.invoice==='string'?note.invoice:note.invoice.id
 const invoice=await stripe.invoices.retrieve(invoiceId)
 const customerId=typeof invoice.customer==='string'?invoice.customer:invoice.customer?.id
 if(customerId!==account.stripe_billing_customer_id||note.status!=='issued'||note.currency.toUpperCase()!==basis.currency||note.total_excluding_tax!==-basis.amount||note.livemode!==invoice.livemode)throw new HTTPError({statusCode:409,statusMessage:'Native billing credit does not match this tenant’s attributable credit'})
 if(event.credit_note_id===note.id)return {settled:true,credit_note_id:note.id,source:'Stripe native credit note'}
 const result=await execute(db,'UPDATE payment_usage_events SET credit_note_id=?,delivery_at=?,error=NULL WHERE id=? AND organization_id=? AND delivery_at IS NULL AND billing_timestamp IS NULL',[note.id,new Date().toISOString(),event.id,principal.organizationId])
 if(result.meta.changes!==1)throw new HTTPError({statusCode:409,statusMessage:'Credit settled concurrently'})
 return {settled:true,credit_note_id:note.id,source:'Stripe native credit note'}
}

/** Explicit native end; never archive/void accrued invoices. Late costs reopen servicing. */
export async function finalizePaymentsBilling(db:DbClient,env:CloudflareEnv,principal:FinancialPrincipal){
 const {assertRoleAllows}=await import('~/server/utils/member-access')
 await assertRoleAllows({organizationId:principal.organizationId,role:principal.role,permissions:{billing:['update']}})
 const account=await queryFirst<BillingAccount>(db,'SELECT * FROM payment_billing_accounts WHERE organization_id=?',[principal.organizationId])
 if(!account?.metronome_customer_id||!account.metronome_contract_id)throw new HTTPError({statusCode:409,statusMessage:'Native Payments usage contract is not configured'})
 if(account.status==='closed'){
  const native=await getPaymentsBillingContract(env,account)
  if(typeof native.ending_before!=='string')throw new Error('Native Payments contract is open; the persisted end request does not match')
  return {closed:true,ended_at:native.ending_before,source:'Metronome native contract end; finalized invoices remain collectible'}
 }
 if(!['servicing','closing'].includes(account.status))throw new HTTPError({statusCode:409,statusMessage:'Only a Payments contract in historical servicing can be ended'})
 const now=new Date().toISOString(),requestedAt=account.status==='closing'?account.updated_at:now
 // Native ends require an hour boundary; round up so accrued usage is never truncated.
 const end=new Date(Math.ceil(Date.parse(requestedAt)/3600000)*3600000).toISOString()
 const result=await execute(db,`UPDATE payment_billing_accounts SET status='closing',updated_at=? WHERE organization_id=? AND status IN ('servicing','closing') AND NOT EXISTS(SELECT 1 FROM payment_usage_events WHERE organization_id=? AND delivery_at IS NULL) AND NOT EXISTS(SELECT 1 FROM payment_checkout_holds WHERE organization_id=? AND status='active' AND expires_at>?) AND NOT EXISTS(SELECT 1 FROM payment_refunds r JOIN payments p ON p.id=r.payment_id WHERE p.organization_id=? AND r.status IN ('queued','creating','pending','requires_action'))`,[requestedAt,principal.organizationId,principal.organizationId,principal.organizationId,now,principal.organizationId])
 if(result.meta.changes!==1)throw new HTTPError({statusCode:409,statusMessage:'Deliver accrued usage and complete outstanding checkout/refund servicing before ending the contract'})
 await metronomeRequest(env,'/v1/contracts/updateEndDate',{customer_id:account.metronome_customer_id,contract_id:account.metronome_contract_id,ending_before:end,allow_ending_before_finalized_invoice:false},`payments-end:${account.metronome_contract_id}:${end}`)
 const native=await getPaymentsBillingContract(env,account)
 if(typeof native.ending_before!=='string'||Date.parse(native.ending_before)!==Date.parse(end))throw new Error('Native Payments contract end was not applied')
 const closed=await execute(db,"UPDATE payment_billing_accounts SET status='closed' WHERE organization_id=? AND status='closing' AND updated_at=?",[principal.organizationId,requestedAt])
 if(closed.meta.changes!==1)throw new HTTPError({statusCode:409,statusMessage:'Payments contract servicing changed during the end request'})
 return {closed:true,ended_at:end,source:'Metronome native contract end; finalized invoices remain collectible'}
}
