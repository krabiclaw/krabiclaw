import assert from 'node:assert/strict'
import { OPEN_TERMS_JSON } from './support/booking-terms.ts'
import test from 'node:test'
import { symmetricEncrypt } from 'better-auth/crypto'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson,generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { writeMemberScheduling, readMemberScheduling, memberSchedulingList, requireSchedulingAccess, workingWindows, selectBusyCalendars } from '../../server/domain/member-scheduling.ts'
import { claimSessionCapacity, listBookableSessions } from '../../server/utils/availability.ts'
import { handleBookingsTools } from '../../server/utils/mcp-tools/bookings.ts'
import type { McpExecutorContext } from '../../server/utils/mcp-tools/execution.ts'
import { publicProductHosts } from '../../server/utils/public-provider.ts'
import { storeCalendarSelection, readCalendarIntegration, disconnectCalendar, syncCalendarOrganization } from '../../server/utils/google-calendar.ts'
import { MEMBER_BUSY_SCOPES } from '../../shared/member-scheduling.ts'
import { roleSatisfies } from '../../server/utils/mcp-auth.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { localDateTimeToInstant } from '../../utils/timezone.ts'

test('member self-service uses Better Auth permissions, public approval is admin-only, and selected disconnected busy data fails closed for only that member', {timeout:120000},async(t)=>{
 const runtime=new Miniflare({workers:[{config:{name:'member-scheduling-proof',compatibilityDate:'2024-11-01',manifest:{mainModule:'index.mjs',modules:{'index.mjs':{type:'esm',contents:'export class Hub {fetch(){return new Response(null,{status:204})}} export default {fetch(){return new Response("ok")}}'}}},exports:{Hub:{type:'durable-object',storage:'sqlite'}},env:{DB:{type:'d1'},GUEST_INBOX_HUBS:{type:'durable-object',worker:'member-scheduling-proof',exportName:'Hub'}}}}]})
 const db=await runtime.getD1Database('DB')
 try {
  await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}),await generateSQLiteDrizzleJson(schema))).map(sql=>db.prepare(sql)))
  await db.prepare(`INSERT INTO organization(id,name,slug,subdomain,settings_json,theme_id,default_currency,status,onboarding_status,url_structure,vertical,updated_at, timezone) VALUES('org','Org','org','org','{}','theme','USD','active','complete','flat','experience','2026-10-01T00:00:00.000Z', 'UTC')`).run()
  // Google Calendar sync is Business; the plan is the organization's subscription.
  await db.prepare("INSERT INTO subscription(id,plan,referenceId,status,periodEnd) VALUES('sub-org','business','org','active',4070908800)").run()
  for(const id of ['owner','one','two','outsider'])await db.prepare('INSERT INTO user(id,name,email,emailVerified)VALUES(?,?,?,1)').bind(id,id,`${id}@example.test`).run()
  for(const [id,role]of [['owner','owner'],['one','member'],['two','member']])await db.prepare("INSERT INTO member(id,organizationId,userId,role)VALUES(?,'org',?,?)").bind(`member-${id}`,id,role).run()
  const env={...await runtime.getBindings<CloudflareEnv>(),EMAIL_REPLY_SECRET:'member-test-signing-secret',EMAIL_DELIVERY_MODE:'log_only',WHATSAPP_DELIVERY_MODE:'log_only',DB:db,STRIPE_SECRET_KEY:'sk_test_local_d1_no_stripe_requests',BETTER_AUTH_URL:'https://proof.example',BETTER_AUTH_SECRET:'local-proof-secret-long-enough-for-auth',NUXT_PUBLIC_PLATFORM_DOMAIN:'https://krabiclaw.test',GOOGLE_CLIENT_ID:'test-google-client',GOOGLE_CLIENT_SECRET:'test-google-secret'} as CloudflareEnv
  const own={env,userId:'one',organizationId:'org'},owner={...own,userId:'owner'},hours={timezone:'America/New_York',weekly:Array.from({length:7},(_,weekday)=>({weekday,start:'09:00',end:'17:00'})),time_off:[],updated_at:null}
  assert.equal(await roleSatisfies('org','member','member'),true)
  assert.equal(await roleSatisfies('org','member','admin'),false)
  await assert.rejects(()=>requireSchedulingAccess({...own,userId:'outsider'},'member-one'))
  await assert.rejects(()=>requireSchedulingAccess(owner,'one'),{statusCode:404,message:'Member not found'})
  await assert.rejects(()=>writeMemberScheduling(own,'member-two',hours))
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{...hours,public_approved:true}))
  assert.equal(await readMemberScheduling(db,env,'org','member-one'),null,'membership can exist before either profile or hours are saved')
  assert.deepEqual((await memberSchedulingList(owner)).members.map(({id,name})=>({id,name})).sort((a,b)=>a.id.localeCompare(b.id)),[{id:'member-one',name:'one'},{id:'member-owner',name:'owner'},{id:'member-two',name:'two'}],'members without an authored name use their account name')
  await assert.rejects(()=>memberSchedulingList({...own,userId:'outsider'}),{statusCode:403,message:'Membership required'})
  const initialInvalidations=await db.prepare("SELECT count(*) n FROM public_resource_cache_invalidations WHERE organization_id='org'").first('n')
  for(const public_name of [undefined,null,'','   ']) {
   await assert.rejects(()=>writeMemberScheduling(owner,'member-one',{updated_at:null,public_name,public_approved:true}),{statusCode:400,message:'Set a nonblank public name before publishing the member profile'})
   assert.equal(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),null,'invalid publication cannot create member settings')
   assert.equal(await db.prepare("SELECT count(*) n FROM public_resource_cache_invalidations WHERE organization_id='org'").first('n'),initialInvalidations)
  }
  const profile=await writeMemberScheduling(own,'member-one',{updated_at:null,public_name:'Approved name',public_bio:'Public bio'})
  assert.deepEqual((await memberSchedulingList(own)).members.map(({id,name,self})=>({id,name,self})),[{id:'member-one',name:'Approved name',self:true}],'the member sees only their own identity using the authored team-facing name')
  assert.equal((await memberSchedulingList(owner)).members.find(member=>member.id==='member-one')?.name,'Approved name','the owner sees the same authored name in assignment choices')
  assert.deepEqual({timezone:profile.timezone,weekly:profile.weekly,time_off:profile.time_off,calendar_ids:profile.calendar_ids},{timezone:null,weekly:null,time_off:null,calendar_ids:[]})
  const profileRow=await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first()
  for(const field of ['timezone','weekly_json','time_off_json'])assert.equal(profileRow?.[field],null,'a profile does not fabricate working facts')
  await assert.rejects(db.prepare("UPDATE member_scheduling SET timezone='UTC' WHERE member_id='member-one'").run(),/member_scheduling_hours_check/)
  await assert.rejects(db.prepare("UPDATE member_scheduling SET weekly_json='[]' WHERE member_id='member-one'").run(),/member_scheduling_hours_check/)
  await assert.rejects(()=>selectBusyCalendars(own,'member-one',{account_id:null,calendar_ids:[]}),{statusCode:409,message:'Save member hours first before selecting busy-input calendars'})
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{updated_at:profile.updated_at,timezone:'UTC'}),/together the first time/)
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{updated_at:profile.updated_at,weekly:[]}),/together the first time/)
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{updated_at:profile.updated_at,timezone:null} as unknown as Parameters<typeof writeMemberScheduling>[2]),/IANA timezone/)
  await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by)VALUES('experience','profile-host','org','Authored host','profile-host','owner','owner')").run()
  await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,scheduling_mode,assigned_member_id,created_by,updated_by)VALUES('profile-host','org','slot','business','member-one','owner','owner')").run()
  assert.deepEqual(await publicProductHosts(db,'org','profile-host'),[],'draft content is withheld from the public host read')
  for(const public_name of [null,'','   ']) {
   await assert.rejects(()=>writeMemberScheduling(owner,'member-one',{updated_at:profile.updated_at,public_name,public_approved:true}),{statusCode:400,message:'Set a nonblank public name before publishing the member profile'})
   assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),profileRow,'invalid publication preserves the complete profile-only row')
  }
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{updated_at:profile.updated_at,public_approved:true}),{statusCode:403})
  assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),profileRow,'self approval is refused without a write')
  const publishedProfile=await writeMemberScheduling(owner,'member-one',{updated_at:profile.updated_at,public_approved:true})
  assert.deepEqual(await publicProductHosts(db,'org','profile-host'),[{name:'Approved name',photo_url:null,bio:'Public bio'}],'a published host profile does not require provider hours')
  const saved=await writeMemberScheduling(own,'member-one',{...hours,updated_at:publishedProfile.updated_at,public_name:'Approved name',public_bio:'Public bio',public_photo_url:null})
  assert.equal(saved?.timezone,'America/New_York')
  assert.equal(saved?.public_approved,1,'unchanged profile facts retain approval when hours are authored')
  const authoredRow=await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first()
  await assert.rejects(()=>writeMemberScheduling(owner,'member-one',{updated_at:publishedProfile.updated_at,public_bio:'Stale profile edit after hours changed'}),{statusCode:409,message:'Member settings changed; reload before saving'})
  assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),authoredRow,'hours and public profile share one revision')
  const clock=t.mock.method(Date,'now',()=>Date.parse(saved.updated_at))
  const approved=await writeMemberScheduling(owner,'member-one',{...hours,updated_at:saved!.updated_at,public_approved:true})
  assert.equal(Date.parse(approved.updated_at),Date.parse(saved.updated_at)+1,'the revision advances even within the same millisecond')
  clock.mock.restore()
  assert.equal((await readMemberScheduling(db,env,'org','member-one'))?.public_approved,1)
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{...hours,updated_at:saved!.updated_at}),/changed/)
  const changed=await writeMemberScheduling(own,'member-one',{...hours,updated_at:approved!.updated_at,public_name:'Changed public name'})
  assert.equal(changed?.public_approved,0,'self-edited content loses prior approval')
  assert.deepEqual(await publicProductHosts(db,'org','profile-host'),[],'editing approved host content withholds it until approval')
  const beforeConflict=await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first()
  const invalidations=async()=>Number(await db.prepare("SELECT count(*) n FROM public_resource_cache_invalidations WHERE organization_id='org'").first('n'))
  const beforeInvalidations=await invalidations()
  await db.prepare("CREATE TRIGGER skip_member_settings BEFORE UPDATE ON member_scheduling WHEN OLD.member_id='member-one' BEGIN SELECT RAISE(IGNORE); END").run()
  try {
   await assert.rejects(()=>writeMemberScheduling(own,'member-one',{updated_at:changed.updated_at,public_bio:'Rejected edit'}),{statusCode:409,message:'Member settings changed; reload before saving'})
   assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),beforeConflict)
   assert.equal(await invalidations(),beforeInvalidations,'a zero-write conflict cannot commit a cache invalidation')
  } finally {await db.prepare('DROP TRIGGER skip_member_settings').run()}
  const racedProfile=await Promise.allSettled(['First profile edit','Second profile edit'].map(public_bio=>writeMemberScheduling(own,'member-one',{updated_at:changed.updated_at,public_bio})))
  assert.equal(racedProfile.filter(result=>result.status==='fulfilled').length,1)
  const refusedProfile=racedProfile.find(result=>result.status==='rejected') as PromiseRejectedResult
  assert.equal(refusedProfile.reason.statusCode,409)
  const winningProfile=(racedProfile.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof writeMemberScheduling>>>).value
  assert.equal(await db.prepare("SELECT public_bio FROM member_scheduling WHERE member_id='member-one'").first('public_bio'),winningProfile.public_bio)
  assert.equal(await invalidations(),beforeInvalidations+1)
  await writeMemberScheduling({...own,userId:'two'},'member-two',{...hours,timezone:'UTC'})
  await db.prepare("INSERT INTO account(id,accountId,providerId,userId,scope)VALUES('busy-linked','google-subject','google','one',?)").bind(MEMBER_BUSY_SCOPES.join(',')).run()
  const raced = await Promise.allSettled([
   selectBusyCalendars(own,'member-one',{account_id:'busy-linked',calendar_ids:['same-calendar']}),
   storeCalendarSelection(db,'org',{account_id:'busy-linked',calendar_id:'same-calendar',calendar_name:'Synthetic calendar'}),
  ])
  assert.equal(raced.filter(result=>result.status==='fulfilled').length,1,'input and output selection cannot race into the same calendar')
  const inputSelection = await readMemberScheduling(db,env,'org','member-one')
  const outputSelection = await readCalendarIntegration(db,'org')
  assert.equal(Number(Boolean(inputSelection?.calendar_account_id))+Number(Boolean(outputSelection)),1)
  await selectBusyCalendars(own,'member-one',{account_id:null,calendar_ids:[]})
  await disconnectCalendar(db,'org')
  await syncCalendarOrganization(env,'org')
  assert.equal((await readCalendarIntegration(db,'org'))?.status??null,outputSelection?'disabled':null)
  const accessToken=await symmetricEncrypt({key:env.BETTER_AUTH_SECRET!,data:'busy-test-token'})
  await db.prepare("UPDATE account SET accessToken=? WHERE id='busy-linked'").bind(accessToken).run()
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
  // Selecting the calendars reads them back through Google at once.
  await selectBusyCalendars(own,'member-one',{account_id:'busy-linked',calendar_ids:['busy-calendar']})
  ranges.length=0
  const storedBeforeRead=await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first()
  const ready=await readMemberScheduling(db,env,'org','member-one')
  assert.equal(ready?.calendar_status,'ready','a member read asks Google for the horizon ahead')
  assert.equal(Date.parse(ranges.at(-1)!.timeMax)-Date.parse(ranges[0]!.timeMin),94*86400000)
  for(let i=1;i<ranges.length;i++)assert.equal(ranges[i]!.timeMin,ranges[i-1]!.timeMax,'busy coverage has no gaps')
  assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),storedBeforeRead,'nothing Google said is stored')
  rejectLast='provider'
  await assert.rejects(()=>readMemberScheduling(db,env,'org','member-one'),{statusCode:502,message:'Google busy-calendar check failed (400)'},'a window Google refuses fails the read')
  rejectLast='invalid'
  await assert.rejects(()=>readMemberScheduling(db,env,'org','member-one'),{statusCode:502,message:'Google busy-calendar check failed (502)'})
  rejectLast=false
  t.mock.restoreAll()
  await selectBusyCalendars(own,'member-one',{account_id:null,calendar_ids:[]})
  const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10),start=`${day}T14:00:00.000Z`,end=`${day}T15:00:00.000Z`
  for(const [id,member]of [['one','member-one'],['two','member-two']]) {
   await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by)VALUES('experience',?,'org',?,?,'owner','owner')").bind(id,id,id).run()
   await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by)VALUES(?,'org',?,'Standard','owner','owner')").bind(`variant-${id}`,id).run()
   await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,scheduling_mode,assigned_member_id,duration_minutes,default_capacity,held_online,created_by,updated_by)VALUES(?,'org','slot','provider',?,60,1,1,'owner','owner')").bind(id,member).run()
   await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,timezone,starts_at,ends_at,capacity,created_by,updated_by)VALUES(?,'org',?,'UTC',?,?,1,'owner','owner')").bind(`session-${id}`,id,start,end).run()
  }
  const stable=()=>db.prepare("SELECT timezone,weekly_json,time_off_json,calendar_account_id,calendar_ids_json FROM member_scheduling WHERE member_id='member-one'").first()
  const stableBefore=await stable()
  const sessionsBefore=(await db.prepare('SELECT * FROM product_sessions ORDER BY id').all()).results
  const current=await readMemberScheduling(db,env,'org','member-one')
  const profileOnly=await writeMemberScheduling(own,'member-one',{updated_at:current!.updated_at,public_bio:null})
  assert.equal(profileOnly.public_bio,null,'explicit null clears the profile field')
  assert.deepEqual(await stable(),stableBefore,'profile edits retain all schedule, window and calendar bytes')
  assert.deepEqual((await db.prepare('SELECT * FROM product_sessions ORDER BY id').all()).results,sessionsBefore,'profile saves never materialize sessions')
  const shorterHours=profileOnly.weekly!.map(slot=>({...slot,end:'16:00'}))
  const fromInstant=localDateTimeToInstant(day,'16:00',profileOnly.timezone!).toISOString()
  const toInstant=localDateTimeToInstant(day,'17:00',profileOnly.timezone!).toISOString()
  const readLateOpening=()=>listBookableSessions(db,{env,organizationId:'org',productId:'one',locationId:null,fromInstant,toInstant})
  const availableBefore=await readLateOpening()
  assert.deepEqual(availableBefore.map(session=>[session.starts_at,session.remaining,session.created_at]),[[fromInstant,1,null]])
  const beforeHoursInvalidations=await invalidations()
  await db.prepare("CREATE TRIGGER refuse_member_invalidation BEFORE INSERT ON public_resource_cache_invalidations WHEN NEW.organization_id='org' AND NEW.reason='member-profile' BEGIN SELECT RAISE(ABORT,'Injected member settings invalidation failure'); END").run()
  try {
   await assert.rejects(()=>writeMemberScheduling(own,'member-one',{updated_at:profileOnly.updated_at,weekly:shorterHours}),/Injected member settings invalidation failure/)
   assert.deepEqual(await readMemberScheduling(db,env,'org','member-one'),profileOnly,'an invalidation failure rolls back the Hours change and revision')
   assert.equal(await invalidations(),beforeHoursInvalidations)
   assert.deepEqual(await readLateOpening(),availableBefore,'the previous Hours still determine availability after rollback')
   assert.deepEqual((await db.prepare('SELECT * FROM product_sessions ORDER BY id').all()).results,sessionsBefore)
  } finally {await db.prepare('DROP TRIGGER refuse_member_invalidation').run()}
  const savedHours=await writeMemberScheduling(own,'member-one',{updated_at:profileOnly.updated_at,weekly:shorterHours})
  assert.deepEqual((await readMemberScheduling(db,env,'org','member-one'))?.weekly,shorterHours)
  assert.equal(await invalidations(),beforeHoursInvalidations+1)
  assert.deepEqual(await readLateOpening(),[],'the shortened Hours immediately remove the late opening')
  const savedBytes=await stable()
  await writeMemberScheduling(own,'member-one',{updated_at:savedHours.updated_at,timezone:savedHours.timezone!,weekly:savedHours.weekly!,time_off:savedHours.time_off!})
  assert.deepEqual(await stable(),savedBytes,'unchanged Hours retain all window and calendar bytes')
  assert.deepEqual((await db.prepare('SELECT * FROM product_sessions ORDER BY id').all()).results,sessionsBefore,'Hours edits and availability reads preserve saved sessions')
  await db.prepare("UPDATE member_scheduling SET calendar_account_id='missing-account',calendar_ids_json='[\"busy-calendar\"]' WHERE member_id='member-one'").run()
  const unreadable=await readMemberScheduling(db,env,'org','member-one')
  assert.equal(unreadable?.calendar_status,'disconnected')
  // A calendar that cannot be read fails the claim visibly instead of guessing the member is free.
  await assert.rejects(()=>claimSessionCapacity(db,{policyJson: OPEN_TERMS_JSON, env,organizationId:'org',productId:'one',sessionId:'session-one',productVariantId:'variant-one',partySize:1}),{message:'The account this integration was connected through is no longer linked. Connect it again.'})
  assert.equal(await db.prepare("SELECT count(*) n FROM bookings WHERE product_session_id='session-one'").first('n'),0)
  // Cancelling an unbooked session asks no calendar, so an unreadable one does not stand in the way, nor does another scheduled session of the same offering at the same time.
  await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,timezone,starts_at,ends_at,capacity,created_by,updated_by)VALUES('session-one-b','org','one','UTC',?,?,1,'owner','owner')").bind(`${day}T14:30:00.000Z`,`${day}T15:30:00.000Z`).run()
  const sessionOne=await db.prepare("SELECT updated_at FROM product_sessions WHERE id='session-one'").first<string>('updated_at')
  const mcpOrganization={db,env,organizationId:'org',userId:'owner',role:'owner',isPlatformAdmin:false,scopes:['tenant'],membership:{id:'member-owner',organizationId:'org',userId:'owner',role:'owner'}} as McpExecutorContext['organization']
  const cancelled=await handleBookingsTools({toolName:'update_product_session',args:{product_id:'one',product_session_id:'session-one',updated_at:sessionOne,status:'cancelled'},organization:mcpOrganization} as McpExecutorContext) as {session:{status:string}}
  assert.equal(cancelled.session.status,'cancelled')
  assert.equal(await db.prepare("SELECT status FROM product_sessions WHERE id='session-one'").first('status'),'cancelled')
  await db.prepare("DELETE FROM product_sessions WHERE id='session-one-b'").run()
  await db.prepare("UPDATE product_sessions SET status='scheduled' WHERE id='session-one'").run()
  const healthy=await claimSessionCapacity(db,{policyJson: OPEN_TERMS_JSON, env,organizationId:'org',productId:'two',sessionId:'session-two',productVariantId:'variant-two',partySize:1})
  assert.equal(await db.prepare('SELECT c.assigned_member_id FROM bookings b JOIN product_booking_configs c ON c.product_id=b.product_id AND c.organization_id=b.organization_id WHERE b.id=?').bind(healthy.bookingId).first('assigned_member_id'),'member-two','a booking is its offering\'s member\'s')
  await db.prepare("UPDATE member_scheduling SET calendar_account_id=NULL WHERE member_id='member-one'").run()
  assert((await claimSessionCapacity(db,{policyJson: OPEN_TERMS_JSON, env,organizationId:'org',productId:'one',sessionId:'session-one',productVariantId:'variant-one',partySize:1})).bookingId)
  await db.prepare("UPDATE member_scheduling SET calendar_account_id='busy-linked' WHERE member_id='member-one'").run()
  t.mock.method(globalThis,'fetch',async(input)=>{assert.equal(String(input),'https://www.googleapis.com/calendar/v3/freeBusy');return Response.json({calendars:{'busy-calendar':{busy:[{start,end}]}}})})
  const laterConflict = await readMemberScheduling(db,env,'org','member-one')
  assert.equal(laterConflict?.calendar_conflict_count,1)
  assert.deepEqual(laterConflict?.calendar_conflicts,[{session_id:'session-one',starts_at:start,ends_at:end,booking_count:1}])
  assert.equal(await db.prepare("SELECT status FROM bookings WHERE product_session_id='session-one'").first('status'),'confirmed','later busy conflicts remain visible without cancelling the booking')
  await selectBusyCalendars(own,'member-one',{account_id:null,calendar_ids:[]})
  t.mock.restoreAll()
  assert.equal((await readMemberScheduling(db,env,'org','member-one'))?.calendar_conflict_count,0)
 }finally{await runtime.dispose()}
})

test('member working windows retain IANA timezone across DST and merge adjacent hours',()=>{
 const span={from:new Date('2026-10-26T00:00:00.000Z'),until:new Date('2027-10-31T00:00:00.000Z')}
 const intervals=workingWindows('America/New_York',[{weekday:1,start:'09:00',end:'12:00'},{weekday:1,start:'12:00',end:'17:00'}],span)
 assert(intervals.some(i=>i.start==='2026-10-26T13:00:00.000Z'&&i.end==='2026-10-26T21:00:00.000Z'))
 assert(intervals.some(i=>i.start==='2026-11-02T14:00:00.000Z'&&i.end==='2026-11-02T22:00:00.000Z'))
 assert.throws(()=>workingWindows('America/New_York',[{weekday:0,start:'01:30',end:'03:30'}],span),{ message: 'On 2026-11-01, the clocks change during these hours. Choose a different start or end time.' })
 assert.throws(()=>workingWindows('America/New_York',[{weekday:0,start:'02:30',end:'03:30'}],{from:new Date('2027-03-01T00:00:00.000Z'),until:new Date('2027-04-01T00:00:00.000Z')}),{ message: 'On 2027-03-14, the clocks change during these hours. Choose a different start or end time.' })
})
