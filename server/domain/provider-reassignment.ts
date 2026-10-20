import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type BatchQuery } from '~/server/db'
import { providerUnavailableSql } from '~/server/utils/provider-allocation'
import { requireSchedulingAccess, refreshMemberBusy, type SchedulingActor } from './member-scheduling'
import { executeGuestThreadOperation } from './guest-threads/operations'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { notifyBookingReassigned } from '~/server/utils/notifications'

/**
 * Moves a provider-led booking to another team member who is free at that time:
 * the whole occurrence moves, its time, guests and payments stay. Hours, time
 * off, busy calendar and overlapping bookings are checked in the same write.
 */
export async function reassignBookingProvider(actor: SchedulingActor, input: {booking_id:string;member_id:string;expected_updated_at:string;idempotency_key:string}) {
 if(!input || (['booking_id','member_id','expected_updated_at','idempotency_key'] as const).some(field=>typeof input[field]!=='string' || !input[field]))throw new HTTPError({statusCode:400,message:'Booking, member, current revision and idempotency key are required'})
 await requireSchedulingAccess(actor,input.member_id,true)
 const db=actor.env.DB
 if(!input.idempotency_key || input.idempotency_key.length>120)throw new HTTPError({statusCode:400,message:'A durable idempotency key is required'})
 const key=`provider:${actor.organizationId}:${input.idempotency_key}`
 const prior=await queryFirst<{payload_json:string}>(db,'SELECT payload_json FROM activity_entries WHERE dedupe_key=?',[key])
 const booking=await queryFirst<{id:string;product_session_id:string;product_id:string;assigned_member_id:string|null;updated_at:string}>(db,"SELECT * FROM bookings WHERE id=? AND organization_id=? AND status IN ('pending','confirmed')",[input.booking_id,actor.organizationId])
 if(!booking)throw new HTTPError({statusCode:404,message:'Live booking not found'})
 if(prior) {
  const payload=JSON.parse(prior.payload_json)
  if(payload.booking_id!==input.booking_id||payload.new_member_id!==input.member_id||payload.actor_user_id!==actor.userId)throw new HTTPError({statusCode:409,message:'Idempotency key belongs to a different reassignment'})
  if(booking.assigned_member_id!==input.member_id||booking.product_session_id!==payload.session_id)throw new HTTPError({statusCode:409,message:'This reassignment was superseded. Read the current booking before continuing.'})
 }
 else {
  if(booking.assigned_member_id===input.member_id)throw new HTTPError({statusCode:409,message:'This booking is already with that team member'})
  await refreshMemberBusy(db,actor.env,input.member_id,true)
  const now=new Date().toISOString(),audit=crypto.randomUUID()
  const payload=JSON.stringify({booking_id:booking.id,session_id:booking.product_session_id,old_member_id:booking.assigned_member_id,new_member_id:input.member_id,actor_user_id:actor.userId})
  const queries:BatchQuery[]=[{query:`INSERT INTO activity_entries(id,kind,scope_kind,organization_id,actor_kind,actor_user_id,event_name,payload_json,dedupe_key,occurred_at)
    SELECT ?,'audit','organization',?,'member',?,'booking.reassign',?,?,? FROM product_sessions s, (SELECT ? AS member_id) target
    WHERE s.id=? AND s.organization_id=? AND s.status='scheduled' AND s.starts_at>?
      AND EXISTS(SELECT 1 FROM product_booking_configs cfg WHERE cfg.product_id=s.product_id AND cfg.organization_id=s.organization_id AND cfg.scheduling_mode='provider')
      AND NOT ${providerUnavailableSql('s','NULL','NULL','target.member_id')}
      AND EXISTS(SELECT 1 FROM bookings WHERE id=? AND organization_id=? AND updated_at=? AND status IN ('pending','confirmed'))
      AND NOT EXISTS(SELECT 1 FROM payment_checkout_holds h WHERE h.session_id=s.id AND h.status='active' AND h.expires_at>?)
    ON CONFLICT(dedupe_key) DO NOTHING`,params:[audit,actor.organizationId,actor.userId,payload,key,now,input.member_id,booking.product_session_id,actor.organizationId,now,input.booking_id,actor.organizationId,input.expected_updated_at,now]},
   {query:'UPDATE product_sessions SET assigned_member_id=?,updated_at=? WHERE id=? AND organization_id=? AND EXISTS(SELECT 1 FROM activity_entries WHERE id=?)',params:[input.member_id,now,booking.product_session_id,actor.organizationId,audit]},
   {query:`INSERT INTO activity_entries(id,kind,scope_kind,request_id,actor_kind,actor_user_id,event_name,payload_json,dedupe_key,occurred_at)
    SELECT lower(hex(randomblob(16))),'audit','request',b.request_id,'member',?,'booking.reassign',json_object('operational_booking_id',b.id,'session_id',b.product_session_id,'old_member_id',b.assigned_member_id,'new_member_id',?,'actor_user_id',?),?||':'||b.id,? FROM bookings b WHERE b.product_session_id=? AND b.organization_id=? AND b.request_id IS NOT NULL AND b.status IN ('pending','confirmed') AND EXISTS(SELECT 1 FROM activity_entries WHERE id=?)`,params:[actor.userId,input.member_id,actor.userId,key,now,booking.product_session_id,actor.organizationId,audit]},
   {query:"UPDATE bookings SET assigned_member_id=?,updated_at=? WHERE product_session_id=? AND organization_id=? AND status IN ('pending','confirmed') AND EXISTS(SELECT 1 FROM activity_entries WHERE id=?)",params:[input.member_id,now,booking.product_session_id,actor.organizationId,audit]}]
  const result=await executeBatch(db,queries,{operation:'Reassign provider-led Session'})
  if(!result[0]?.meta.changes)throw new HTTPError({statusCode:409,message:'That team member isn’t free at this time, or the booking changed. Reload and try again.'})
 }
 const threads=await queryAll<{request_id:string}>(db,"SELECT a.request_id FROM activity_entries a JOIN requests r ON r.id=a.request_id AND r.organization_id=? WHERE a.event_name='booking.reassign' AND a.scope_kind='request' AND a.dedupe_key=?||':'||json_extract(a.payload_json,'$.operational_booking_id')",[actor.organizationId,key])
 const name=await queryFirst<{name:string|null}>(db,'SELECT public_name name FROM member_scheduling WHERE member_id=? AND organization_id=? AND public_approved=1',[input.member_id,actor.organizationId])
 for(const thread of threads) {
  const outcome=await executeGuestThreadOperation(db,{threadId:thread.request_id,organizationId:actor.organizationId,action:'reply',actorUserId:actor.userId,idempotencyKey:`${key}:notice`,env:actor.env,body:`Your booking is now with ${name?.name || 'another member of our team'}. The time hasn’t changed.`})
  await publishGuestInboxThreadEvent(actor.env,db,{threadId:thread.request_id,type:'thread.changed'})
  if(!outcome.ok)throw new HTTPError({statusCode:outcome.status,message:`Assignment saved; guest notification requires retry (${outcome.reason}). Retry with the same key.`})
 }
 const sources=await queryAll<{id:string;booking_id:string;previous:string|null;target:string}>(db,"SELECT a.id,json_extract(a.payload_json,'$.operational_booking_id') booking_id,json_extract(a.payload_json,'$.old_member_id') previous,json_extract(a.payload_json,'$.new_member_id') target FROM activity_entries a JOIN requests r ON r.id=a.request_id AND r.organization_id=? WHERE a.event_name='booking.reassign' AND a.scope_kind='request' AND a.dedupe_key=?||':'||json_extract(a.payload_json,'$.operational_booking_id')",[actor.organizationId,key])
 for(const source of sources)await notifyBookingReassigned(actor.env,db,{organizationId:actor.organizationId,bookingId:source.booking_id,previousMemberId:source.previous,memberId:source.target,sourceEntryId:source.id})
 const current=await queryFirst<{session_id:string;assigned_member_id:string|null}>(db,"SELECT product_session_id session_id,assigned_member_id FROM bookings WHERE id=? AND organization_id=? AND status IN ('pending','confirmed')",[input.booking_id,actor.organizationId])
 if(!current)throw new HTTPError({statusCode:404,message:'Live booking not found'})
 if(current.session_id!==booking.product_session_id||current.assigned_member_id!==input.member_id)throw new HTTPError({statusCode:409,message:'This reassignment was superseded. Read the current booking before continuing.'})
 return current
}
