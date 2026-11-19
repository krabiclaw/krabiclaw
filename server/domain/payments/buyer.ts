import {transferBookingGuestSeat} from '~/server/domain/conversation-participants'
import {HTTPError} from 'nitro'
import {executeBatch,queryAll,queryFirst,type BatchQuery,type DbClient} from '~/server/db'
import {CURRENT_GUEST_SQL} from '~/server/domain/conversations'
import {loadOwnerPictures} from '~/server/notifications/hero'
import {accountActivityPath,isAccountActivityItem,isBuyerPaymentEntry,type AccountActivityItem,type AccountActivityKind,type AccountActivityResponse,type BuyerPaymentEntry} from '~/shared/account-activity'
import type { Payment } from './index'

export async function ownedBuyerRequest(db:DbClient,userId:string,id:string,lookup:'conversation'|'booking'='conversation') {
 // The conversation's booking is the buyer's: CURRENT_GUEST_SQL holds it to the conversation's own guest.
 const owned=await queryFirst<{organization_id:string;booking_id:string;conversation_id:string;unit:'slot'|'nights'}>(db,`SELECT r.organization_id,b.id booking_id,r.id conversation_id,CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END unit FROM conversations r JOIN bookings b ON b.id=r.booking_id AND b.organization_id=r.organization_id
  WHERE ${lookup==='booking'?'b.id':'r.id'}=? AND r.user_id=? AND r.kind='booking' AND ${CURRENT_GUEST_SQL('r')}`,[id,userId])
 if(!owned)throw new HTTPError({statusCode:404,statusMessage:'Owned booking not found'})
 return owned
}
type ActivityRow = {
 kind: 'booking'|'stay'; id:string; conversation_id:string|null; booking_id:string; organization_id:string;
 organization_name:string; organization_slug:string; title:string; status:string;
 starts_at:string; ends_at:string; timezone:string; created_at:string; location_id:string|null;
 location_title:string|null; product_id:string|null; party_size:number
}
type BuyerPaymentRow = {id:string;organization_id:string;organization_name:string|null;organization_slug:string|null;currency:string;captured_amount:number;refunded_amount:number;subject_type:string;subject_id:string;price_snapshot_json:string;created_at:string;hold_conversation_id:string|null;hold_starts_at:string|null;hold_ends_at:string|null;hold_timezone:string|null}
async function buyerActivityRows(db:DbClient,userId:string) {
 // Every booking the account made on a business's site, one row each: a stay's ends are its stored instants, or its days where its home had no time.
 const [visits,payments]=await Promise.all([
  queryAll<ActivityRow>(db,`SELECT CASE WHEN b.product_session_id IS NULL THEN 'stay' ELSE 'booking' END kind,COALESCE(r.id,b.id) id,r.id conversation_id,b.id booking_id,b.organization_id,o.name organization_name,o.slug organization_slug,p.name title,b.status,b.starts_at,b.ends_at,b.timezone,b.created_at,b.location_id,l.title location_title,b.product_id,b.party_size
   FROM bookings b LEFT JOIN conversations r ON r.booking_id=b.id AND r.kind='booking' JOIN organization o ON o.id=b.organization_id JOIN products p ON p.id=b.product_id AND p.organization_id=b.organization_id LEFT JOIN business_locations l ON l.id=b.location_id AND l.organization_id=b.organization_id
   WHERE b.user_id=? AND b.owner='app' AND (r.id IS NULL OR (r.organization_id=b.organization_id AND r.kind='booking' AND r.user_id=? AND ${CURRENT_GUEST_SQL('r')}))`,[userId,userId]),
  queryAll<BuyerPaymentRow>(db,`SELECT p.id,p.organization_id,o.name organization_name,o.slug organization_slug,p.currency,p.captured_amount,p.refunded_amount,p.subject_type,p.subject_id,p.price_snapshot_json,p.created_at,r.id hold_conversation_id,h.starts_at hold_starts_at,h.ends_at hold_ends_at,COALESCE(s.timezone,CASE WHEN h.session_id IS NOT NULL THEN h.timezone END) hold_timezone FROM payments p LEFT JOIN organization o ON o.id=p.organization_id LEFT JOIN payment_checkout_holds h ON h.payment_id=p.id AND h.organization_id=p.organization_id AND h.buyer_user_id=p.buyer_user_id LEFT JOIN conversations r ON r.id=h.conversation_id AND r.organization_id=p.organization_id AND r.user_id=p.buyer_user_id AND ${CURRENT_GUEST_SQL('r')} LEFT JOIN product_sessions s ON s.id=h.session_id AND s.organization_id=p.organization_id WHERE p.buyer_user_id=? ORDER BY p.created_at DESC`,[userId]),
 ])
 return {visits,payments}
}
function visitActivity(row:ActivityRow):AccountActivityItem {
 return {kind:row.kind,id:row.id,conversation_id:row.conversation_id,booking_id:row.booking_id,payment_id:null,organization_id:row.organization_id,organization_name:row.organization_name,organization_slug:row.organization_slug,title:row.title,status:row.status,starts_at:row.starts_at,ends_at:row.ends_at,timezone:row.timezone,created_at:row.created_at,image_url:null,location_title:row.location_title,party_size:row.party_size}
}
function paymentActivity(row:BuyerPaymentRow):AccountActivityItem {
 const snapshot:unknown=JSON.parse(row.price_snapshot_json)
 if(!snapshot||typeof snapshot!=='object'||!('title' in snapshot)||typeof snapshot.title!=='string'||!snapshot.title.trim())throw new Error('Owned payment has no immutable title')
 // An ended/deleted session supplies no timezone. The retained hold is not an
 // operational booking; it never manufactures a calendar occurrence.
 const scheduled=!!row.hold_timezone
 return {kind:'payment',id:row.id,conversation_id:row.hold_conversation_id,booking_id:null,payment_id:row.id,organization_id:row.organization_id,organization_name:row.organization_name,organization_slug:row.organization_slug,title:snapshot.title,status:row.captured_amount===0?'pending':row.refunded_amount===row.captured_amount?'refunded':'captured',starts_at:scheduled?row.hold_starts_at:null,ends_at:scheduled?row.hold_ends_at:null,timezone:scheduled?row.hold_timezone:null,created_at:row.created_at,image_url:null,location_title:null,party_size:null}
}
function resolvePaymentActivity(rows:Awaited<ReturnType<typeof buyerActivityRows>>,payment:BuyerPaymentRow):AccountActivityItem {
 const visits=rows.visits.filter(row=>payment.subject_type==='booking'&&row.organization_id===payment.organization_id&&(row.booking_id===payment.subject_id||(row.kind==='stay'&&row.conversation_id!==null&&row.conversation_id===payment.hold_conversation_id)))
 if(visits.length>1)throw new Error('Owned payment has ambiguous visit associations')
 return visits[0]?visitActivity(visits[0]):paymentActivity(payment)
}
export async function buyerActivities(db:DbClient,userId:string):Promise<AccountActivityResponse> {
 const rows=await buyerActivityRows(db,userId)
 const activities=rows.visits.map(visitActivity)
 for(const payment of rows.payments){
  const item=resolvePaymentActivity(rows,payment)
  if(item.kind==='payment')activities.push(item)
 }
 for(const item of activities){
  const visit=rows.visits.find(row=>row.kind===item.kind&&row.id===item.id)
  if(visit){
   const ownerType=visit.product_id?'product':'business_location',ownerId=visit.product_id??visit.location_id
   if(ownerId)item.image_url=(await loadOwnerPictures(db,item.organization_id,ownerType,[ownerId])).get(ownerId)?.imageUrl??null
  }
  if(!isAccountActivityItem(item))throw new Error('Owned activity has invalid required state')
 }
 activities.sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id))
 return {activities}
}
/** The account’s payments and completed refunds, newest first. */
export async function buyerPayments(db:DbClient,userId:string):Promise<{entries:BuyerPaymentEntry[]}> {
 // Three reads in parallel, then one picture read per business and kind of owner, also in parallel.
 const [rows,refunds]=await Promise.all([
  buyerActivityRows(db,userId),
  queryAll<{id:string;payment_id:string;amount:number;created_at:string}>(db,`SELECT f.id,f.payment_id,f.amount,f.created_at FROM payment_refunds f JOIN payments p ON p.id=f.payment_id WHERE f.status='succeeded' AND p.buyer_user_id=?`,[userId]),
 ])
 const lines=rows.payments.filter(payment=>payment.captured_amount>0).map(payment=>{
  const item=resolvePaymentActivity(rows,payment),snapshot:unknown=JSON.parse(payment.price_snapshot_json)
  if(!snapshot||typeof snapshot!=='object'||!('title' in snapshot)||typeof snapshot.title!=='string'||!snapshot.title.trim())throw new Error('Owned payment has no immutable title')
  const visit=rows.visits.find(row=>row.kind===item.kind&&row.id===item.id)
  const ownerType:'product'|'business_location'=visit?.product_id?'product':'business_location'
  const ownerId=visit?(visit.product_id??visit.location_id):null
  return {payment,visit,title:snapshot.title,to:accountActivityPath(item.kind,item.id),owner:ownerId?{key:`${payment.organization_id}\u0000${ownerType}`,organizationId:payment.organization_id,ownerType,ownerId}:null}
 })
 const owners=new Map<string,{organizationId:string;ownerType:'product'|'business_location';ids:string[]}>()
 for(const {owner} of lines)if(owner){
  const group=owners.get(owner.key)??{organizationId:owner.organizationId,ownerType:owner.ownerType,ids:[]}
  group.ids.push(owner.ownerId)
  owners.set(owner.key,group)
 }
 const pictures=new Map(await Promise.all([...owners].map(async([key,group])=>[key,await loadOwnerPictures(db,group.organizationId,group.ownerType,group.ids)] as const)))
 const entries:BuyerPaymentEntry[]=[]
 for(const {payment,visit,title,to,owner} of lines){
  const image_url=owner?pictures.get(owner.key)?.get(owner.ownerId)?.imageUrl??null:null
  const line={title:visit?visit.title:title,organization_name:payment.organization_name,currency:payment.currency,to,image_url,starts_at:visit?.starts_at??null,ends_at:visit?.ends_at??null,timezone:visit?.timezone??null}
  entries.push({id:`paid:${payment.id}`,kind:'paid',created_at:payment.created_at,amount:payment.captured_amount,...line})
  for(const refund of refunds.filter(row=>row.payment_id===payment.id))entries.push({id:`refund:${refund.id}`,kind:'refunded',created_at:refund.created_at,amount:-refund.amount,...line})
 }
 for(const entry of entries)if(!isBuyerPaymentEntry(entry))throw new Error('Owned payment line has invalid required state')
 entries.sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id))
 return {entries}
}
export async function buyerPaymentActivityPath(db:DbClient,userId:string,payment_id:string):Promise<string> {
 const rows=await buyerActivityRows(db,userId),payment=rows.payments.find(row=>row.id===payment_id)
 if(!payment)throw new HTTPError({statusCode:404,statusMessage:'Owned activity not found'})
 const item=resolvePaymentActivity(rows,payment)
 return accountActivityPath(item.kind,item.id)
}
/** The linked app booking takes precedence over a checkout for the same conversation. */
export async function buyerRequestActivityPath(db: DbClient, input: { organizationId: string; conversationId: string; userId?: string }): Promise<string | null> {
  const { query, params } = buyerRequestActivityQuery(input)
  return buyerRequestActivityFromRows(await queryAll(db, query, params))
}

