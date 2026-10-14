import type Stripe from 'stripe'
import {execute,executeBatch,queryAll,queryFirst,type DbClient} from '~/server/db'
import {currencyFractionDigits,isCurrencyCode} from '~/shared/currencies'
import { paymentsBillingBasis, paymentsCostBillingBasis, quotePaymentsBillingFx, readPaymentsBillingBasis } from './fx'
import type {CloudflareEnv} from '~/server/utils/auth'
import {stripeLivemodeFromKey} from '~/server/utils/stripe-connect'
import {deliverPaymentsUsage} from './usage'

/** Exact provider decimal conversion; never binary floating point or FX. */
export function stripeFeeMinor(value:string,currency:string):number {
 if(!isCurrencyCode(currency)) throw new Error(`Unsupported report currency ${currency}`)
 const digits=currencyFractionDigits(currency)
 const match=/^(-?)(\d+)(?:\.(\d+))?$/u.exec(value)
 if(!match) throw new Error('Stripe fee amount must be an exact decimal')
 const fraction=match[3]??''
 if(fraction.slice(digits).replace(/0/gu,'')) throw new Error('Stripe fee precision exceeds currency minor units')
 const integer=BigInt(match[2]!)*10n**BigInt(digits)+BigInt(fraction.slice(0,digits).padEnd(digits,'0')||'0')
 const result=Number(match[1]? -integer:integer)
 if(!Number.isSafeInteger(result)) throw new Error('Stripe cost exceeds safe minor units')
 return result
}
/** RFC 4180 parser with a bounded provider report, including embedded commas/newlines. */
export function feeReportRows(csv:string):Record<string,string>[] {
 if(csv.length>5_000_000) throw new Error('Stripe fee report exceeds bounded reconciliation size')
 const rows:string[][]=[],row:string[]=[];let cell='',quoted=false
 for(let i=0;i<csv.length;i++){
  const ch=csv[i]!
  if(ch==='"'){if(quoted&&csv[i+1]==='"'){cell+='"';i++}else quoted=!quoted}
  else if(!quoted&&(ch===','||ch==='\n')){row.push(cell.replace(/\r$/u,''));cell='';if(ch==='\n'){rows.push([...row]);row.length=0}}
  else cell+=ch
 }
 if(quoted) throw new Error('Unclosed Stripe report CSV field')
 if(cell||row.length){row.push(cell.replace(/\r$/u,''));rows.push(row)}
 const headers=rows.shift()
 if(!headers || new Set(headers).size!==headers.length || !['fee_transaction_id','incurred_by','currency','amount','tax','incurred_at'].every(h=>headers.includes(h))) throw new Error('Stripe fee report schema mismatch')
 return rows.filter(r=>r.some(Boolean)).map(r=>{if(r.length!==headers.length)throw new Error('Stripe report row width mismatch');return Object.fromEntries(headers.map((h,i)=>[h,r[i]!]))})
}
interface Snapshot {source_id:string;organization_id:string|null;payment_id:string|null;amount:number;currency:string;revision:number;billing_basis_json:string|null}
/** Native platform report only. An unresolved attribution is durable and never charged. */
export async function ingestStripeFeeReport(db:DbClient,livemode:boolean,csv:string,stripe?:Stripe) {
 const grouped=new Map<string,{incurred_by:string;currency:string;amount:number;incurred_at:string}>()
 for(const row of feeReportRows(csv)){
  const currency=row.currency!.toUpperCase(),source=`stripe-fee:${Number(livemode)}:${row.fee_transaction_id}:${row.incurred_by}:${currency}`
  if(!row.fee_transaction_id) throw new Error('Stripe fee identity is missing')
  const amount=stripeFeeMinor(row.amount!,currency)+stripeFeeMinor(row.tax||'0',currency)
  const timestamp = row.incurred_at!
  const incurredAt=new Date(/[Zz]|[+-]\d{2}:?\d{2}$/u.test(timestamp) ? timestamp : timestamp.replace(' ', 'T')+'Z').toISOString()
  const previous=grouped.get(source)
  const total = amount+(previous?.amount??0)
  if(!Number.isSafeInteger(total))throw new Error('Grouped Stripe cost exceeds safe minor units')
  grouped.set(source,{incurred_by:row.incurred_by!,currency,amount:total,incurred_at:previous?.incurred_at??incurredAt})
 }
 let attributed=0,unattributed=0;const organizations=new Set<string>()
 for(const [source,row] of grouped){
  const candidates=await queryAll<{id:string;organization_id:string}>(db,`SELECT p.id,p.organization_id FROM payments p WHERE p.livemode=? AND (p.stripe_charge_id=? OR p.stripe_payment_intent_id=? OR EXISTS(SELECT 1 FROM payment_refunds r WHERE r.payment_id=p.id AND r.stripe_refund_id=?) OR EXISTS(SELECT 1 FROM payment_disputes d WHERE d.payment_id=p.id AND d.stripe_dispute_id=?)) LIMIT 2`,[Number(livemode),row.incurred_by,row.incurred_by,row.incurred_by,row.incurred_by])
  const payment=candidates.length===1?candidates[0]:null
  const connected=!payment&&candidates.length===0?await queryAll<{organization_id:string}>(db,'SELECT organization_id FROM stripe_connected_accounts WHERE stripe_account_id=? AND livemode=? UNION SELECT organization_id FROM payment_servicing_tenants WHERE stripe_account_id=? AND livemode=? LIMIT 2',[row.incurred_by,Number(livemode),row.incurred_by,Number(livemode)]):[]
  const tenant=payment?.organization_id??(connected.length===1?connected[0]!.organization_id:null)
  const old=await queryFirst<Snapshot>(db,'SELECT * FROM payment_cost_snapshots WHERE source_id=?',[source])
  if(old && old.currency!==row.currency) throw new Error('Stripe fee currency changed for native identity')
  if(old?.organization_id&&old.organization_id!==tenant)throw new Error('Stripe fee attribution changed for an already billed native identity')
  const now=new Date().toISOString(),revision=(old?.revision??0)+1
  if(old?.amount===row.amount && (old.organization_id || !tenant)) continue
  // A previously unresolved snapshot has never produced usage.
  const delta=row.amount-(old?.organization_id?old.amount:0)
  if (!isCurrencyCode(row.currency)) throw new Error('Unsupported native fee currency')
  const oldBasis = old?.organization_id ? readPaymentsBillingBasis(old.billing_basis_json, old.amount, old.currency) : null
  let quote = oldBasis?.fx_quote ?? null
  if (tenant && row.currency !== 'USD' && !quote) {
   if (!stripe) throw new Error('Native Stripe FX quoting is required for this cost currency')
   quote = await quotePaymentsBillingFx(stripe, row.currency)
  }
  const billingBasis = tenant ? paymentsBillingBasis(row.amount, row.currency, quote) : null
  const usageBasis = tenant ? paymentsCostBillingBasis(old?.organization_id ? old.amount : 0, row.amount, row.currency, quote) : null
  const results = await executeBatch(db,[
   {query:`INSERT INTO payment_cost_snapshots(source_id,organization_id,payment_id,incurred_by,currency,amount,billing_basis_json,incurred_at,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET organization_id=excluded.organization_id,payment_id=excluded.payment_id,amount=excluded.amount,billing_basis_json=excluded.billing_basis_json,revision=excluded.revision,updated_at=excluded.updated_at WHERE payment_cost_snapshots.revision=?`,params:[source,tenant,payment?.id??null,row.incurred_by,row.currency,row.amount,billingBasis ? JSON.stringify(billingBasis) : null,row.incurred_at,revision,now,old?.revision??0]},
   ...(tenant&&delta!==0?[{query:`INSERT INTO payment_usage_events(id,organization_id,payment_id,kind,currency,amount,billing_basis_json,source_id,provider_occurred_at,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM payment_cost_snapshots WHERE source_id=? AND revision=? AND amount=?) ON CONFLICT(source_id) DO NOTHING`,params:[crypto.randomUUID(),tenant,payment?.id??null,old?.organization_id?'stripe_cost_adjustment':'stripe_cost',row.currency,delta,JSON.stringify(usageBasis),`${source}:revision:${revision}`,row.incurred_at,now,source,revision,row.amount]}]:[]),
  ],{operation:'Reconcile native attributable Stripe costs'})
  if (results[0]?.meta.changes !== 1) throw new Error('Stripe cost was revised concurrently; reconcile the current native receipt before processing this report')
  if(tenant){attributed++;organizations.add(tenant)}else unattributed++
 }
 return {attributed,unattributed,organizations}
}
/** Ask Stripe for the itemized fee report once a day; `reporting.report_run.*` events deliver it. */
export async function requestStripeFeeReport(db:DbClient,stripe:Stripe,livemode:boolean) {
 // Stripe's all_fees reports contain live data only; sandbox costs are not simulated.
 if(!livemode)return {status:'test_mode_unavailable' as const}
 const now=new Date().toISOString()
 // Reports lag at least 96 hours. Revisit the last 35 days for late fee corrections.
 const reportType=await stripe.reporting.reportTypes.retrieve('all_fees.balance_transaction_created.itemized.2')
 if(reportType.livemode!==livemode)throw new Error('Stripe report type mode mismatch')
 const end=Math.min(Math.floor(Date.now()/86400000)*86400-4*86400,reportType.data_available_end-1),start=Math.max(end-35*86400,reportType.data_available_start),id=`fees:${Number(livemode)}:${end}`
 if(start>=end)return {status:'live_mode' as const}
 // A row still `creating` (the Worker died before Stripe answered) or `failed`
 // is requested again; Stripe's idempotency key makes the repeat safe.
 const existing=await queryFirst<{status:string}>(db,'SELECT status FROM payment_fee_reports WHERE id=?',[id])
 if(existing&&existing.status!=='creating'&&existing.status!=='failed')return {status:'live_mode' as const}
 if(!existing)await execute(db,"INSERT INTO payment_fee_reports(id,livemode,interval_start,interval_end,status,created_at,updated_at) VALUES(?,?,?,?,'creating',?,?)",[id,Number(livemode),start,end,now,now])
 try{
  const report=await createFeeReport(stripe,id,start,end)
  await execute(db,"UPDATE payment_fee_reports SET stripe_report_id=?,status='pending',error=NULL,updated_at=? WHERE id=?",[report.id,now,id])
 }catch(error){await execute(db,"UPDATE payment_fee_reports SET status='failed',error=?,updated_at=? WHERE id=?",[error instanceof Error?error.message:String(error),now,id]);throw error}
 return {status:'live_mode' as const}
}

