import {isCurrencyCode} from './currencies'
import {paymentMoney} from './payment-display'

/** What `/api/dashboard/payments` answers for a period with no `view`: the summary the Menu's Earnings card shows. */
export interface EarningsAmount { currency:string; captured_amount:number; refunded_amount:number; disputed_amount:number }
export interface EarningsSummary { summary:{ amounts:EarningsAmount[]; refreshed_at:string }; currency:string }
export function isEarningsSummary(value:unknown):value is EarningsSummary {
 if(!value||typeof value!=='object'||!('summary' in value)||!value.summary||typeof value.summary!=='object')return false
 const summary=value.summary as Record<string,unknown>
 return isCurrencyCode((value as Record<string,unknown>).currency)&&typeof summary.refreshed_at==='string'&&Array.isArray(summary.amounts)&&summary.amounts.every((row:unknown)=>!!row&&typeof row==='object'&&isCurrencyCode((row as Record<string,unknown>).currency)&&['captured_amount','refunded_amount','disputed_amount'].every(field=>Number.isSafeInteger((row as Record<string,unknown>)[field])))
}
/** Money kept this period — paid less refunded — per currency, as Airbnb's "Total for October". */
export function earningsPaid(summary:EarningsSummary|null|undefined):Array<{currency:string;amount:number}> {
 return (summary?.summary.amounts??[]).map(row=>({currency:row.currency,amount:row.captured_amount-row.refunded_amount}))
}
/** The one figure a card shows: what was earned, or nothing yet in the currency the business sells in. */
export function earningsFigure(summary:EarningsSummary):string {
 const paid=earningsPaid(summary)
 return paid.length?paid.map(row=>paymentMoney(row.amount,row.currency)).join(' · '):paymentMoney(0,summary.currency)
}