export function buyerRequestActivityQuery(input: { organizationId: string | BatchQuery; conversationId: string; userId?: string }): BatchQuery {
  const organization = typeof input.organizationId === 'string' ? { query: '?', params: [input.organizationId] } : input.organizationId
  const params = [input.conversationId, ...organization.params ?? []]
  if (input.userId !== undefined) params.push(input.userId)
  return { query: `
    WITH owned AS (
      SELECT c.id, c.organization_id, c.user_id, c.booking_id FROM conversations c
      WHERE c.id = ? AND c.organization_id = ${organization.query} AND c.kind = 'booking' AND ${CURRENT_GUEST_SQL('c')}
        ${input.userId === undefined ? '' : 'AND c.user_id = ?'}
    ), visit AS (
      SELECT CASE WHEN b.product_session_id IS NULL THEN 'stay' ELSE 'booking' END AS kind, c.id
      FROM owned c JOIN bookings b ON b.id = c.booking_id AND b.organization_id = c.organization_id AND b.user_id = c.user_id AND b.owner = 'app'
    ), checkout AS (
      SELECT p.id, p.organization_id, p.buyer_user_id, p.subject_type, p.subject_id
      FROM owned c JOIN payments p ON p.buyer_user_id = c.user_id AND p.organization_id = c.organization_id
      JOIN payment_checkout_holds h ON h.payment_id = p.id AND h.organization_id = p.organization_id AND h.buyer_user_id = p.buyer_user_id AND h.conversation_id = c.id
      WHERE NOT EXISTS (SELECT 1 FROM visit)
      LIMIT 2
    )
    SELECT kind, id FROM visit
    UNION ALL
    SELECT CASE WHEN b.id IS NOT NULL THEN CASE WHEN b.product_session_id IS NULL THEN 'stay' ELSE 'booking' END
      ELSE 'payment' END AS kind, COALESCE(r.id, b.id, p.id) AS id
    FROM checkout p
    LEFT JOIN bookings b ON p.subject_type = 'booking' AND b.id = p.subject_id AND b.organization_id = p.organization_id AND b.user_id = p.buyer_user_id AND b.owner = 'app'
      AND NOT EXISTS (SELECT 1 FROM conversations other WHERE other.booking_id = b.id AND other.kind = 'booking'
        AND (other.organization_id <> b.organization_id OR other.user_id IS NOT b.user_id))
    LEFT JOIN conversations r ON r.booking_id = b.id AND r.kind = 'booking'
  `, params }
}

