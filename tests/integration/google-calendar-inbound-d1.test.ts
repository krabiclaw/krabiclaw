import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { claimSessionCapacity } from '../../server/utils/availability.ts'
import { readCalendarIntegration, storeCalendarSelection, syncCalendarOrganization } from '../../server/utils/google-calendar.ts'
import { ensureCalendarWatch, pullCalendarChanges, readCalendarSync, resolveCalendarChannel, setCalendarReschedules, stopCalendarWatch } from '../../server/utils/google-calendar-inbound.ts'
import { respondToBookingChange } from '../../server/domain/guest-threads/booking-changes.ts'
import { isBuyerVisibleThreadEntry, listThreadEntries } from '../../server/domain/guest-threads/entries.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

/** Provider I/O is intercepted: real D1/domain/delivery operations run, without live invitations. */
test('Google time and exact attorney replacement request client approval while canonical appointments and invitations remain committed', { timeout: 120_000 }, async (t) => {
  const mf = new Miniflare({ workers: [{ config: {
    name: 'calendar-inbound-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'calendar-inbound-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await mf.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(sql => db.prepare(sql)))
    await db.prepare("INSERT INTO organization(id,name,slug,default_currency,timezone,vertical) VALUES('org','Cedar','org','USD','America/New_York','service'),('other','Other','other','USD','UTC','service')").run()
    await db.prepare("INSERT INTO organization_locales(id,organization_id,locale,is_source,status) VALUES('org-en','org','en',1,'published')").run()
    await db.prepare("INSERT INTO subscription(id,plan,referenceId,status,periodEnd) VALUES('sub-org','business','org','active',4070908800)").run()
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('service','p','org','Consultation','consultation','actor','actor')").run()
    await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('v','org','p','Consultation','actor','actor')").run()
    await db.prepare("INSERT INTO product_publications(product_id,organization_id,published,created_by,updated_by) VALUES('p','org',1,'actor','actor')").run()
    await db.prepare("INSERT INTO user(id,name,email,emailVerified) VALUES('host','Attorney One','host@example.test',1),('second','Attorney Two','second@example.test',1),('owner','Owner','owner@example.test',1),('buyer','Client','jane@example.test',1),('foreign','Foreign Attorney','foreign@example.test',1)").run()
    await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('host-org','org','host','member',1),('second-org','org','second','member',1),('owner-org','org','owner','owner',1),('foreign-other','other','foreign','member',1)").run()
    await db.prepare("INSERT INTO account(id,accountId,providerId,userId,scope) VALUES('linked-account','google-owner','google','owner','https://www.googleapis.com/auth/calendar.app.created')").run()
    for (const member of ['host-org', 'second-org']) await db.prepare(`INSERT INTO member_scheduling(member_id,organization_id,public_name,public_approved,timezone,weekly_json,time_off_json,windows_json,windows_until,calendar_revision,updated_at,updated_by) VALUES(?,'org','Host',1,'UTC','[]','[]','[{"start":"2020-01-01T00:00:00.000Z","end":"2100-01-01T00:00:00.000Z"}]','2100-01-01T00:00:00.000Z','rev','2026-01-01T00:00:00.000Z','actor')`).bind(member).run()
    await db.prepare("UPDATE member_scheduling SET public_approved=1,public_name=CASE member_id WHEN 'host-org' THEN 'Attorney One' ELSE 'Attorney Two' END WHERE organization_id='org'").run()
    await db.prepare("INSERT INTO team(id,name,organizationId,createdAt) VALUES('legal-team','Legal Team','org',1)").run()
    await db.prepare("INSERT INTO teamMember(id,teamId,userId,createdAt) VALUES('team-one','legal-team','host',1),('team-two','legal-team','second',1)").run()
    await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,duration_minutes,held_online,scheduling_mode,assigned_team_id,confirmation_mode,created_by,updated_by) VALUES('p','org',30,1,'provider','legal-team','review','actor','actor')").run()
    const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
    const at = (time: string) => `${day}T${time}:00.000Z`
    for (const [id, member, start, end] of [['s','host-org',at('14:00'),at('14:30')], ['s2','host-org',at('15:00'),at('15:30')], ['s3','second-org',at('15:00'),at('15:30')]]) await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,assigned_member_id,timezone,starts_at,ends_at,capacity,created_by,updated_by) VALUES(?,'org','p',?,'America/New_York',?,?,1,'actor','actor')").bind(id,member,start,end).run()
    await db.prepare(`INSERT INTO requests(id,kind,organization_id,user_id,conversation_state,payload_json) VALUES('thread','booking','org','buyer','resolved','{"guest":{"name":"Jane Doe","email":"jane@example.test","phone":null},"notes":"PRIVATE LEGAL MATTER","party_size_is_minimum":false,"ip_hash":null,"cancellation":{"token_hash":null,"expires_at":null,"used_at":null}}')`).run()
    const { bookingId } = await claimSessionCapacity(db, { organizationId:'org', productId:'p', sessionId:'s', productVariantId:'v', partySize:1, requestId:'thread', userId:'buyer' })
    await storeCalendarSelection(db,'org',{account_id:'linked-account',calendar_id:'chosen',calendar_name:'KrabiClaw'})
    const env = { ...await mf.getBindings<CloudflareEnv>(), BETTER_AUTH_URL:'https://proof.example', BETTER_AUTH_SECRET:'local-proof-secret-long-enough-for-auth', STRIPE_SECRET_KEY:'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN:'https://krabiclaw.test', EMAIL_REPLY_SECRET:'reply-secret', EMAIL_DELIVERY_MODE:'log_only' } as CloudflareEnv
    const provider = {token:async()=> 'token'}
    const events = new Map<string,Record<string,unknown>>()
    let changes: Array<Record<string,unknown>> = []
    let forgetPosition = false
    let racePatch: Record<string,unknown> | undefined
    let sequence = 0
    const calls: string[] = []
    const invitations: Array<{method:string;event:Record<string,unknown>}> = []
    t.mock.method(globalThis,'fetch',async(input,init)=>{
      const url = new URL(String(input)); const method = init?.method ?? 'GET'
      assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer token')
      calls.push(`${method} ${url.pathname}`)
      if(url.pathname.includes('/calendarList/')) return Response.json({accessRole:'writer'})
      if(url.pathname.endsWith('/events/watch')) return Response.json({resourceId:'resource-1',expiration:String(Date.now()+7*86_400_000)})
      if(url.pathname.endsWith('/channels/stop')) return new Response(null,{status:204})
      if(method==='GET' && url.pathname.endsWith('/events')) {
        assert.equal(url.searchParams.get('showDeleted'),'true')
        if(url.searchParams.get('syncToken') && forgetPosition) {forgetPosition=false;return new Response(null,{status:410})}
        const items = url.searchParams.get('syncToken') ? changes : [...events.values()]
        changes=[]
        return Response.json({items,nextSyncToken:`position-${calls.length}`})
      }
      const payload=init?.body?JSON.parse(String(init.body)):null
      const id=method==='POST'?payload.id:url.pathname.split('/').at(-1)!
      if(method==='GET') return events.has(id)?Response.json(events.get(id)):new Response(null,{status:404})
      assert.equal(url.searchParams.get('sendUpdates'),'all','Google is explicitly asked to notify every actual participant')
      if(method==='DELETE'){events.delete(id);return new Response(null,{status:204})}
      if(method==='POST' && events.has(id))return new Response(null,{status:409})
      if(method==='PUT' && racePatch) {
        const raced={...events.get(id),...racePatch,etag:`"revision-${++sequence}"`,updated:new Date(Date.now()+sequence).toISOString()}
        events.set(id,raced);changes=[raced];racePatch=undefined
      }
      if(method==='PUT' && new Headers(init?.headers).get('If-Match')!==events.get(id)?.etag)return new Response(null,{status:412})
      const event={...payload,id,etag:`"revision-${++sequence}"`,updated:new Date(Date.now()+sequence).toISOString()}
      events.set(id,event);invitations.push({method,event})
      return Response.json(event)
    })
    await syncCalendarOrganization(env,'org',25,provider)
    const eventId=String((await db.prepare('SELECT event_id FROM google_calendar_event_links').first())!.event_id)
    assert.equal(invitations.length,1,'one insert sends one invitation operation')
    assert.deepEqual(events.get(eventId)?.attendees,[{email:'jane@example.test',responseStatus:'needsAction'},{email:'host@example.test',responseStatus:'needsAction'}])
    assert.ok(!JSON.stringify(events.get(eventId)).includes('PRIVATE LEGAL MATTER'))
    assert.equal(events.get(eventId)?.description,'Status: pending\nAttorney: Attorney One\nManage consultation: https://krabiclaw.test/dashboard/account/activity/booking/thread')
    await ensureCalendarWatch(env,'org',provider)
    const sync=(await db.prepare('SELECT * FROM google_calendar_sync').first())!
    assert.equal(await resolveCalendarChannel(db,String(sync.channel_id),String(sync.channel_token)),'org')
    assert.equal(await resolveCalendarChannel(db,String(sync.channel_id),'forged'),null)
    assert.equal((await readCalendarSync(db,'org'))?.reschedules,true)
    await ensureCalendarWatch(env,'org',provider)
    assert.equal(calls.filter(call=>call.endsWith('/events/watch')).length,1)
    const editEvent=(patch:Record<string,unknown>)=>{
      const event={...events.get(eventId),...patch,id:eventId,etag:`"revision-${++sequence}"`,updated:new Date(Date.now()+sequence).toISOString()}
      events.set(eventId,event);changes=[event];return event
    }

    // A drag creates a proposal and a delivery, then returns the shared event to
    // the booked time. The buyer reads that immutable proposal independently.
    const firstChange=editEvent({start:{dateTime:at('15:00'),timeZone:'America/New_York'},end:{dateTime:at('15:30'),timeZone:'America/New_York'}})
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:1,reviewed:0},JSON.stringify((await db.prepare('SELECT detail FROM channel_sync_log').all()).results))
    assert.equal((await db.prepare('SELECT product_session_id FROM bookings WHERE id=?').bind(bookingId).first())?.product_session_id,'s')
    assert.equal((await db.prepare("SELECT conversation_state FROM requests WHERE id='thread'").first())?.conversation_state,'waiting_on_guest')
    assert.deepEqual(events.get(eventId)?.start,{dateTime:at('14:00'),timeZone:'America/New_York'})
    const first=(await db.prepare("SELECT * FROM activity_entries WHERE event_name='booking_change.requested'").first())!
    assert.equal(first.actor_kind,'system')
    const before=await respondToBookingChange(db,env,{threadId:'thread',requestId:String(first.id),buyerUserId:'buyer'})
    assert.equal(before.status,'pending')
    assert.notEqual(before.before.whenLabel,before.after.whenLabel)
    assert.equal(JSON.parse(String(first.payload_json)).before.startsAt,at('14:00'))
    assert.equal(JSON.parse(String(first.payload_json)).afterStartsAt,at('15:00'))
    const delivered=(await db.prepare('SELECT provider,status,email_json FROM guest_thread_deliveries WHERE entry_id=?').bind(first.id).first())!
    assert.equal(delivered.provider,'log_only')
    assert.equal(delivered.status,'sent')
    const message=JSON.parse(String(delivered.email_json)).message
    assert.equal(message.to,'jane@example.test')
    assert.match(message.html,/booking-changes\/thread\//)
    assert.ok((await listThreadEntries(db,'thread')).filter(isBuyerVisibleThreadEntry).some(entry=>entry.id===first.id))
    // Replayed stale provider notification reads the restored current event,
    // rather than producing another proposal or delivering a second email.
    changes=[firstChange]
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:0,reviewed:0})
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE event_name='booking_change.requested'").first('n'),1)
    assert.equal(await db.prepare("SELECT count(*) n FROM guest_thread_deliveries WHERE entry_id=? AND purpose='status_update'").bind(first.id).first('n'),1)
    editEvent({attendees:[{email:'jane@example.test',responseStatus:'accepted'},{email:'host@example.test',responseStatus:'accepted'}]})
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:0,reviewed:0})
    assert.equal((await respondToBookingChange(db,env,{threadId:'thread',requestId:String(first.id),buyerUserId:'buyer'})).status,'pending','Google RSVP does not accept a KrabiClaw change request')
    assert.equal((await db.prepare('SELECT product_session_id FROM bookings WHERE id=?').bind(bookingId).first())?.product_session_id,'s')
    assert.equal((await respondToBookingChange(db,env,{threadId:'thread',requestId:String(first.id),decision:'accept',buyerUserId:'buyer'})).status,'accepted')
    assert.equal((await db.prepare('SELECT product_session_id FROM bookings WHERE id=?').bind(bookingId).first())?.product_session_id,'s2')
    await syncCalendarOrganization(env,'org',25,provider)
    assert.deepEqual(events.get(eventId)?.start,{dateTime:at('15:00'),timeZone:'America/New_York'})

    // Same time, different attorney: retain the original participant until the
    // buyer accepts. Declining sends no invitation to the proposed attorney.
    const invitesBeforeReplacement=invitations.length
    editEvent({attendees:[{email:'jane@example.test',responseStatus:'accepted'},{email:'second@example.test',responseStatus:'needsAction'}]})
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:1,reviewed:0})
    const replacement=(await db.prepare("SELECT id FROM activity_entries WHERE event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1").first())!
    assert.equal((await db.prepare('SELECT assigned_member_id FROM bookings WHERE id=?').bind(bookingId).first())?.assigned_member_id,'host-org')
    const replacementView=await respondToBookingChange(db,env,{threadId:'thread',requestId:String(replacement.id),buyerUserId:'buyer'})
    assert.equal(replacementView.before.whenLabel,replacementView.after.whenLabel)
    assert.equal(replacementView.before.assignedMemberName,'Attorney One')
    assert.equal(replacementView.after.assignedMemberName,'Attorney Two')
    assert.deepEqual(events.get(eventId)?.attendees,[{email:'jane@example.test',responseStatus:'accepted'},{email:'host@example.test',responseStatus:'needsAction'}])
    assert.ok(invitations.slice(invitesBeforeReplacement).every(call=>!JSON.stringify(call.event.attendees).includes('second@example.test')))
    assert.equal((await respondToBookingChange(db,env,{threadId:'thread',requestId:String(replacement.id),decision:'decline',buyerUserId:'buyer'})).status,'declined')
    await syncCalendarOrganization(env,'org',25,provider)
    assert.equal((await db.prepare('SELECT assigned_member_id FROM bookings WHERE id=?').bind(bookingId).first())?.assigned_member_id,'host-org')
    editEvent({attendees:[{email:'jane@example.test',responseStatus:'accepted'},{email:'second@example.test',responseStatus:'needsAction'}]})
    await pullCalendarChanges(env,'org',provider)
    const acceptedReplacement=(await db.prepare("SELECT id FROM activity_entries WHERE event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1").first())!
    assert.equal((await respondToBookingChange(db,env,{threadId:'thread',requestId:String(acceptedReplacement.id),decision:'accept',buyerUserId:'buyer'})).status,'accepted')
    assert.deepEqual(await db.prepare('SELECT product_session_id,assigned_member_id FROM bookings WHERE id=?').bind(bookingId).first(),{product_session_id:'s3',assigned_member_id:'second-org'})
    await syncCalendarOrganization(env,'org',25,provider)
    assert.deepEqual(events.get(eventId)?.attendees,[{email:'jane@example.test',responseStatus:'accepted'},{email:'second@example.test',responseStatus:'needsAction'}])

    // RSVP alone is neither a new proposal nor consent; no calendar rewrite
    // resets it. Arbitrary or foreign attendees are rejected and removed.
    const proposalsBefore=await db.prepare("SELECT count(*) n FROM activity_entries WHERE event_name='booking_change.requested'").first('n')
    const invitationCount=invitations.length
    editEvent({attendees:[{email:'jane@example.test',responseStatus:'declined'},{email:'second@example.test',responseStatus:'accepted'}]})
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:0,reviewed:0})
    assert.equal(invitations.length,invitationCount)
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE event_name='booking_change.requested'").first('n'),proposalsBefore)
    editEvent({attendees:[{email:'jane@example.test',responseStatus:'declined'},{email:'second@example.test',responseStatus:'accepted'},{email:'owner@example.test'}]})
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:0,reviewed:1})
    assert.equal((events.get(eventId)?.attendees as unknown[]).length,2)
    editEvent({attendees:[{email:'jane@example.test'},{email:'foreign@example.test'}]})
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:0,reviewed:1})
    assert.equal((await db.prepare('SELECT assigned_member_id FROM bookings WHERE id=?').bind(bookingId).first())?.assigned_member_id,'second-org')

    editEvent({guestsCanModify:true,attendees:[{email:'jane@example.test'},{email:'host@example.test'}]})
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:0,reviewed:1})
    assert.equal(events.get(eventId)?.guestsCanModify,false)
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE event_name='booking_change.requested'").first('n'),proposalsBefore,'guest-editable events cannot be attributed to staff as an attorney proposal')
    editEvent({status:'confirmed'})
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:0,reviewed:0})
    assert.equal(events.get(eventId)?.status,'tentative','Google status does not confirm a pending consultation')
    editEvent({start:{dateTime:at('16:00')},end:{dateTime:at('16:30')}})
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:0,reviewed:1})
    assert.deepEqual(events.get(eventId)?.start,{dateTime:at('15:00'),timeZone:'America/New_York'})
    assert.equal((await db.prepare("SELECT conversation_state FROM requests WHERE id='thread'").first())?.conversation_state,'needs_attention')
    const deletion=editEvent({status:'cancelled'})
    changes=[deletion]
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:0,reviewed:1})
    assert.equal((await db.prepare('SELECT status FROM bookings WHERE id=?').bind(bookingId).first())?.status,'pending')
    assert.equal(events.get(eventId)?.status,'tentative')
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE event_name='calendar_sync.event_deleted' AND kind='operation'").first('n'),1)
    const deletionInvitations=invitations.length
    changes=[deletion]
    await pullCalendarChanges(env,'org',provider)
    assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE event_name='calendar_sync.event_deleted' AND kind='operation'").first('n'),1,'a repeated provider tombstone has one canonical operation')
    assert.equal(invitations.length,deletionInvitations,'repeated provider tombstones do not resend unchanged invitations')
    // An edit racing the restore is never overwritten. Its current ETag is
    // consumed on replay and the visible error clears only after reconciliation.
    racePatch={attendees:[{email:'jane@example.test',responseStatus:'accepted'},{email:'second@example.test',responseStatus:'accepted'}]}
    editEvent({attendees:[{email:'jane@example.test'},{email:'host@example.test'}]})
    await assert.rejects(pullCalendarChanges(env,'org',provider),/could not be restored/)
    assert.match((await readCalendarIntegration(db,'org'))!.last_error!,/412/)
    assert.equal((await db.prepare('SELECT assigned_member_id FROM bookings WHERE id=?').bind(bookingId).first())?.assigned_member_id,'second-org')
    assert.deepEqual(events.get(eventId)?.attendees,[{email:'jane@example.test',responseStatus:'accepted'},{email:'second@example.test',responseStatus:'accepted'}])
    await pullCalendarChanges(env,'org',provider)
    assert.equal((await readCalendarIntegration(db,'org'))?.last_error,null)
    const racedProposal=(await db.prepare("SELECT id FROM activity_entries WHERE event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1").first())!
    await respondToBookingChange(db,env,{threadId:'thread',requestId:String(racedProposal.id),decision:'decline',buyerUserId:'buyer'})

    // A delivery/configuration failure does not leave the proposed attorney
    // invited or lose the proposal's delivery retry identity after restoration.
    editEvent({attendees:[{email:'jane@example.test'},{email:'host@example.test'}]})
    await assert.rejects(pullCalendarChanges({...env,EMAIL_DELIVERY_MODE:'invalid'},'org',provider),/EMAIL_DELIVERY_MODE/)
    assert.match((await readCalendarSync(db,'org'))!.last_error!,/EMAIL_DELIVERY_MODE/)
    assert.equal((await db.prepare('SELECT assigned_member_id FROM bookings WHERE id=?').bind(bookingId).first())?.assigned_member_id,'second-org')
    assert.ok(!JSON.stringify(events.get(eventId)?.attendees).includes('host@example.test'))
    const deliveryProposal=(await db.prepare("SELECT id FROM activity_entries WHERE event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1").first())!
    assert.equal(await db.prepare("SELECT count(*) n FROM guest_thread_deliveries WHERE entry_id=? AND purpose='status_update'").bind(deliveryProposal.id).first('n'),0)
    changes=[{...events.get(eventId)!}] // Google returns the restored current resource, with its new ETag.
    await pullCalendarChanges(env,'org',provider)
    const recovered=await db.prepare("SELECT status,provider FROM guest_thread_deliveries WHERE entry_id=? AND purpose='status_update'").bind(deliveryProposal.id).first()
    assert.deepEqual(recovered,{status:'sent',provider:'log_only'})
    assert.equal((await readCalendarSync(db,'org'))?.last_error,null)
    await respondToBookingChange(db,env,{threadId:'thread',requestId:String(deliveryProposal.id),decision:'decline',buyerUserId:'buyer'})
    await setCalendarReschedules(db,'org',false)
    editEvent({start:{dateTime:at('14:00')},end:{dateTime:at('14:30')}})
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:1,reviewed:0})
    assert.equal((await db.prepare('SELECT product_session_id FROM bookings WHERE id=?').bind(bookingId).first())?.product_session_id,'s3')
    forgetPosition=true
    const position=await db.prepare('SELECT sync_token FROM google_calendar_sync').first('sync_token')
    await pullCalendarChanges(env,'org',provider)
    assert.notEqual(await db.prepare('SELECT sync_token FROM google_calendar_sync').first('sync_token'),position)
    changes=[{id:'unmanaged',status:'cancelled'}]
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:1,applied:0,reviewed:0})
    await db.prepare("UPDATE subscription SET status='canceled' WHERE id='sub-org'").run()
    changes=[{id:eventId,status:'cancelled'}]
    assert.deepEqual(await pullCalendarChanges(env,'org',provider),{events:0,applied:0,reviewed:0})
    await stopCalendarWatch(env,'org',provider)
    assert.equal(calls.filter(call=>call.endsWith('/channels/stop')).length,1)
    assert.equal(await db.prepare('SELECT count(*) n FROM google_calendar_sync').first('n'),0)
  } finally {await mf.dispose()}
})
