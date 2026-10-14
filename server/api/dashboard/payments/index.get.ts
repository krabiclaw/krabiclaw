import {defineHandler,HTTPError} from 'nitro'
import {getQuery} from 'nitro/h3'
import {getDashboardContext} from '~/server/utils/dashboard-context'
import {jsonResponse} from '~/server/utils/api-response'
import {listPayments,paymentSummary,paymentPayouts,readPaymentDetails,authorizePayments} from '~/server/domain/payments'
import {connectedStripe,paymentPayoutDetail,paymentPerformance,paymentTransactions,payoutItems} from '~/server/domain/payments/earnings'
import {queryAll,queryFirst} from '~/server/db'
export default defineHandler(async event=>{
 const {db,env,organization,userId}=await getDashboardContext(event,{})
 const principal={organizationId:organization.id,userId,role:organization.role}
 const query=getQuery(event),now=new Date(),from=typeof query.from==='string'?query.from:new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString(),to=typeof query.to==='string'?query.to:now.toISOString()
 await authorizePayments(principal,'read')
 if(query.after!==undefined&&(typeof query.after!=='string'||!query.after))throw new HTTPError({statusCode:400,statusMessage:'Valid page cursor is required'})
 const after=typeof query.after==='string'?query.after:undefined
 if(typeof query.payment_id==='string'){
  return jsonResponse(await readPaymentDetails(db,organization.id,query.payment_id))
 }
 if(query.view==='payouts'){
  const result=await paymentPayouts(db,env,principal,after)
  // The Earnings page draws the last paid payouts with what they carried; the full list does not need it.
  if(query.with_items==='1'&&result.configured){
   const {stripe,options}=await connectedStripe(db,env,organization.id)
   const paid=result.payouts.filter(row=>row.status==='paid').slice(0,3)
   const items=await Promise.all(paid.map(row=>payoutItems(db,stripe,options,organization.id,row.id)))
   return jsonResponse({...result,items:Object.fromEntries(paid.map((row,index)=>[row.id,items[index]]))})
  }
  return jsonResponse(result)
 }
 if(query.view==='payout'){
  if(typeof query.payout_id!=='string'||!query.payout_id)throw new HTTPError({statusCode:400,statusMessage:'Payout is required'})
  return jsonResponse(await paymentPayoutDetail(db,env,principal,query.payout_id))
 }
 if(query.view==='performance'){
  const year=Number(query.year??now.getUTCFullYear()),month=typeof query.month==='string'?query.month:`${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}`
  return jsonResponse(await paymentPerformance(db,principal,year,month))
 }
 if(query.view==='transactions')return jsonResponse(await paymentTransactions(db,principal,organization.slug,await listPayments(db,principal,{from,to,after,location_id:typeof query.location_id==='string'&&query.location_id?query.location_id:undefined,earnings_type:query.earnings_type==='paid'||query.earnings_type==='refunded'?query.earnings_type:undefined})))
 if(query.view==='refunds' || query.view==='disputes'){
  if(query.view==='disputes') await authorizePayments(principal,'disputes')
  const table=query.view==='refunds'?'payment_refunds':'payment_disputes'
  const cursor=after?await queryFirst<{id:string;updated_at:string}>(db,`SELECT r.id,r.updated_at FROM ${table} r JOIN payments p ON p.id=r.payment_id WHERE p.organization_id=? AND r.id=?`,[organization.id,after]):null
  if(after&&!cursor)throw new HTTPError({statusCode:404,statusMessage:'Financial page cursor not found'})
  const rows=await queryAll<{id:string}>(db,`SELECT r.*,p.currency,p.subject_type,p.subject_id FROM ${table} r JOIN payments p ON p.id=r.payment_id WHERE p.organization_id=?${cursor?' AND (r.updated_at<? OR (r.updated_at=? AND r.id<?))':''} ORDER BY r.updated_at DESC,r.id DESC LIMIT 101`,[organization.id,...(cursor?[cursor.updated_at,cursor.updated_at,cursor.id]:[])])
  return jsonResponse({rows:rows.slice(0,100),next_cursor:rows.length>100?rows[99]!.id:null,source:'Stripe authenticated projections',refreshed_at:new Date().toISOString()})
 }
 // The business's own currency, which is what a period with nothing earned yet is stated in.
 return jsonResponse({summary:await paymentSummary(db,principal,from,to),currency:organization.default_currency,...await listPayments(db,principal,{from,to,after})})
})