export function buyerRequestActivityFromRows(rows: unknown[]): string | null {
  if (rows.length > 1) return '/dashboard/account/activity'
  const activity = rows[0] as { kind: AccountActivityKind; id: string } | undefined
  if (!activity) return null
  return accountActivityPath(activity.kind, activity.id)
}
export async function tokenHash(token:string):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(v=>v.toString(16).padStart(2,'0')).join('')}

export function originalCheckoutClaim(paymentId: string, userId: string, hash: string, now: string) {
 const queries: BatchQuery[] = [
  {query:`UPDATE payments SET claimed_at=?,claimed_user_id=?
    WHERE id=? AND buyer_user_id=? AND return_token_hash=? AND return_expires_at>? AND claimed_at IS NULL AND captured_amount>0`,
   params:[now,userId,paymentId,userId,hash,now]},
  {query:`SELECT 1 AS claimed FROM payments WHERE id=? AND buyer_user_id=? AND return_token_hash=?
    AND return_expires_at>? AND claimed_at IS NOT NULL AND captured_amount>0`, params:[paymentId,userId,hash,now]},
 ]
 return { queries, read: ([, owner]: D1Result[]) => owner?.results.length === 1 }
}

/** Hidden Checkout-return proof, accepted only after native Stripe verification. */
export async function claimCheckoutReturn(db:DbClient,userId:string,token:string,payment?:Pick<Payment,'id'|'buyer_user_id'|'captured_amount'|'claimed_at'|'return_token_hash'|'return_expires_at'>,
 receipt?: { queries: BatchQuery[]; read: (rows: D1Result[]) => Promise<void> }, guard?: BatchQuery) {
 if(!/^[a-f0-9-]{72}$/u.test(token)) throw new HTTPError({statusCode:400,statusMessage:'Invalid Checkout return proof'})
 const hash=await tokenHash(token),now=new Date().toISOString()
 const unavailable=()=>new HTTPError({statusCode:404,statusMessage:'Purchase return proof expired or already used'})
 const available=`SELECT p.id AS payment_id,p.claimed_at,p.buyer_user_id FROM payments p WHERE p.return_token_hash=? AND p.return_expires_at>? AND p.captured_amount>0 AND ((p.claimed_at IS NOT NULL AND p.buyer_user_id=?) OR (p.claimed_at IS NULL AND (p.buyer_user_id IS NULL OR p.buyer_user_id=? OR EXISTS(SELECT 1 FROM user u WHERE u.id=p.buyer_user_id AND u.isAnonymous=1))))`
 const params=[hash,now,userId,userId]
 const claim=payment?.return_token_hash===hash && payment.return_expires_at && payment.return_expires_at>now && payment.captured_amount>0 && payment.buyer_user_id===userId
  ? {payment_id:payment.id,claimed_at:payment.claimed_at,buyer_user_id:payment.buyer_user_id}
  : await queryFirst<{payment_id:string;claimed_at:string|null;buyer_user_id:string|null}>(db,available,params)
 if(!claim) throw unavailable()
 const response={payment_id:claim.payment_id,claimed:true}
 const leading = guard ? [guard] : []
 const readReceipt = async () => {
  if(receipt || guard) {
   const rows = await executeBatch(db,[...leading,...receipt?.queries ?? []],{operation:'Read claimed guest receipt'})
   if(receipt) await receipt.read(rows.slice(leading.length))
  }
  return response
 }
 if(claim.claimed_at)return readReceipt()
 // The original buyer already owns the booking, its conversation and the hold.
 if(claim.buyer_user_id===userId){
  const plan=originalCheckoutClaim(claim.payment_id,userId,hash,now)
  const [marked, owner, ...rows]=(await executeBatch(db,[...leading,...plan.queries,...receipt?.queries ?? []],
    {operation:'Claim checkout and read guest receipt'})).slice(leading.length)
  if(!plan.read([marked!,owner!]))throw unavailable()
  if(receipt)await receipt.read(rows)
  return response
 }
 const conversationId="COALESCE((SELECT conversation_id FROM payment_checkout_holds WHERE payment_id=?),(SELECT c.id FROM conversations c JOIN payments p ON p.subject_id=c.booking_id AND p.subject_type='booking' AND p.organization_id=c.organization_id WHERE p.id=? AND c.kind='booking'))"
 const claimedConversation={query:`c.id=${conversationId} AND EXISTS(SELECT 1 FROM payments claim WHERE claim.return_token_hash=? AND claim.claimed_user_id=? AND claim.claimed_at=?)`,params:[claim.payment_id,claim.payment_id,hash,userId,now]}
 const result=await executeBatch(db,[
  ...leading,
  {query:'UPDATE payments SET claimed_at=?,claimed_user_id=?,buyer_user_id=? WHERE return_token_hash=? AND return_expires_at>? AND claimed_at IS NULL AND captured_amount>0 AND (buyer_user_id IS NULL OR buyer_user_id=? OR EXISTS(SELECT 1 FROM user u WHERE u.id=payments.buyer_user_id AND u.isAnonymous=1))',params:[now,userId,userId,hash,now,userId]},
  {query:'UPDATE payment_checkout_holds SET buyer_user_id=? WHERE payment_id=? AND EXISTS(SELECT 1 FROM payments claim WHERE claim.return_token_hash=? AND claim.claimed_user_id=? AND claim.claimed_at=?)',params:[userId,claim.payment_id,hash,userId,now]},
  {query:"UPDATE bookings SET user_id=? WHERE id=(SELECT subject_id FROM payments WHERE id=? AND subject_type='booking') AND EXISTS(SELECT 1 FROM payments claim WHERE claim.return_token_hash=? AND claim.claimed_user_id=? AND claim.claimed_at=?)",params:[userId,claim.payment_id,hash,userId,now]},
  // The booking's conversation: a session booking's checkout waited in it, a stay's opened with the booking.
  ...transferBookingGuestSeat(claimedConversation,userId,now),
  {query:`UPDATE conversations AS c SET user_id=? WHERE ${claimedConversation.query}`,params:[userId,...claimedConversation.params]},
  {query:available,params},
  ...receipt?.queries ?? [],
 ],{operation:'Attach verified Checkout purchase'})
 const receiptStart=result.length-(receipt?.queries.length??0)
 if(result[leading.length]?.meta.changes!==1 && !(result[receiptStart-1]?.results[0] as { claimed_at?: string | null } | undefined)?.claimed_at)throw unavailable()
 if(receipt)await receipt.read(result.slice(receiptStart))
 return response
}
