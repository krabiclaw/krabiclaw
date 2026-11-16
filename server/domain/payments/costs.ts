import type Stripe from 'stripe'
import {execute,executeBatch,queryAll,queryFirst,type DbClient} from '~/server/db'
import {currencyFractionDigits,isCurrencyCode} from '~/shared/currencies'
import { paymentsBillingBasis, paymentsCostBillingBasis, quotePaymentsBillingFx, readPaymentsBillingBasis } from './fx'
import type {CloudflareEnv} from '~/server/utils/auth'
import {stripeLivemodeFromKey} from '~/server/utils/stripe-connect'
import {deliverPaymentsUsage,paymentUsageEventQuery} from './usage'

const REPORT_SCALE=18n
/** Exact provider decimal at Stripe's own 18-decimal scale; the report itemizes fees below a minor unit. */
export function stripeFeeScaled(value:string):bigint {
 const match=/^(-?)(\d+)(?:\.(\d{1,18}))?$/u.exec(value)
 if(!match) throw new Error('Stripe fee amount must be an exact decimal')
 const scaled=BigInt(match[2]!)*10n**REPORT_SCALE+BigInt((match[3]??'').padEnd(Number(REPORT_SCALE),'0'))
 return match[1]? -scaled:scaled
}
/** A fee identity's exact total in minor units, rounded half away from zero once; never binary floating point or FX. */
export function stripeFeeMinor(scaled:bigint,currency:string):number {
 if(!isCurrencyCode(currency)) throw new Error(`Unsupported report currency ${currency}`)
 const unit=10n**(REPORT_SCALE-BigInt(currencyFractionDigits(currency)))
 const magnitude=scaled<0n?-scaled:scaled
 const result=Number((scaled<0n?-1n:1n)*((magnitude+unit/2n)/unit))
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
/**
 * Native platform report only. An unresolved attribution is durable and never charged.
 *
 * `fee_transaction_id` is the fee transaction that deducts the fee from the
 * balance; Stripe leaves it blank when the fee is netted inside the charge's own
 * balance transaction, which is every card processing fee. Such rows are
 * identified by what incurred them, and the rows sharing an identity are summed.
 */
export async function ingestStripeFeeReport(db:DbClient,livemode:boolean,csv:string,stripe?:Stripe) {
 const scaled=new Map<string,{incurred_by:string;currency:string;scaled:bigint;incurred_at:string}>()
 for(const row of feeReportRows(csv)){
  const currency=row.currency!.toUpperCase(),source=`stripe-fee:${Number(livemode)}:${row.fee_transaction_id}:${row.incurred_by}:${currency}`
  if(!isCurrencyCode(currency)) throw new Error(`Unsupported report currency ${currency}`)
  const timestamp = row.incurred_at!
  const incurredAt=new Date(/[Zz]|[+-]\d{2}:?\d{2}$/u.test(timestamp) ? timestamp : timestamp.replace(' ', 'T')+'Z').toISOString()
  const previous=scaled.get(source)
  scaled.set(source,{incurred_by:row.incurred_by!,currency,scaled:stripeFeeScaled(row.amount!)+stripeFeeScaled(row.tax||'0')+(previous?.scaled??0n),incurred_at:previous?.incurred_at??incurredAt})
 }
 const grouped=new Map([...scaled].map(([source,row])=>[source,{incurred_by:row.incurred_by,currency:row.currency,amount:stripeFeeMinor(row.scaled,row.currency),incurred_at:row.incurred_at}]))
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
  // A replayed report still bills whatever this tenant has accrued but not delivered.
  if(tenant)organizations.add(tenant)
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
   ...(tenant && delta !== 0 ? [paymentUsageEventQuery({
     organizationId: tenant, paymentId: payment?.id, kind: old?.organization_id ? 'stripe_cost_adjustment' : 'stripe_cost',
     currency: row.currency, amount: delta, billingBasis: usageBasis, sourceId: `${source}:revision:${revision}`,
     occurredAt: row.incurred_at, createdAt: now,
   }, { query: 'SELECT 1 FROM payment_cost_snapshots WHERE source_id=? AND revision=? AND amount=?', params: [source, revision, row.amount] })] : []),
  ],{operation:'Reconcile native attributable Stripe costs'})
  if (results[0]?.meta.changes !== 1) throw new Error('Stripe cost was revised concurrently; reconcile the current native receipt before processing this report')
  if(tenant)attributed++;else unattributed++
 }
 return {attributed,unattributed,organizations}
}
const STRIPE_FEE_REPORT_TYPE = 'all_fees.balance_transaction_created.itemized.2'
const FEE_REPORT_LOOKBACK = 35 * 86_400

function stripeFeeReportId(intervalEnd: number) {
 return `fees:1:${intervalEnd}`
}