/** What `view=performance` answers: the year by month and one month by what was sold. */
export interface EarningsPerformance {
 currency:string
 months:Array<{month:string;paid:number;refunded:number}>
 items:Array<{title:string;imageUrl:string|null;paid:number;count:number}>
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
export function isEarningsPerformance(value:unknown):value is EarningsPerformance {
 return record(value)&&isCurrencyCode(value.currency)
  &&Array.isArray(value.months)&&value.months.length===12&&value.months.every(row=>record(row)&&typeof row.month==='string'&&/^\d{4}-\d{2}$/.test(row.month)&&Number.isSafeInteger(row.paid)&&Number.isSafeInteger(row.refunded))
  &&Array.isArray(value.items)&&value.items.every(row=>record(row)&&typeof row.title==='string'&&(row.imageUrl===null||typeof row.imageUrl==='string')&&Number.isSafeInteger(row.paid)&&Number.isSafeInteger(row.count))
}

/** One payment a payout carried, or one line of the transactions list. */
export interface PayoutItem { paymentId:string; title:string; imageUrl:string|null; amount:number; currency:string; startsAt:string|null; endsAt:string|null; timeZone:string|null; subjectTitle:string|null }
export function isPayoutItem(value:unknown):value is PayoutItem {
 return record(value)&&typeof value.paymentId==='string'&&typeof value.title==='string'&&(value.imageUrl===null||typeof value.imageUrl==='string')&&Number.isSafeInteger(value.amount)&&isCurrencyCode(value.currency)
  &&[value.startsAt,value.endsAt,value.timeZone,value.subjectTitle].every(field=>field===null||typeof field==='string')
}
export interface PayoutDetail { id:string; amount:number; currency:string; status:string; arrivalDate:number; bank:{bankName:string|null;last4:string}|null; items:PayoutItem[] }
export function isPayoutDetail(value:unknown):value is PayoutDetail {
 return record(value)&&typeof value.id==='string'&&Number.isSafeInteger(value.amount)&&isCurrencyCode(value.currency)&&typeof value.status==='string'&&Number.isSafeInteger(value.arrivalDate)
  &&(value.bank===null||(record(value.bank)&&(value.bank.bankName===null||typeof value.bank.bankName==='string')&&typeof value.bank.last4==='string'))
  &&Array.isArray(value.items)&&value.items.every(isPayoutItem)
}
/** Stripe's payout list rows, as the Earnings and Paid screens read them. */
export interface PayoutRow { id:string; amount:number; currency:string; status:string; arrival_date:number }
export interface PayoutsView { configured:boolean; balance?:{available:Array<{amount:number;currency:string}>;pending:Array<{amount:number;currency:string}>}; payouts:PayoutRow[]; next_cursor:string|null; items?:Record<string,PayoutItem[]> }
const moneyRow=(value:unknown)=>record(value)&&Number.isSafeInteger(value.amount)&&typeof value.currency==='string'&&isCurrencyCode(value.currency.toUpperCase())
export function isPayoutsView(value:unknown):value is PayoutsView {
 return record(value)&&typeof value.configured==='boolean'&&Array.isArray(value.payouts)&&(value.next_cursor===null||(typeof value.next_cursor==='string'&&!!value.next_cursor))
  &&(value.configured===false||(record(value.balance)&&Array.isArray(value.balance.available)&&value.balance.available.every(moneyRow)&&Array.isArray(value.balance.pending)&&value.balance.pending.every(moneyRow)
   &&value.payouts.every(row=>moneyRow(row)&&typeof row.id==='string'&&typeof row.status==='string'&&Number.isSafeInteger(row.arrival_date))))
  &&(value.items===undefined||(record(value.items)&&Object.values(value.items).every(list=>Array.isArray(list)&&list.every(isPayoutItem))))
}
export function payoutStatusLabel(status:string):string {
 return status==='paid'?'Sent':status==='failed'?'Failed':status==='canceled'?'Cancelled':status==='in_transit'?'On its way':'Expected'
}
export function payoutDate(seconds:number,options:Intl.DateTimeFormatOptions={month:'short',day:'numeric',year:'numeric'}):string {
 return new Date(seconds*1000).toLocaleDateString('en',{timeZone:'UTC',...options})
}

/** One line of the business's transactions list. */
export interface TransactionRow { id:string; created_at:string; currency:string; amount:number; captured_amount:number; refunded_amount:number; state:string; title:string; image_url:string|null; buyer_name:string|null; starts_at:string|null; ends_at:string|null; timezone:string|null; to:string }
export function isTransactionsView(value:unknown):value is {payments:TransactionRow[];next_cursor:string|null} {
 return record(value)&&(value.next_cursor===null||typeof value.next_cursor==='string')&&Array.isArray(value.payments)&&value.payments.every(row=>record(row)&&typeof row.id==='string'&&typeof row.created_at==='string'&&isCurrencyCode(row.currency)
  &&['amount','captured_amount','refunded_amount'].every(field=>Number.isSafeInteger(row[field]))&&typeof row.state==='string'&&typeof row.title==='string'&&typeof row.to==='string'
  &&[row.image_url,row.buyer_name,row.starts_at,row.ends_at,row.timezone].every(field=>field===null||typeof field==='string'))
}
/** Rows to a CSV file the browser saves, as Airbnb's "Export CSV". */
export function downloadCsv(filename:string,header:string[],rows:Array<Array<string|number>>):void {
 // A buyer writes their own name, so text a spreadsheet would run as a formula is kept as text.
 const escape=(cell:string|number)=>`"${(typeof cell==='string'&&/^[=+\-@\t\r]/.test(cell)&&!/^-\d+(?:\.\d+)?$/.test(cell)?`'${cell}`:String(cell)).replace(/"/g,'""')}"`
 const text=[header,...rows].map(row=>row.map(escape).join(',')).join('\n')
 const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}))
 const link=document.createElement('a'); link.href=url; link.download=filename; link.click(); URL.revokeObjectURL(url)
}
