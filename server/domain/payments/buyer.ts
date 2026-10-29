import {HTTPError} from 'nitro'
import {executeBatch,queryAll,queryFirst,type DbClient} from '~/server/db'
import {REQUEST_CURRENT_BUYER_SQL} from '~/server/domain/requests'
import {loadOwnerPictures} from '~/server/notifications/hero'
import {localDateTimeToInstant} from '~/utils/timezone'
import {accountActivityPath,isAccountActivityItem,isBuyerPaymentEntry,type AccountActivityItem,type AccountActivityResponse,type BuyerPaymentEntry} from '~/shared/account-activity'

export async function ownedBuyerRequest(db:DbClient,userId:string,requestId:string) {
 const owned=await queryFirst<{organization_id:string;kind:'booking'|'reservation'|'stay'}>(db,`SELECT r.organization_id,r.kind FROM requests r WHERE r.id=? AND r.user_id=? AND ${REQUEST_CURRENT_BUYER_SQL} AND (
  (r.kind='booking' AND EXISTS(SELECT 1 FROM bookings b WHERE b.request_id=r.id)) OR
  (r.kind='reservation' AND EXISTS(SELECT 1 FROM reservations v WHERE v.request_id=r.id)) OR
  (r.kind='stay' AND EXISTS(SELECT 1 FROM stays s WHERE s.request_id=r.id AND s.organization_id=r.organization_id AND s.user_id=r.user_id)))`,[requestId,userId])
 if(!owned)throw new HTTPError({statusCode:404,statusMessage:'Owned booking not found'})
 return owned
}
type ActivityRow = {
 kind: 'booking'|'reservation'|'stay'; id:string; request_id:string|null; operational_id:string; organization_id:string;
 organization_name:string; organization_slug:string; title:string; status:string;
 starts_at:string; ends_at:string; timezone:string; created_at:string; location_id:string|null;
 location_title:string|null; product_id:string|null; party_size:number
}
type BuyerPaymentRow = {id:string;organization_id:string;organization_name:string|null;organization_slug:string|null;currency:string;captured_amount:number;subject_type:string;subject_id:string;price_snapshot_json:string;state:string;created_at:string;order_id:string|null;hold_request_id:string|null;hold_starts_at:string|null;hold_ends_at:string|null;hold_timezone:string|null}
async function buyerActivityRows(db:DbClient,userId:string) {
 const [visits,payments]=await Promise.all([
  queryAll<ActivityRow>(db,`SELECT 'booking' kind,COALESCE(r.id,b.id) id,r.id request_id,b.id operational_id,b.organization_id,o.name organization_name,o.slug organization_slug,p.name title,b.status,s.starts_at,s.ends_at,s.timezone,b.created_at,s.location_id,l.title location_title,b.product_id,b.party_size
   FROM bookings b LEFT JOIN requests r ON r.id=b.request_id JOIN organization o ON o.id=b.organization_id JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id JOIN products p ON p.id=b.product_id AND p.organization_id=b.organization_id LEFT JOIN business_locations l ON l.id=s.location_id AND l.organization_id=b.organization_id WHERE b.user_id=? AND (r.id IS NULL OR (r.organization_id=b.organization_id AND r.kind='booking' AND r.user_id=? AND ${REQUEST_CURRENT_BUYER_SQL}))
   UNION ALL SELECT 'reservation',COALESCE(r.id,v.id),r.id,v.id,v.organization_id,o.name,o.slug,l.title,v.status,v.starts_at,v.ends_at,v.timezone,v.created_at,v.location_id,l.title,NULL,v.party_size
   FROM reservations v LEFT JOIN requests r ON r.id=v.request_id JOIN organization o ON o.id=v.organization_id JOIN business_locations l ON l.id=v.location_id AND l.organization_id=v.organization_id WHERE v.user_id=? AND (r.id IS NULL OR (r.organization_id=v.organization_id AND r.kind='reservation' AND r.user_id=? AND ${REQUEST_CURRENT_BUYER_SQL}))`,[userId,userId,userId,userId]),
  queryAll<BuyerPaymentRow>(db,`SELECT p.id,p.organization_id,o.name organization_name,o.slug organization_slug,p.currency,p.captured_amount,p.subject_type,p.subject_id,p.price_snapshot_json,p.state,p.created_at,po.id order_id,r.id hold_request_id,h.starts_at hold_starts_at,h.ends_at hold_ends_at,COALESCE(s.timezone,CASE WHEN h.converted_stay_id IS NULL AND NOT (h.product_id IS NOT NULL AND h.session_id IS NULL) THEN h.timezone END) hold_timezone FROM payments p LEFT JOIN organization o ON o.id=p.organization_id LEFT JOIN payment_orders po ON po.payment_id=p.id AND po.buyer_user_id=p.buyer_user_id AND po.organization_id=p.organization_id LEFT JOIN payment_checkout_holds h ON h.payment_id=p.id AND h.organization_id=p.organization_id AND h.buyer_user_id=p.buyer_user_id LEFT JOIN requests r ON r.id=h.request_id AND r.organization_id=p.organization_id AND r.user_id=p.buyer_user_id AND ${REQUEST_CURRENT_BUYER_SQL} LEFT JOIN product_sessions s ON s.id=h.session_id AND s.organization_id=p.organization_id WHERE p.buyer_user_id=? ORDER BY p.created_at DESC`,[userId]),
 ])
 // A stay runs from check-in to checkout at the home's own times, where the home is.
 const stays=(await queryAll<Omit<ActivityRow,'kind'|'starts_at'|'ends_at'>&{check_in_date:string;check_out_date:string;check_in_time:string;check_out_time:string}>(db,`SELECT COALESCE(r.id,s.id) id,r.id request_id,s.id operational_id,s.organization_id,o.name organization_name,o.slug organization_slug,p.name title,s.status,
   s.check_in_date,s.check_out_date,c.check_in_time,c.check_out_time,l.timezone,s.created_at,c.location_id,l.title location_title,s.product_id,s.adults+s.children party_size
  FROM stays s JOIN organization o ON o.id=s.organization_id JOIN product_stay_configs c ON c.organization_id=s.organization_id AND c.product_id=s.product_id
  JOIN products p ON p.organization_id=s.organization_id AND p.id=s.product_id JOIN business_locations l ON l.organization_id=c.organization_id AND l.id=c.location_id
  LEFT JOIN requests r ON r.id=s.request_id AND r.organization_id=s.organization_id AND r.kind='stay' AND r.user_id=? AND ${REQUEST_CURRENT_BUYER_SQL}
  WHERE s.user_id=? AND s.owner='app'`,[userId,userId])).map(({check_in_date,check_out_date,check_in_time,check_out_time,...row}):ActivityRow=>({...row,kind:'stay',
   starts_at:localDateTimeToInstant(check_in_date,check_in_time,row.timezone,'compatible').toISOString(),ends_at:localDateTimeToInstant(check_out_date,check_out_time,row.timezone,'compatible').toISOString()}))
 return {visits:[...visits,...stays],payments}
}
function visitActivity(row:ActivityRow):AccountActivityItem {
 return {kind:row.kind,id:row.id,requestId:row.request_id,operationalId:row.operational_id,paymentId:null,organizationId:row.organization_id,organizationName:row.organization_name,organizationSlug:row.organization_slug,title:row.title,status:row.status,startsAt:row.starts_at,endsAt:row.ends_at,timeZone:row.timezone,createdAt:row.created_at,imageUrl:null,locationTitle:row.location_title,partySize:row.party_size}
}
function paymentActivity(row:BuyerPaymentRow):AccountActivityItem {
 const snapshot:unknown=JSON.parse(row.price_snapshot_json)
 if(!snapshot||typeof snapshot!=='object'||!('title' in snapshot)||typeof snapshot.title!=='string'||!snapshot.title.trim())throw new Error('Owned payment has no immutable title')
 const kind=row.order_id?'order':'payment'
 if(kind==='order'&&row.subject_type!=='order')throw new Error('Owned order does not match its payment subject')
 // An ended/deleted session supplies no timezone. The retained hold is not an
 // operational booking; it never manufactures a calendar occurrence.
 const scheduled=kind==='payment'&&!!row.hold_timezone
 return {kind,id:row.id,requestId:kind==='payment'?row.hold_request_id:null,operationalId:null,paymentId:row.id,organizationId:row.organization_id,organizationName:row.organization_name,organizationSlug:row.organization_slug,title:snapshot.title,status:row.state,startsAt:scheduled?row.hold_starts_at:null,endsAt:scheduled?row.hold_ends_at:null,timeZone:scheduled?row.hold_timezone:null,createdAt:row.created_at,imageUrl:null,locationTitle:null,partySize:null}
}
function resolvePaymentActivity(rows:Awaited<ReturnType<typeof buyerActivityRows>>,payment:BuyerPaymentRow):AccountActivityItem {
 const visits=rows.visits.filter(row=>row.kind===payment.subject_type&&row.operational_id===payment.subject_id&&row.organization_id===payment.organization_id)
 if(visits.length>1)throw new Error('Owned payment has ambiguous visit associations')
 return visits[0]?visitActivity(visits[0]):paymentActivity(payment)
}
export async function buyerActivities(db:DbClient,userId:string):Promise<AccountActivityResponse> {
 const rows=await buyerActivityRows(db,userId)
 const activities=rows.visits.map(visitActivity)
 for(const payment of rows.payments){
  const item=resolvePaymentActivity(rows,payment)
  if(item.kind==='payment'||item.kind==='order')activities.push(item)
 }
 for(const item of activities){
  const visit=rows.visits.find(row=>row.kind===item.kind&&row.id===item.id)
  if(visit){
   const ownerType=visit.product_id?'product':'business_location',ownerId=visit.product_id??visit.location_id
   if(ownerId)item.imageUrl=(await loadOwnerPictures(db,item.organizationId,ownerType,[ownerId])).get(ownerId)?.imageUrl??null
  }
  if(!isAccountActivityItem(item))throw new Error('Owned activity has invalid required state')
 }
 activities.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id))
 return {activities}
}
/** The account’s payments and completed refunds, newest first. */
export async function buyerPayments(db:DbClient,userId:string):Promise<{entries:BuyerPaymentEntry[]}> {
 const rows=await buyerActivityRows(db,userId)
 const refunds=rows.payments.length?await queryAll<{id:string;payment_id:string;amount:number;created_at:string}>(db,`SELECT id,payment_id,amount,created_at FROM payment_refunds WHERE status='succeeded' AND payment_id IN (SELECT value FROM json_each(?))`,[JSON.stringify(rows.payments.map(row=>row.id))]):[]
 const entries:BuyerPaymentEntry[]=[]
 for(const payment of rows.payments){
  if(payment.captured_amount<=0)continue
  const item=resolvePaymentActivity(rows,payment),snapshot:unknown=JSON.parse(payment.price_snapshot_json)
  if(!snapshot||typeof snapshot!=='object'||!('title' in snapshot)||typeof snapshot.title!=='string'||!snapshot.title.trim())throw new Error('Owned payment has no immutable title')
  const to=accountActivityPath(item.kind,item.id)
  const visit=rows.visits.find(row=>row.kind===item.kind&&row.id===item.id)
  const ownerType=visit?.product_id?'product':'business_location',ownerId=visit?(visit.product_id??visit.location_id):(await queryFirst<{product_id:string|null}>(db,'SELECT l.product_id FROM payment_order_lines l JOIN payment_orders o ON o.id=l.order_id WHERE o.payment_id=? ORDER BY l.rowid LIMIT 1',[payment.id]))?.product_id??null
  const imageUrl=ownerId?(await loadOwnerPictures(db,payment.organization_id,visit?ownerType:'product',[ownerId])).get(ownerId)?.imageUrl??null:null
  const line={title:visit?visit.title:snapshot.title,organizationName:payment.organization_name,currency:payment.currency,to,imageUrl,visitStartsAt:visit?.starts_at??null,visitEndsAt:visit?.ends_at??null,timeZone:visit?.timezone??null}
  entries.push({id:`paid:${payment.id}`,kind:'paid',occurredAt:payment.created_at,amount:payment.captured_amount,...line})
  for(const refund of refunds.filter(row=>row.payment_id===payment.id))entries.push({id:`refund:${refund.id}`,kind:'refunded',occurredAt:refund.created_at,amount:-refund.amount,...line})
 }
 for(const entry of entries)if(!isBuyerPaymentEntry(entry))throw new Error('Owned payment line has invalid required state')
 entries.sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||a.id.localeCompare(b.id))
 return {entries}
}
export async function buyerPaymentActivityPath(db:DbClient,userId:string,paymentId:string):Promise<string> {
 const rows=await buyerActivityRows(db,userId),payment=rows.payments.find(row=>row.id===paymentId)
 if(!payment)throw new HTTPError({statusCode:404,statusMessage:'Owned activity not found'})
 const item=resolvePaymentActivity(rows,payment)
 return accountActivityPath(item.kind,item.id)
}
/** Conversation links share the same actual visit/payment association resolver. */
export async function buyerRequestActivityPath(db:DbClient,userId:string,requestId:string):Promise<string|null> {
 const rows=await buyerActivityRows(db,userId)
 const visits=rows.visits.filter(row=>row.request_id===requestId)
 if(visits.length>1)throw new Error('Owned conversation has ambiguous visit associations')
 if(visits[0])return accountActivityPath(visits[0].kind,visits[0].id)
 const payments=rows.payments.filter(row=>row.hold_request_id===requestId)
 if(payments.length>1)return '/dashboard/account/activity'
 if(!payments[0])return null
 const item=resolvePaymentActivity(rows,payments[0])
 return accountActivityPath(item.kind,item.id)
}
export async function tokenHash(token:string):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(v=>v.toString(16).padStart(2,'0')).join('')}
/** Hidden Checkout-return proof, accepted only after native Stripe verification. */
export async function claimCheckoutReturn(db:DbClient,userId:string,token:string) {
 if(!/^[a-f0-9-]{72}$/u.test(token)) throw new HTTPError({statusCode:400,statusMessage:'Invalid Checkout return proof'})
 const hash=await tokenHash(token),now=new Date().toISOString()
 const available=`SELECT payment_id,claimed_at FROM payment_claims WHERE token_hash=? AND expires_at>? AND EXISTS(SELECT 1 FROM payments p WHERE p.id=payment_claims.payment_id AND p.captured_amount>0 AND ((claimed_at IS NOT NULL AND p.buyer_user_id=?) OR (claimed_at IS NULL AND (p.buyer_user_id IS NULL OR p.buyer_user_id=? OR EXISTS(SELECT 1 FROM user u WHERE u.id=p.buyer_user_id AND u.isAnonymous=1)))))`
 const params=[hash,now,userId,userId]
 const claim=await queryFirst<{payment_id:string;claimed_at:string|null}>(db,available,params)
 if(!claim) throw new HTTPError({statusCode:404,statusMessage:'Purchase return proof expired or already used'})
 if(claim.claimed_at)return {payment_id:claim.payment_id,claimed:true}
 const result=await executeBatch(db,[
  {query:'UPDATE payment_claims SET claimed_at=?,claimed_user_id=? WHERE token_hash=? AND expires_at>? AND claimed_at IS NULL AND EXISTS(SELECT 1 FROM payments p WHERE p.id=payment_claims.payment_id AND p.captured_amount>0 AND (p.buyer_user_id IS NULL OR p.buyer_user_id=? OR EXISTS(SELECT 1 FROM user u WHERE u.id=p.buyer_user_id AND u.isAnonymous=1)))',params:[now,userId,hash,now,userId]},
  {query:'UPDATE payments SET buyer_user_id=? WHERE id=? AND EXISTS(SELECT 1 FROM payment_claims WHERE token_hash=? AND claimed_user_id=? AND claimed_at=?)',params:[userId,claim.payment_id,hash,userId,now]},
  {query:'UPDATE payment_orders SET buyer_user_id=? WHERE payment_id=? AND EXISTS(SELECT 1 FROM payment_claims WHERE token_hash=? AND claimed_user_id=? AND claimed_at=?)',params:[userId,claim.payment_id,hash,userId,now]},
  {query:'UPDATE payment_checkout_holds SET buyer_user_id=? WHERE payment_id=? AND EXISTS(SELECT 1 FROM payment_claims WHERE token_hash=? AND claimed_user_id=? AND claimed_at=?)',params:[userId,claim.payment_id,hash,userId,now]},
  {query:"UPDATE bookings SET user_id=? WHERE id=(SELECT subject_id FROM payments WHERE id=? AND subject_type='booking') AND EXISTS(SELECT 1 FROM payment_claims WHERE token_hash=? AND claimed_user_id=? AND claimed_at=?)",params:[userId,claim.payment_id,hash,userId,now]},
  {query:"UPDATE reservations SET user_id=? WHERE id=(SELECT subject_id FROM payments WHERE id=? AND subject_type='reservation') AND EXISTS(SELECT 1 FROM payment_claims WHERE token_hash=? AND claimed_user_id=? AND claimed_at=?)",params:[userId,claim.payment_id,hash,userId,now]},
  {query:'UPDATE requests SET user_id=? WHERE id=(SELECT request_id FROM payment_checkout_holds WHERE payment_id=?) AND EXISTS(SELECT 1 FROM payment_claims WHERE token_hash=? AND claimed_user_id=? AND claimed_at=?)',params:[userId,claim.payment_id,hash,userId,now]},
  {query:"UPDATE stays SET user_id=? WHERE id=(SELECT subject_id FROM payments WHERE id=? AND subject_type='stay') AND EXISTS(SELECT 1 FROM payment_claims WHERE token_hash=? AND claimed_user_id=? AND claimed_at=?)",params:[userId,claim.payment_id,hash,userId,now]},
  {query:"UPDATE requests SET user_id=? WHERE id=(SELECT s.request_id FROM stays s JOIN payments p ON p.subject_id=s.id AND p.subject_type='stay' AND p.organization_id=s.organization_id WHERE p.id=?) AND EXISTS(SELECT 1 FROM payment_claims WHERE token_hash=? AND claimed_user_id=? AND claimed_at=?)",params:[userId,claim.payment_id,hash,userId,now]},
  {query:'UPDATE payment_claims SET claimed_at=?,claimed_user_id=? WHERE payment_id=? AND token_hash<>? AND claimed_at IS NULL AND EXISTS(SELECT 1 FROM payment_claims WHERE token_hash=? AND claimed_user_id=? AND claimed_at=?)',params:[now,userId,claim.payment_id,hash,hash,userId,now]},
 ],{operation:'Attach verified Checkout purchase'})
 if(result[0]?.meta.changes!==1){
  const replay=await queryFirst<{payment_id:string;claimed_at:string|null}>(db,available,params)
  if(!replay?.claimed_at)throw new HTTPError({statusCode:404,statusMessage:'Purchase return proof expired or already used'})
 }
 return {payment_id:claim.payment_id,claimed:true}
}