/** Request the data Stripe just made available, including the lookback for late fee corrections. */
async function requestStripeFeeReport(db: DbClient, stripe: Stripe, reportType: Stripe.Reporting.ReportType) {
 const end = reportType.data_available_end - 1
 const start = Math.max(end - FEE_REPORT_LOOKBACK, reportType.data_available_start + 1)
 if (start >= end) return

 const id = stripeFeeReportId(end)
 const existing = await queryFirst<{ status: string }>(db, 'SELECT status FROM payment_fee_reports WHERE id=?', [id])
 if (existing && existing.status !== 'creating' && existing.status !== 'failed') return

 const now = new Date().toISOString()
 if (!existing) {
  await execute(db, "INSERT INTO payment_fee_reports(id,livemode,interval_start,interval_end,status,created_at,updated_at) VALUES(?,1,?,?,'creating',?,?) ON CONFLICT(id) DO NOTHING", [id, start, end, now, now])
 }
 let run: Stripe.Reporting.ReportRun
 try {
  run = await stripe.reporting.reportRuns.create({
   report_type: STRIPE_FEE_REPORT_TYPE,
   parameters: {
    interval_start: start,
    interval_end: end,
    timezone: 'Etc/UTC',
    columns: ['fee_transaction_id', 'incurred_by', 'currency', 'amount', 'tax', 'incurred_at'],
   },
  }, { idempotencyKey: id })
 } catch (error) {
  await execute(db, "UPDATE payment_fee_reports SET status='failed',error=?,updated_at=? WHERE id=? AND stripe_report_id IS NULL", [error instanceof Error ? error.message : String(error), now, id])
  throw error
 }
 await execute(db, `UPDATE payment_fee_reports SET stripe_report_id=?,status='pending',error=NULL,updated_at=?
   WHERE id=? AND status IN ('creating','failed') AND stripe_report_id IS NOT ?`, [run.id, now, id, run.id])
}

/** Stripe publishes report availability and the outcome of requested runs to the platform webhook. */
export async function ingestStripeFeeReportEvent(db: DbClient, stripe: Stripe, env: CloudflareEnv, event: Stripe.Event) {
 if (event.account) return
 if (event.type === 'reporting.report_type.updated') {
  const reportType = event.data.object
  // Stripe's itemized fee data is live only.
  if (reportType.id !== STRIPE_FEE_REPORT_TYPE || !event.livemode) return
  if (!reportType.livemode || !stripeLivemodeFromKey(env.STRIPE_SECRET_KEY!)) throw new Error('Stripe fee report type mode mismatch')
  await requestStripeFeeReport(db, stripe, reportType)
  return
 }
 if (event.type !== 'reporting.report_run.succeeded' && event.type !== 'reporting.report_run.failed') return
 const run = event.data.object
 if (run.report_type !== STRIPE_FEE_REPORT_TYPE) return
 const intervalEnd = run.parameters.interval_end
 const requestId = intervalEnd === undefined ? null : stripeFeeReportId(intervalEnd)
 const report = await queryFirst<{ id: string; livemode: number; status: string; stripe_report_id: string | null }>(db, `
   SELECT id, livemode, status, stripe_report_id FROM payment_fee_reports
   WHERE stripe_report_id=? OR (id=? AND livemode=1 AND stripe_report_id IS NULL)`, [run.id, requestId])
 if (!report || report.status === 'processed') return
 // A run can finish before the availability webhook saves Stripe's run ID.
 if (report.stripe_report_id === null) throw new Error(`Stripe fee report ${run.id} has not been linked to request ${report.id}`)
 const livemode=Boolean(report.livemode),now=new Date().toISOString()
 if(run.livemode!==livemode||event.livemode!==livemode||livemode!==stripeLivemodeFromKey(env.STRIPE_SECRET_KEY!))throw new Error('Stripe fee report mode mismatch')
 if(run.status==='failed'){await execute(db,"UPDATE payment_fee_reports SET status='failed',error=?,updated_at=? WHERE id=?",[run.error??'Stripe report failed',now,report.id]);throw new Error(`Stripe fee report ${run.id} failed: ${run.error??'No provider reason returned'}`)}
 if(run.status!=='succeeded'||!run.result?.url)throw new Error(`Stripe fee report ${run.id} event carries no result`)
 const url=new URL(run.result.url)
 if(url.protocol!=='https:' || (url.hostname!=='files.stripe.com' && url.hostname!=='api.stripe.com')) throw new Error('Unexpected native Stripe report file origin')
 // Workers refuses redirect:'error'; 'manual' leaves a redirect unfollowed, and it fails the ok check below.
 const response=await fetch(url,{headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`},redirect:'manual'})
 if(!response.ok) throw new Error(`Stripe fee report download failed (${response.status})`)
 const {organizations}=await ingestStripeFeeReport(db,livemode,await response.text(),stripe)
 for(const organizationId of organizations)await deliverPaymentsUsage(db,env,organizationId)
 await execute(db,"UPDATE payment_fee_reports SET status='processed',error=NULL,updated_at=? WHERE id=?",[now,report.id])
}
