import assert from 'node:assert/strict'
import test from 'node:test'
import { symmetricEncrypt } from 'better-auth/crypto'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson,generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { writeMemberScheduling, readMemberScheduling, requireSchedulingAccess, refreshMemberBusy, workingWindows, selectBusyCalendars } from '../../server/domain/member-scheduling.ts'
import { claimSessionCapacity, CapacityUnavailableError } from '../../server/utils/availability.ts'
import { reassignBookingProvider } from '../../server/domain/provider-reassignment.ts'
import { storeCalendarSelection, readCalendarIntegration, disconnectCalendar, syncCalendarOrganization } from '../../server/utils/google-calendar.ts'
import { BUSY_FRESHNESS_MS, MEMBER_BUSY_SCOPES } from '../../shared/member-scheduling.ts'
import { roleSatisfies } from '../../server/utils/mcp-auth.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

test('member self-service uses Better Auth permissions, public approval is admin-only, and selected disconnected busy data fails closed for only that member', {timeout:120000},async(t)=>{
 const runtime=new Miniflare({workers:[{config:{name:'member-scheduling-proof',compatibilityDate:'2024-11-01',manifest:{mainModule:'index.mjs',modules:{'index.mjs':{type:'esm',contents:'export default {fetch(){return new Response("ok")}}'}}},env:{DB:{type:'d1'}}}}]})
 const db=await runtime.getD1Database('DB')
 try {
  await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}),await generateSQLiteDrizzleJson(schema))).map(sql=>db.prepare(sql)))
  await db.prepare(`INSERT INTO organization(id,name,slug,subdomain,settings_json,theme_id,default_currency,status,onboarding_status,url_structure,vertical,updated_at, timezone) VALUES('org','Org','org','org','{}','theme','USD','active','complete','flat','experience','2026-10-01T00:00:00.000Z', 'UTC')`).run()
  for(const id of ['owner','one','two','outsider'])await db.prepare('INSERT INTO user(id,name,email,emailVerified)VALUES(?,?,?,1)').bind(id,id,`${id}@example.test`).run()
  for(const [id,role]of [['owner','owner'],['one','member'],['two','member']])await db.prepare("INSERT INTO member(id,organizationId,userId,role)VALUES(?,'org',?,?)").bind(`member-${id}`,id,role).run()
  const env={DB:db,STRIPE_SECRET_KEY:'sk_test_local_d1_no_stripe_requests',BETTER_AUTH_URL:'https://proof.example',BETTER_AUTH_SECRET:'local-proof-secret-long-enough-for-auth',NUXT_PUBLIC_PLATFORM_DOMAIN:'https://krabiclaw.test',GOOGLE_CLIENT_ID:'test-google-client',GOOGLE_CLIENT_SECRET:'test-google-secret'} as CloudflareEnv
  const own={env,userId:'one',organizationId:'org'},owner={...own,userId:'owner'},hours={timezone:'America/New_York',weekly:Array.from({length:7},(_,weekday)=>({weekday,start:'09:00',end:'17:00'})),time_off:[],expected_updated_at:null}
  assert.equal(await roleSatisfies('org','member','member'),true)
  assert.equal(await roleSatisfies('org','member','admin'),false)
  await assert.rejects(()=>requireSchedulingAccess({...own,userId:'outsider'},'member-one'))
  await assert.rejects(()=>writeMemberScheduling(own,'member-two',hours))
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{...hours,public_approved:true}))
  const saved=await writeMemberScheduling(own,'member-one',{...hours,public_name:'Approved name',public_bio:'Public bio'})
  assert.equal(saved?.timezone,'America/New_York')
  assert.equal(saved?.public_approved,0)
  const approved=await writeMemberScheduling(owner,'member-one',{...hours,expected_updated_at:saved!.updated_at,public_approved:true})
  assert.equal((await readMemberScheduling(db,'org','member-one'))?.public_approved,1)
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{...hours,expected_updated_at:saved!.updated_at}),/changed/)
  const changed=await writeMemberScheduling(own,'member-one',{...hours,expected_updated_at:approved!.updated_at,public_name:'Changed public name'})
  assert.equal(changed?.public_approved,0,'self-edited content loses prior approval')
  await writeMemberScheduling({...own,userId:'two'},'member-two',{...hours,timezone:'UTC'})
  await db.prepare("INSERT INTO account(id,accountId,providerId,userId,scope)VALUES('busy-linked','google-subject','google','one',?)").bind(MEMBER_BUSY_SCOPES.join(' ')).run()
  const raced = await Promise.allSettled([
   selectBusyCalendars(own,'member-one',{account_id:'busy-linked',calendar_ids:['same-calendar']}),
   storeCalendarSelection(db,'org',{account_id:'busy-linked',calendar_id:'same-calendar',calendar_name:'Synthetic calendar'}),
  ])
  assert.equal(raced.filter(result=>result.status==='fulfilled').length,1,'input and output selection cannot race into the same calendar')
  const inputSelection = await readMemberScheduling(db,'org','member-one')
  const outputSelection = await readCalendarIntegration(db,'org')
  assert.equal(Number(Boolean(inputSelection?.calendar_account_id))+Number(Boolean(outputSelection)),1)
  await selectBusyCalendars(own,'member-one',{account_id:null,calendar_ids:[]})
  await disconnectCalendar(db,'org')
  await syncCalendarOrganization(env,'org')
  assert.equal((await readCalendarIntegration(db,'org'))?.status??null,outputSelection?'disabled':null)
  const accessToken=await symmetricEncrypt({key:env.BETTER_AUTH_SECRET!,data:'busy-test-token'})
  await db.prepare("UPDATE account SET accessToken=? WHERE id='busy-linked'").bind(accessToken).run()
  await selectBusyCalendars(own,'member-one',{account_id:'busy-linked',calendar_ids:['busy-calendar']})
  const distant={start:new Date(Date.now()+40*86400000).toISOString(),end:new Date(Date.now()+40*86400000+3600000).toISOString()}
  const ranges:{timeMin:string;timeMax:string}[]=[]
  let rejectLast:false|'provider'|'invalid'=false
  t.mock.method(globalThis,'fetch',async(input,init)=>{
   assert.equal(String(input),'https://www.googleapis.com/calendar/v3/freeBusy')
   assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer busy-test-token')
   const body=JSON.parse(String(init?.body))
   assert.deepEqual(body.items,[{id:'busy-calendar'}])
   ranges.push(body)
   const duration=Date.parse(body.timeMax)-Date.parse(body.timeMin)
   if(duration>31*86400000)return Response.json({error:{message:'The requested time range is too long.'}},{status:400})
   if(rejectLast&&duration<30*86400000)return rejectLast==='invalid'?new Response('not JSON',{status:502}):Response.json({error:{message:'Provider rejected the final window'}},{status:400})
   return Response.json({calendars:{'busy-calendar':{busy:Date.parse(distant.start)>=Date.parse(body.timeMin)&&Date.parse(distant.start)<Date.parse(body.timeMax)?[distant]:[]}}})
  })
  assert.equal(await refreshMemberBusy(db,env,'member-one',true),undefined)
  assert.equal(Date.parse(ranges.at(-1)!.timeMax)-Date.parse(ranges[0]!.timeMin),94*86400000)
  for(let i=1;i<ranges.length;i++)assert.equal(ranges[i]!.timeMin,ranges[i-1]!.timeMax,'busy coverage has no gaps')
  const complete=await db.prepare("SELECT busy_json,busy_from,busy_until,busy_error FROM member_scheduling WHERE member_id='member-one'").first()
  assert.deepEqual(JSON.parse(String(complete?.busy_json)),[distant])
  assert.equal(complete?.busy_error,null)
  rejectLast='provider'
  assert.equal((await refreshMemberBusy(db,env,'member-one',true))?.error,'Google busy-calendar check failed (400): Provider rejected the final window')
  const incomplete=await db.prepare("SELECT busy_json,busy_from,busy_until FROM member_scheduling WHERE member_id='member-one'").first()
  assert.deepEqual(incomplete,{busy_json:complete?.busy_json,busy_from:complete?.busy_from,busy_until:complete?.busy_until},'failed final window cannot replace complete coverage')
  const requestsAfterFailure=ranges.length
  assert.equal((await refreshMemberBusy(db,env,'member-one'))?.error,'Google busy-calendar check failed (400): Provider rejected the final window')
  assert.equal(ranges.length,requestsAfterFailure,'public reads retain the visible failed result without calling Google again during the retry interval')
  assert.equal((await readMemberScheduling(db,'org','member-one'))?.calendar_status,'error')
  rejectLast='invalid'
  assert.match((await refreshMemberBusy(db,env,'member-one',true))!.error,/^Google busy-calendar check failed \(502\): Invalid error response/)
  assert.deepEqual(await db.prepare("SELECT busy_json,busy_from,busy_until FROM member_scheduling WHERE member_id='member-one'").first(),incomplete)
  assert(ranges.length>requestsAfterFailure,'explicit Recheck bypasses the retry interval')
  rejectLast=false
  const afterRetryInterval=Date.now()+BUSY_FRESHNESS_MS
  t.mock.method(Date,'now',()=>afterRetryInterval)
  assert.equal(await refreshMemberBusy(db,env,'member-one'),undefined)
  assert.equal((await readMemberScheduling(db,'org','member-one'))?.busy_error,null,'a successful check after the interval clears the persisted error')
  t.mock.restoreAll()
  await selectBusyCalendars(own,'member-one',{account_id:null,calendar_ids:[]})
  const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10),start=`${day}T14:00:00.000Z`,end=`${day}T15:00:00.000Z`
  for(const [id,member]of [['one','member-one'],['two','member-two']]) {
   await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by)VALUES('service',?,'org',?,?,'owner','owner')").bind(id,id,id).run()
   await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by)VALUES(?,'org',?,'Standard','owner','owner')").bind(`variant-${id}`,id).run()
   await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,scheduling_mode,assigned_member_id,duration_minutes,default_capacity,held_online,created_by,updated_by)VALUES(?,'org','provider',?,60,1,1,'owner','owner')").bind(id,member).run()
   await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,assigned_member_id,timezone,starts_at,ends_at,capacity,created_by,updated_by)VALUES(?,'org',?,?,'UTC',?,?,1,'owner','owner')").bind(`session-${id}`,id,member,start,end).run()
  }
  await db.prepare("UPDATE member_scheduling SET calendar_account_id='missing-account',calendar_ids_json='[\"busy-calendar\"]',busy_checked_at=?,busy_from=?,busy_until=?,busy_error=NULL WHERE member_id='member-one'").bind(new Date().toISOString(),new Date().toISOString(),`${day}T20:00:00.000Z`).run()
  const failed=await refreshMemberBusy(db,env,'member-one',true)
  assert(failed?.error)
  assert((await readMemberScheduling(db,'org','member-one'))?.busy_error)
  await assert.rejects(()=>claimSessionCapacity(db,{organizationId:'org',productId:'one',sessionId:'session-one',productVariantId:'variant-one',partySize:1}),CapacityUnavailableError)
  const healthy=await claimSessionCapacity(db,{organizationId:'org',productId:'two',sessionId:'session-two',productVariantId:'variant-two',partySize:1})
  assert.equal(await db.prepare('SELECT assigned_member_id FROM bookings WHERE id=?').bind(healthy.bookingId).first('assigned_member_id'),'member-two')
  await db.prepare("UPDATE member_scheduling SET calendar_account_id=NULL WHERE member_id='member-one'").run()
  assert((await claimSessionCapacity(db,{organizationId:'org',productId:'one',sessionId:'session-one',productVariantId:'variant-one',partySize:1})).bookingId)
  await db.prepare("UPDATE member_scheduling SET calendar_account_id='busy-linked',busy_json=? WHERE member_id='member-one'").bind(JSON.stringify([{start,end}])).run()
  const laterConflict = await readMemberScheduling(db,'org','member-one')
  assert.equal(laterConflict?.calendar_conflict_count,1)
  assert.deepEqual(laterConflict?.calendar_conflicts,[{session_id:'session-one',starts_at:start,ends_at:end,booking_count:1}])
  assert.equal(await db.prepare("SELECT status FROM bookings WHERE product_session_id='session-one'").first('status'),'confirmed','later busy conflicts remain visible without cancelling the booking')
  await selectBusyCalendars(own,'member-one',{account_id:null,calendar_ids:[]})
  assert.equal((await readMemberScheduling(db,'org','member-one'))?.calendar_conflict_count,0)
  const following=new Date(Date.parse(start)+86400000).toISOString(),followingEnd=new Date(Date.parse(end)+86400000).toISOString()
  await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,assigned_member_id,timezone,starts_at,ends_at,capacity,created_by,updated_by)VALUES('group','org','two','member-two','UTC',?,?,3,'owner','owner')").bind(following,followingEnd).run()
  const group=await Promise.all([1,2].map(()=>claimSessionCapacity(db,{organizationId:'org',productId:'two',sessionId:'group',productVariantId:'variant-two',partySize:1})))
  const revision=await db.prepare('SELECT updated_at FROM bookings WHERE id=?').bind(group[0].bookingId).first<string>('updated_at')
  await assert.rejects(()=>reassignBookingProvider(own,{booking_id:group[0].bookingId,member_id:'member-one',expected_updated_at:revision!,idempotency_key:'self-reassignment'}))
  const move={booking_id:group[0].bookingId,member_id:'member-one',expected_updated_at:revision!,idempotency_key:'group-reassignment'}
  await reassignBookingProvider(owner,move)
  await reassignBookingProvider(owner,move)
  const members=await db.prepare("SELECT id,assigned_member_id FROM bookings WHERE product_session_id='group' ORDER BY id").all<{id:string;assigned_member_id:string}>()
  assert.deepEqual(members.results.map(row=>row.id).sort(),group.map(row=>row.bookingId).sort(),'whole Session reassignment preserves every Booking ID')
  assert(members.results.every(row=>row.assigned_member_id==='member-one'))
  const audit=await db.prepare("SELECT payload_json FROM activity_entries WHERE dedupe_key='provider:org:group-reassignment'").first<string>('payload_json')
  assert.equal(JSON.parse(audit!).old_member_id,'member-two')
  assert.equal(JSON.parse(audit!).new_member_id,'member-one')
  assert.equal(JSON.parse(audit!).actor_user_id,'owner')
  assert.equal(await db.prepare("SELECT assigned_member_id FROM product_booking_configs WHERE product_id='two'").first('assigned_member_id'),'member-two','moving one booking leaves the service with its provider')
  await assert.rejects(()=>reassignBookingProvider(owner,{...move,idempotency_key:'already-there'}),/already with that team member/)
  const occupiedRevision=await db.prepare('SELECT updated_at FROM bookings WHERE id=?').bind(healthy.bookingId).first<string>('updated_at')
  await assert.rejects(()=>reassignBookingProvider(owner,{booking_id:healthy.bookingId,member_id:'member-one',expected_updated_at:occupiedRevision!,idempotency_key:'overlap-refused'}),/isn’t free at this time/)
  assert.equal(await db.prepare('SELECT assigned_member_id FROM bookings WHERE id=?').bind(healthy.bookingId).first('assigned_member_id'),'member-two')
  const movedRevision=await db.prepare('SELECT updated_at FROM bookings WHERE id=?').bind(group[0].bookingId).first<string>('updated_at')
  assert.deepEqual(await reassignBookingProvider(owner,{...move,member_id:'member-two',expected_updated_at:movedRevision!,idempotency_key:'later-reassignment'}),{session_id:'group',assigned_member_id:'member-two'})
  await assert.rejects(()=>reassignBookingProvider(owner,move),error=>error instanceof Error && 'statusCode' in error && error.statusCode===409 && /superseded/.test(error.message))
  const currentAssignments=await db.prepare("SELECT id,assigned_member_id FROM bookings WHERE product_session_id='group' ORDER BY id").all<{id:string;assigned_member_id:string}>()
  assert.deepEqual(currentAssignments.results.map(row=>row.id).sort(),group.map(row=>row.bookingId).sort())
  assert(currentAssignments.results.every(row=>row.assigned_member_id==='member-two'),'an older replay does not restore its superseded assignment')
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE event_name='booking.reassign' AND scope_kind='organization'").first('n'),2)

 }finally{await runtime.dispose()}
})

test('member working windows retain IANA timezone across DST and merge adjacent hours',()=>{
 const {intervals}=workingWindows('America/New_York',[{weekday:1,start:'09:00',end:'12:00'},{weekday:1,start:'12:00',end:'17:00'}],new Date('2026-10-26T00:00:00.000Z'))
 assert(intervals.some(i=>i.start==='2026-10-26T13:00:00.000Z'&&i.end==='2026-10-26T21:00:00.000Z'))
 assert(intervals.some(i=>i.start==='2026-11-02T14:00:00.000Z'&&i.end==='2026-11-02T22:00:00.000Z'))
 assert.throws(()=>workingWindows('America/New_York',[{weekday:0,start:'01:30',end:'03:30'}],new Date('2026-10-26T00:00:00.000Z')),/multiple|ambiguous/i)
 assert.throws(()=>workingWindows('America/New_York',[{weekday:0,start:'02:30',end:'03:30'}],new Date('2027-03-01T00:00:00.000Z')),/exist|invalid/i)
})