/** Stripe pushes a finished report run; a throw here returns non-2xx so Stripe redelivers it. */
export async function ingestStripeFeeReportEvent(db:DbClient,stripe:Stripe,env:CloudflareEnv,event:Stripe.Event) {
 if(event.type!=='reporting.report_run.succeeded'&&event.type!=='reporting.report_run.failed')return
 if(event.account)return
 const run=event.data.object as Stripe.Reporting.ReportRun
 const report=await queryFirst<{id:string;livemode:number;status:string}>(db,'SELECT id,livemode,status FROM payment_fee_reports WHERE stripe_report_id=?',[run.id])
 if(!report||report.status==='processed')return
 const livemode=Boolean(report.livemode),now=new Date().toISOString()
 if(run.livemode!==livemode||event.livemode!==livemode||livemode!==stripeLivemodeFromKey(env.STRIPE_SECRET_KEY!))throw new Error('Stripe fee report mode mismatch')
 if(run.status==='failed'){await execute(db,"UPDATE payment_fee_reports SET status='failed',error=?,updated_at=? WHERE id=?",[run.error??'Stripe report failed',now,report.id]);throw new Error(`Stripe fee report ${run.id} failed: ${run.error??'No provider reason returned'}`)}
 if(run.status!=='succeeded'||!run.result?.url)throw new Error(`Stripe fee report ${run.id} event carries no result`)
 const url=new URL(run.result.url)
 if(url.protocol!=='https:' || (url.hostname!=='files.stripe.com' && url.hostname!=='api.stripe.com')) throw new Error('Unexpected native Stripe report file origin')
 const response=await fetch(url,{headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`},redirect:'error',signal:AbortSignal.timeout(10000)})
 if(!response.ok) throw new Error(`Stripe fee report download failed (${response.status})`)
 const {organizations}=await ingestStripeFeeReport(db,livemode,await response.text(),stripe)
 for(const organizationId of organizations)await deliverPaymentsUsage(db,env,organizationId)
 await execute(db,"UPDATE payment_fee_reports SET status='processed',error=NULL,updated_at=? WHERE id=?",[now,report.id])
}

function createFeeReport(stripe:Stripe,id:string,start:number,end:number) {
 return stripe.reporting.reportRuns.create({report_type:'all_fees.balance_transaction_created.itemized.2',parameters:{interval_start:start,interval_end:end,timezone:'Etc/UTC',columns:['fee_transaction_id','incurred_by','currency','amount','tax','incurred_at']}},{idempotencyKey:id})
}
