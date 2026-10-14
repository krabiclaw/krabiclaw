import {isCurrencyCode} from './currencies'
import {formatMinorAmount} from './prices'
import type {CurrencyCode} from './currencies'

export interface PaymentDisplay {
 id:string
 currency:CurrencyCode
 captured_amount:number
 refunded_amount:number
 state:string
 receipt_url:string|null
}
export interface PaymentRefundDisplay {id:string;amount:number|null;status:string;note:string|null}
export interface PaymentOrderDisplay {
 lines:Array<{id:string;title:string;quantity:number;unit_amount:number;currency:CurrencyCode}>
}
export function paymentDisplay(value:unknown):PaymentDisplay {
 if(!value||typeof value!=='object'||!('id' in value)||typeof value.id!=='string'||!('currency' in value)||!isCurrencyCode(value.currency)||!('captured_amount' in value)||typeof value.captured_amount!=='number'||!Number.isSafeInteger(value.captured_amount)||value.captured_amount<0||!('refunded_amount' in value)||typeof value.refunded_amount!=='number'||!Number.isSafeInteger(value.refunded_amount)||value.refunded_amount<0||!('state' in value)||typeof value.state!=='string'||!('receipt_url' in value)||(value.receipt_url!==null&&typeof value.receipt_url!=='string'))throw new Error('Invalid payment detail')
 if(value.refunded_amount>value.captured_amount||!['pending','captured','failed','recovery','refunded'].includes(value.state))throw new Error('Invalid payment state')
 return {id:value.id,currency:value.currency,captured_amount:value.captured_amount,refunded_amount:value.refunded_amount,state:value.state,receipt_url:value.receipt_url}
}
export function paymentRefundsDisplay(value:unknown):PaymentRefundDisplay[] {
 if(!Array.isArray(value))throw new Error('Invalid payment refunds')
 return value.map((refund:unknown)=>{
  if(!refund||typeof refund!=='object'||!('id' in refund)||typeof refund.id!=='string'||!('amount' in refund)||!(refund.amount===null||(typeof refund.amount==='number'&&Number.isSafeInteger(refund.amount)&&refund.amount>0))||!('status' in refund)||typeof refund.status!=='string')throw new Error('Invalid payment refund')
  if(!['queued','creating','pending','requires_action','succeeded','failed','canceled'].includes(refund.status))throw new Error('Invalid payment refund state')
  return {id:refund.id,amount:refund.amount as number|null,status:refund.status,note:'note' in refund&&typeof refund.note==='string'?refund.note:null}
 })
}
export function paymentOrderDisplay(value:unknown):PaymentOrderDisplay|null {
 if(value===null)return null
 if(!value||typeof value!=='object'||!('lines' in value)||!Array.isArray(value.lines))throw new Error('Invalid payment order')
 if(!value.lines.length)throw new Error('Payment order has no items')
 return {lines:value.lines.map((line:unknown)=>{
  if(!line||typeof line!=='object'||!('id' in line)||typeof line.id!=='string'||!('title' in line)||typeof line.title!=='string'||!('quantity' in line)||typeof line.quantity!=='number'||!Number.isSafeInteger(line.quantity)||line.quantity<1||!('unit_amount' in line)||typeof line.unit_amount!=='number'||!Number.isSafeInteger(line.unit_amount)||line.unit_amount<0||!('currency' in line)||!isCurrencyCode(line.currency))throw new Error('Invalid payment order line')
  if(!Number.isSafeInteger(line.quantity*line.unit_amount))throw new Error('Invalid order line total')
  return {id:line.id,title:line.title,quantity:line.quantity,unit_amount:line.unit_amount,currency:line.currency}
 })}
}
/** One catalog currency formatter for payment principal and fee projections. */
export function paymentMoney(amount:unknown,currency:unknown):string {
 if(typeof amount!=='number'||!Number.isSafeInteger(amount)||!isCurrencyCode(currency))throw new Error('Invalid currency-safe payment amount')
 const value=amount
 return `${value<0?'-':''}${formatMinorAmount(Math.abs(value),currency)}`
}
/** What a reader is told about a payment, in the words the booking screen uses; one place for both the business and the buyer. */
export function paymentStateLabel(payment:Pick<PaymentDisplay,'captured_amount'|'refunded_amount'|'state'>):string {
 if(payment.captured_amount>0){
  if(payment.refunded_amount===payment.captured_amount)return 'Refunded'
  if(payment.refunded_amount>0)return 'Partially refunded'
  return 'Paid'
 }
 return payment.state==='failed'?'Failed':payment.state==='recovery'?'Needs attention':'Pending'
}
