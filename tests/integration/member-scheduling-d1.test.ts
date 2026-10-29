import assert from 'node:assert/strict'
import test from 'node:test'
import { symmetricEncrypt } from 'better-auth/crypto'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson,generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { writeMemberScheduling, readMemberScheduling, requireSchedulingAccess, refreshMemberBusy, refreshWorkingWindows, workingWindows, selectBusyCalendars } from '../../server/domain/member-scheduling.ts'
import { claimSessionCapacity, CapacityUnavailableError } from '../../server/utils/availability.ts'
import { publicProductHosts } from '../../server/utils/public-provider.ts'
import { requestInsertQueries, threadPayloadForGuest, getGuestRequest } from '../../server/domain/requests.ts'
import { formatTimestamp } from '../../utils/timezone.ts'
import { listGuestThreads, listOrganizationGuestThreads } from '../../server/domain/guest-threads/repository.ts'
import { getGuestThreadDetail } from '../../server/domain/guest-threads/detail.ts'
import { executeGuestThreadOperation } from '../../server/domain/guest-threads/operations.ts'
import { memberAccessPrincipal, resolveOrganizationMembership } from '../../server/utils/member-access.ts'
import { respondToBookingChange, bookingChangeViews } from '../../server/domain/guest-threads/booking-changes.ts'
import { reassignBookingProvider } from '../../server/domain/provider-reassignment.ts'
import { storeCalendarSelection, readCalendarIntegration, disconnectCalendar, syncCalendarOrganization } from '../../server/utils/google-calendar.ts'
import { BUSY_FRESHNESS_MS, MEMBER_BUSY_SCOPES } from '../../shared/member-scheduling.ts'
import { roleSatisfies } from '../../server/utils/mcp-auth.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

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
  const own={env,userId:'one',organizationId:'org'},owner={...own,userId:'owner'},hours={timezone:'America/New_York',weekly:Array.from({length:7},(_,weekday)=>({weekday,start:'09:00',end:'17:00'})),time_off:[],expected_updated_at:null}
  assert.equal(await roleSatisfies('org','member','member'),true)
  assert.equal(await roleSatisfies('org','member','admin'),false)
  await assert.rejects(()=>requireSchedulingAccess({...own,userId:'outsider'},'member-one'))
  await assert.rejects(()=>requireSchedulingAccess(owner,'one'),{statusCode:404,message:'Member not found'})
  await assert.rejects(()=>writeMemberScheduling(own,'member-two',hours))
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{...hours,public_approved:true}))
  assert.equal(await readMemberScheduling(db,'org','member-one'),null,'membership can exist before either profile or hours are saved')
  const initialInvalidations=await db.prepare("SELECT count(*) n FROM public_resource_cache_invalidations WHERE organization_id='org'").first('n')
  for(const public_name of [undefined,null,'','   ']) {
   await assert.rejects(()=>writeMemberScheduling(owner,'member-one',{expected_updated_at:null,public_name,public_approved:true}),{statusCode:400,message:'Set a nonblank public name before publishing the member profile'})
   assert.equal(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),null,'invalid publication cannot create member settings')
   assert.equal(await db.prepare("SELECT count(*) n FROM public_resource_cache_invalidations WHERE organization_id='org'").first('n'),initialInvalidations)
  }
  const profile=await writeMemberScheduling(own,'member-one',{expected_updated_at:null,public_name:'Approved name',public_bio:'Public bio'})
  assert.deepEqual({timezone:profile.timezone,weekly:profile.weekly,time_off:profile.time_off,calendar_ids:profile.calendar_ids},{timezone:null,weekly:null,time_off:null,calendar_ids:[]})
  const profileRow=await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first()
  for(const field of ['timezone','weekly_json','time_off_json','windows_json','windows_until'])assert.equal(profileRow?.[field],null,'a profile does not fabricate working facts')
  await assert.rejects(db.prepare("UPDATE member_scheduling SET timezone='UTC' WHERE member_id='member-one'").run(),/member_scheduling_hours_check/)
  await assert.rejects(db.prepare("UPDATE member_scheduling SET weekly_json='[]' WHERE member_id='member-one'").run(),/member_scheduling_hours_check/)
  await refreshWorkingWindows(db)
  assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),profileRow,'window refresh excludes profile-only members')
  await assert.rejects(()=>selectBusyCalendars(own,'member-one',{account_id:null,calendar_ids:[]}),{statusCode:409,message:'Save member hours first before selecting busy-input calendars'})
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{expected_updated_at:profile.updated_at,timezone:'UTC'}),/together the first time/)
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{expected_updated_at:profile.updated_at,weekly:[]}),/together the first time/)
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{expected_updated_at:profile.updated_at,timezone:null} as unknown as Parameters<typeof writeMemberScheduling>[2]),/IANA timezone/)
  await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by)VALUES('experience','profile-host','org','Authored host','profile-host','owner','owner')").run()
  await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,assigned_member_id,created_by,updated_by)VALUES('profile-host','org','member-one','owner','owner')").run()
  assert.deepEqual(await publicProductHosts(db,'org','profile-host'),[],'draft content is withheld from the public host read')
  for(const public_name of [null,'','   ']) {
   await assert.rejects(()=>writeMemberScheduling(owner,'member-one',{expected_updated_at:profile.updated_at,public_name,public_approved:true}),{statusCode:400,message:'Set a nonblank public name before publishing the member profile'})
   assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),profileRow,'invalid publication preserves the complete profile-only row')
  }
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{expected_updated_at:profile.updated_at,public_approved:true}),{statusCode:403})
  assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),profileRow,'self approval is refused without a write')
  const publishedProfile=await writeMemberScheduling(owner,'member-one',{expected_updated_at:profile.updated_at,public_approved:true})
  assert.deepEqual(await publicProductHosts(db,'org','profile-host'),[{name:'Approved name',photo_url:null,bio:'Public bio'}],'a published host profile does not require provider hours')
  const saved=await writeMemberScheduling(own,'member-one',{...hours,expected_updated_at:publishedProfile.updated_at,public_name:'Approved name',public_bio:'Public bio',public_photo_url:null})
  assert.equal(saved?.timezone,'America/New_York')
  assert.equal(saved?.public_approved,1,'unchanged profile facts retain approval when hours are authored')
  const authoredRow=await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first()
  await assert.rejects(()=>writeMemberScheduling(owner,'member-one',{expected_updated_at:publishedProfile.updated_at,public_bio:'Stale profile edit after hours changed'}),{statusCode:409,message:'Member settings changed; reload before saving'})
  assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),authoredRow,'hours and public profile share one revision')
  const clock=t.mock.method(Date,'now',()=>Date.parse(saved.updated_at))
  const approved=await writeMemberScheduling(owner,'member-one',{...hours,expected_updated_at:saved!.updated_at,public_approved:true})
  assert.equal(Date.parse(approved.updated_at),Date.parse(saved.updated_at)+1,'the revision advances even within the same millisecond')
  clock.mock.restore()
  assert.equal((await readMemberScheduling(db,'org','member-one'))?.public_approved,1)
  await assert.rejects(()=>writeMemberScheduling(own,'member-one',{...hours,expected_updated_at:saved!.updated_at}),/changed/)
  const changed=await writeMemberScheduling(own,'member-one',{...hours,expected_updated_at:approved!.updated_at,public_name:'Changed public name'})
  assert.equal(changed?.public_approved,0,'self-edited content loses prior approval')
  assert.deepEqual(await publicProductHosts(db,'org','profile-host'),[],'editing approved host content withholds it until approval')
  const beforeConflict=await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first()
  const invalidations=async()=>Number(await db.prepare("SELECT count(*) n FROM public_resource_cache_invalidations WHERE organization_id='org'").first('n'))
  const beforeInvalidations=await invalidations()
  await db.prepare("CREATE TRIGGER skip_member_settings BEFORE UPDATE ON member_scheduling WHEN OLD.member_id='member-one' BEGIN SELECT RAISE(IGNORE); END").run()
  try {
   await assert.rejects(()=>writeMemberScheduling(own,'member-one',{expected_updated_at:changed.updated_at,public_bio:'Rejected edit'}),{statusCode:409,message:'Member settings changed; reload before saving'})
   assert.deepEqual(await db.prepare("SELECT * FROM member_scheduling WHERE member_id='member-one'").first(),beforeConflict)
   assert.equal(await invalidations(),beforeInvalidations,'a zero-write conflict cannot commit a cache invalidation')
  } finally {await db.prepare('DROP TRIGGER skip_member_settings').run()}
  const racedProfile=await Promise.allSettled(['First profile edit','Second profile edit'].map(public_bio=>writeMemberScheduling(own,'member-one',{expected_updated_at:changed.updated_at,public_bio})))
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
   await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by)VALUES('experience',?,'org',?,?,'owner','owner')").bind(id,id,id).run()
   await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by)VALUES(?,'org',?,'Standard','owner','owner')").bind(`variant-${id}`,id).run()
   await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,scheduling_mode,assigned_member_id,duration_minutes,default_capacity,held_online,created_by,updated_by)VALUES(?,'org','provider',?,60,1,1,'owner','owner')").bind(id,member).run()
   await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,assigned_member_id,timezone,starts_at,ends_at,capacity,created_by,updated_by)VALUES(?,'org',?,?,'UTC',?,?,1,'owner','owner')").bind(`session-${id}`,id,member,start,end).run()
  }
  const stable=()=>db.prepare("SELECT timezone,weekly_json,time_off_json,windows_json,windows_until,calendar_account_id,calendar_ids_json,calendar_revision,busy_json,busy_from,busy_until,busy_checked_at,busy_error FROM member_scheduling WHERE member_id='member-one'").first()
  const stableBefore=await stable()
  const sessionsBefore=(await db.prepare('SELECT * FROM product_sessions ORDER BY id').all()).results
  const current=await readMemberScheduling(db,'org','member-one')
  const profileOnly=await writeMemberScheduling(own,'member-one',{expected_updated_at:current!.updated_at,public_bio:null})
  assert.equal(profileOnly.public_bio,null,'explicit null clears the profile field')
  assert.deepEqual(await stable(),stableBefore,'profile edits retain all schedule, window and calendar bytes')
  assert.deepEqual((await db.prepare('SELECT * FROM product_sessions ORDER BY id').all()).results,sessionsBefore,'profile saves never materialize sessions')
  const shorterHours=profileOnly.weekly!.map(slot=>({...slot,end:'16:00'}))
  const completionStart=`${day}T16:00:00.000Z`
  await db.prepare("CREATE TRIGGER refuse_member_sessions BEFORE INSERT ON product_sessions WHEN NEW.product_id='one' BEGIN SELECT RAISE(ABORT,'Injected session completion failure'); END").run()
  let afterFailedProfile:Awaited<ReturnType<typeof writeMemberScheduling>>|null=null
  try {
   await assert.rejects(()=>writeMemberScheduling(own,'member-one',{expected_updated_at:profileOnly.updated_at,weekly:shorterHours}),/Injected session completion failure/)
   const pending=await readMemberScheduling(db,'org','member-one')
   assert.deepEqual(pending!.weekly,shorterHours,'the reported failure can follow a persisted Hours change')
   assert.deepEqual((await db.prepare('SELECT * FROM product_sessions ORDER BY id').all()).results,sessionsBefore,'a failed session batch commits no partial slots')
   const pendingBytes=await stable()
   afterFailedProfile=await writeMemberScheduling(own,'member-one',{expected_updated_at:pending!.updated_at,public_bio:'Profile after a visible Hours failure'})
   assert.deepEqual(await stable(),pendingBytes,'a profile edit does not complete or change pending Hours work')
   assert.deepEqual((await db.prepare('SELECT * FROM product_sessions ORDER BY id').all()).results,sessionsBefore)
  } finally {await db.prepare('DROP TRIGGER refuse_member_sessions').run()}
  assert(afterFailedProfile)
  const completed=await writeMemberScheduling(own,'member-one',{expected_updated_at:afterFailedProfile.updated_at,weekly:shorterHours})
  const completedSlot=await db.prepare("SELECT assigned_member_id,status FROM product_sessions WHERE product_id='one' AND starts_at=?").bind(completionStart).first()
  assert.deepEqual(completedSlot,{assigned_member_id:'member-one',status:'scheduled'},'an explicit unchanged Hours retry finishes canonical session materialization')
  const completedBytes=await stable()
  const completedSessions=(await db.prepare('SELECT * FROM product_sessions ORDER BY id').all()).results
  await writeMemberScheduling(own,'member-one',{expected_updated_at:completed.updated_at,timezone:completed.timezone!,weekly:completed.weekly!,time_off:completed.time_off!})
  assert.deepEqual(await stable(),completedBytes,'unchanged Hours retain all window and calendar bytes')
  assert.deepEqual((await db.prepare('SELECT * FROM product_sessions ORDER BY id').all()).results,completedSessions,'idempotent Hours completion retains every persisted session byte')
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
  const following=new Date(Date.parse(start)+14*86400000).toISOString(),followingEnd=new Date(Date.parse(end)+14*86400000).toISOString()
  await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,assigned_member_id,timezone,starts_at,ends_at,capacity,created_by,updated_by)VALUES('group','org','two','member-two','UTC',?,?,3,'owner','owner')").bind(following,followingEnd).run()
  await db.prepare("INSERT INTO organization_locales(id,organization_id,locale,is_source,status)VALUES('org-en','org','en',1,'published')").run()
  await db.prepare("INSERT INTO team(id,name,organizationId,createdAt)VALUES('attorneys','Attorneys','org',?)").bind(Date.now()).run()
  for (const id of ['one','two']) await db.prepare("INSERT INTO teamMember(id,teamId,userId,createdAt)VALUES(?,'attorneys',?,?)").bind(`attorney-${id}`,id,Date.now()).run()
  await db.prepare("UPDATE products SET kind='service' WHERE id='two'").run()
  await db.prepare("UPDATE product_booking_configs SET assigned_member_id=NULL,assigned_team_id='attorneys',default_capacity=3 WHERE product_id='two'").run()
  await db.prepare("UPDATE member_scheduling SET public_name=member_id,public_approved=1 WHERE member_id IN ('member-one','member-two')").run()
  const group=[]
  for (const index of [0,1]) {
   const requestId=`client-${index}`,now=new Date().toISOString()
   const queries=requestInsertQueries({id:requestId,kind:'booking',organization_id:'org',location_id:null,user_id:'outsider',review_id:null,conversation_state:'needs_attention',resolved_at:null,payload:threadPayloadForGuest({name:'Client',email:'outsider@example.test',phone:null}),created_at:now,updated_at:now})
   await db.batch(queries.map(query=>db.prepare(query.query).bind(...query.params!)))
   group.push(await claimSessionCapacity(db,{organizationId:'org',productId:'two',sessionId:'group',productVariantId:'variant-two',partySize:1,requestId,userId:'outsider'}))
  }
  const read=()=>db.prepare('SELECT id,product_session_id,assigned_member_id,updated_at FROM bookings WHERE id=?').bind(group[0]!.bookingId).first<{id:string;product_session_id:string;assigned_member_id:string;updated_at:string}>()
  const original=await read()
  const move={booking_id:group[0]!.bookingId,member_id:'member-one',expected_updated_at:original!.updated_at,idempotency_key:'client-attorney-change'}
  await assert.rejects(()=>reassignBookingProvider(own,move),{statusCode:403})
  const pending=await reassignBookingProvider(owner,move)
  assert.equal(pending.change_status,'awaiting_guest_acceptance')
  assert.deepEqual(await read(),original,'a proposed same-time attorney replacement preserves the actual appointment')
  assert.deepEqual(await reassignBookingProvider(owner,move),pending,'replaying a pending request retains one proposal')
  const proposal=await db.prepare("SELECT * FROM activity_entries WHERE request_id='client-0' AND event_name='booking_change.requested'").first<import('../../server/domain/guest-threads/types.ts').GuestThreadEntryRow>()
  assert(proposal)
  const view=(await bookingChangeViews(db,(await getGuestRequest(db,'client-0'))!,[proposal])).get(proposal.id)!
  const immutable=JSON.parse(proposal.payload_json!)
  assert.equal(immutable.before.startsAt,immutable.afterStartsAt,'same-time attorney replacement preserves the instant across attorney timezones')
  assert.equal(immutable.before.endsAt,immutable.afterEndsAt)
  const label=(instant:string,timezone:string)=>formatTimestamp(instant,'en',timezone,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})
  assert.equal(view.before.whenLabel,label(following,'UTC'))
  assert.equal(view.after.whenLabel,label(following,'America/New_York'))
  assert.equal(view.before.assignedMemberId,'member-two')
  assert.equal(view.after.assignedMemberId,'member-one')
  assert.equal(view.status,'pending')
  const consultationMail=await db.prepare("SELECT email_json FROM guest_thread_deliveries WHERE entry_id=? AND purpose='status_update'").bind(proposal.id).first<string>('email_json')
  assert(consultationMail)
  assert.match(JSON.parse(consultationMail).message.html,/href="https:\/\/krabiclaw\.test\/dashboard\/account\/activity\/booking\/client-0"/,'consultation approval mail opens its actual buyer-owned activity')
  const refusedDeliveryEnv={...env,EMAIL_DELIVERY_MODE:'provider',EMAIL_FROM:'KrabiClaw <hello@krabiclaw.com>',RESEND_API_KEY:'controlled-refusal-only'}
  await assert.rejects(()=>respondToBookingChange(db,refusedDeliveryEnv,{threadId:'client-0',requestId:proposal.id,buyerUserId:'outsider',decision:'decline'}),(error:unknown)=>{
   assert(error instanceof Error && 'statusCode' in error && error.statusCode===502)
   assert.match(error.message,/RESERVED_TEST_EMAIL_DOMAIN/)
   return true
  })
  assert.deepEqual(await read(),original,'declining leaves assignment and operational revision untouched even when its email is refused')
  const declinedDetail=await getGuestThreadDetail(db,'client-0','org')
  assert.equal(declinedDetail?.conversationState,'resolved','the recorded decline stops waiting on the client before delivery can fail')
  assert.equal(declinedDetail?.entries.find(entry=>entry.id===proposal.id)?.bookingChange?.status,'declined')
  assert.equal((await respondToBookingChange(db,env,{threadId:'client-0',requestId:proposal.id,buyerUserId:'outsider'})).status,'declined')
  const declinedReceipt=await db.prepare("SELECT d.status,d.error FROM guest_thread_deliveries d JOIN activity_entries decision ON decision.id=d.entry_id WHERE decision.event_name='booking_change.declined' AND json_extract(decision.payload_json,'$.requestId')=? AND d.purpose='status_update'").bind(proposal.id).first<{status:string;error:string}>()
  assert.equal(declinedReceipt?.status,'failed')
  assert.match(declinedReceipt!.error,/RESERVED_TEST_EMAIL_DOMAIN/)
  assert(!(await listGuestThreads(db,'org',{userId:'owner',conversationState:'waiting_on_guest'})).some(thread=>thread.id==='client-0'))
  const requestAgain=await reassignBookingProvider(owner,{...move,idempotency_key:'client-attorney-change-accept'})
  assert.equal(requestAgain.change_status,'awaiting_guest_acceptance')
  const acceptedId=await db.prepare("SELECT id FROM activity_entries WHERE request_id='client-0' AND event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1").first<string>('id')
  assert(acceptedId)
  const accepted=await respondToBookingChange(db,env,{threadId:'client-0',requestId:acceptedId,buyerUserId:'outsider',decision:'accept'})
  assert.equal(accepted.status,'accepted')
  const moved=await read()
  assert.equal(moved!.id,original!.id,'acceptance preserves the consultation identity')
  assert.equal(moved!.assigned_member_id,'member-one')
  assert.notEqual(moved!.product_session_id,'group')
  assert.equal(await db.prepare('SELECT assigned_member_id FROM bookings WHERE id=?').bind(group[1]!.bookingId).first('assigned_member_id'),'member-two','one client cannot consent to another client’s attorney change')
  assert.equal(await db.prepare("SELECT assigned_member_id FROM product_sessions WHERE id='group'").first('assigned_member_id'),'member-two')
  const decision=await db.prepare("SELECT id FROM activity_entries WHERE request_id='client-0' AND event_name='booking_change.accepted' AND json_extract(payload_json,'$.requestId')=?").bind(acceptedId).first<{id:string}>()
  assert(decision)
  const assignmentAlert=await db.prepare("SELECT id,event_name,body FROM activity_entries WHERE parent_id=? AND kind='notification' AND scope_kind='organization'").bind(decision.id).all<{id:string;event_name:string;body:string}>()
  assert.equal(assignmentAlert.results.length,1,'one accepted decision has one canonical staff notification')
  assert.equal(assignmentAlert.results[0]!.event_name,'booking.change_accepted')
  assert.match(assignmentAlert.results[0]!.body,/member-two → member-one/,'the accepted notification contains the immutable before and after attorney names')
  const staffReceipts=()=>db.prepare("SELECT id,status,email_json FROM guest_thread_deliveries WHERE entry_id=? AND purpose='owner_alert' AND channel='email' ORDER BY id").bind(decision.id).all<{id:string;status:string;email_json:string}>().then(result=>result.results)
  const notified=await staffReceipts()
  assert.equal(notified.length,3,'the owner and exactly the previous and accepted attorneys are notified')
  assert(notified.every(receipt=>receipt.status==='sent'))
  const recipients=notified.map(receipt=>JSON.parse(receipt.email_json).message.to).sort()
  assert.deepEqual(recipients,['one@example.test','owner@example.test','two@example.test'])
  for (const receipt of notified) assert.match(JSON.parse(receipt.email_json).message.text.replace(/\s+/gu,' '),/member-two → member-one/)

  const after=await respondToBookingChange(db,env,{threadId:'client-0',requestId:acceptedId,buyerUserId:'outsider',decision:'accept'})
  assert.equal(after.status,'accepted')
  assert.deepEqual(await read(),moved,'replayed acceptance does not claim or move again')
  assert.deepEqual(await staffReceipts(),notified,'replaying acceptance retains exactly the original per-recipient receipts')
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE parent_id=? AND kind='notification' AND scope_kind='organization'").bind(decision.id).first('n'),1)
  assert.equal(await db.prepare("SELECT count(*) n FROM activity_entries WHERE request_id='client-0' AND event_name='booking_change.accepted'").first('n'),1)
  await assert.rejects(()=>reassignBookingProvider(owner,{...move,idempotency_key:'stale-attorney-change'}),{statusCode:409})
  const membership=await resolveOrganizationMembership(env,{organizationId:'org',userId:'owner'})
  assert(membership)
  const principal=memberAccessPrincipal(membership,{env})
  const waiting=(threadId:string)=>db.prepare('SELECT conversation_state FROM requests WHERE id=?').bind(threadId).first<string>('conversation_state')
  const scoped=(state:'needs_attention'|'waiting_on_guest')=>listOrganizationGuestThreads(db,{organizationId:'org',userId:'owner',principal,conversationState:state,limit:1})
  // The proposal is sent normally. Only elapsed time changes; no expiry writer manufactures state.
  await reassignBookingProvider(owner,{booking_id:moved!.id,member_id:'member-two',expected_updated_at:moved!.updated_at,idempotency_key:'expires-in-conversation'})
  const expiringId=await db.prepare("SELECT id FROM activity_entries WHERE request_id='client-0' AND event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1").first<string>('id')
  assert(expiringId)
  assert.equal((await scoped('waiting_on_guest'))[0]?.id,'client-0')
  t.mock.timers.enable({apis:['Date'],now:new Date(Date.now()+8*86400000)})
  try {
   const expired=await respondToBookingChange(db,env,{threadId:'client-0',requestId:expiringId,buyerUserId:'outsider'})
   assert.equal(expired.status,'expired')
   await assert.rejects(()=>respondToBookingChange(db,env,{threadId:'client-0',requestId:expiringId,buyerUserId:'outsider',decision:'accept'}),{statusCode:410})
   assert.equal(await waiting('client-0'),'waiting_on_guest','reads do not rewrite the persisted conversation projection')
   assert.equal((await getGuestThreadDetail(db,'client-0','org'))?.conversationState,'needs_attention')
   assert.equal((await scoped('needs_attention'))[0]?.id,'client-0','merchant filtering derives expiry before pagination')
   assert(!(await scoped('waiting_on_guest')).some(thread=>thread.id==='client-0'))
   const inbox=await listGuestThreads(db,'org',{userId:'owner',principal,conversationState:'needs_attention',limit:1})
   assert.equal(inbox[0]?.id,'client-0','the shared dashboard list uses the same derived state')
   assert.equal(inbox[0]?.needsAttention,true)
   const detail=await getGuestThreadDetail(db,'client-0','org')
   assert.equal(detail?.entries.find(entry=>entry.id===expiringId)?.bookingChange?.status,'expired','conversation card and response share the canonical expiry state')
   const reply=await executeGuestThreadOperation(db,{threadId:'client-0',organizationId:'org',action:'reply',actorUserId:'owner',idempotencyKey:'after-expired-proposal',env,body:'Please reply with a suitable consultation time.'})
   assert.equal(reply.ok,true)
   assert.equal((await getGuestThreadDetail(db,'client-0','org'))?.conversationState,'waiting_on_guest','an expired proposal cannot override a later real staff reply')
   assert(!(await scoped('needs_attention')).some(thread=>thread.id==='client-0'))
   const cancelled=await executeGuestThreadOperation(db,{threadId:'client-0',organizationId:'org',action:'cancel',actorUserId:'owner',idempotencyKey:'cancel-after-expired-proposal',env})
   assert.equal(cancelled.ok,true)
   assert.equal((await getGuestThreadDetail(db,'client-0','org'))?.conversationState,'resolved','an expired proposal cannot reopen a resolved appointment')
  } finally {t.mock.timers.reset()}
  const second=await db.prepare('SELECT updated_at FROM bookings WHERE id=?').bind(group[1]!.bookingId).first<string>('updated_at')
  await reassignBookingProvider(owner,{booking_id:group[1]!.bookingId,member_id:'member-one',expected_updated_at:second!,idempotency_key:'stale-proposal-attention'})
  const staleId=await db.prepare("SELECT id FROM activity_entries WHERE request_id='client-1' AND event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1").first<string>('id')
  assert(staleId)
  await db.prepare('UPDATE bookings SET party_size=2 WHERE id=?').bind(group[1]!.bookingId).run()
  assert.equal((await respondToBookingChange(db,env,{threadId:'client-1',requestId:staleId,buyerUserId:'outsider'})).status,'stale')
  assert.equal((await getGuestThreadDetail(db,'client-1','org'))?.conversationState,'needs_attention')
  assert.equal((await scoped('needs_attention'))[0]?.id,'client-1')
  assert.equal(await waiting('client-1'),'waiting_on_guest')
  await assert.rejects(()=>respondToBookingChange(db,env,{threadId:'client-1',requestId:staleId,buyerUserId:'outsider',decision:'decline'}),{statusCode:409})
  const currentSecond=await db.prepare('SELECT updated_at FROM bookings WHERE id=?').bind(group[1]!.bookingId).first<string>('updated_at')
  await reassignBookingProvider(owner,{booking_id:group[1]!.bookingId,member_id:'member-one',expected_updated_at:currentSecond!,idempotency_key:'accepted-before-delivery-failure'})
  const failureProposalId=await db.prepare("SELECT id FROM activity_entries WHERE request_id='client-1' AND event_name='booking_change.requested' ORDER BY sequence DESC LIMIT 1").first<string>('id')
  assert(failureProposalId)
  await assert.rejects(()=>respondToBookingChange(db,refusedDeliveryEnv,{threadId:'client-1',requestId:failureProposalId,buyerUserId:'outsider',decision:'accept'}),(error:unknown)=>{
   assert(error instanceof Error && 'statusCode' in error && error.statusCode===502)
   assert.match(error.message,/RESERVED_TEST_EMAIL_DOMAIN/)
   return true
  })
  assert.deepEqual(await db.prepare('SELECT id,status,party_size,assigned_member_id FROM bookings WHERE id=?').bind(group[1]!.bookingId).first(),{id:group[1]!.bookingId,status:'confirmed',party_size:2,assigned_member_id:'member-one'},'a failed decision email does not conceal or reverse the committed acceptance')
  assert.equal((await respondToBookingChange(db,env,{threadId:'client-1',requestId:failureProposalId,buyerUserId:'outsider'})).status,'accepted')
  const acceptedFailureDetail=await getGuestThreadDetail(db,'client-1','org')
  assert.equal(acceptedFailureDetail?.conversationState,'resolved')
  assert.equal(acceptedFailureDetail?.entries.find(entry=>entry.id===failureProposalId)?.bookingChange?.status,'accepted')
  assert(acceptedFailureDetail?.deliveryFailures.some(delivery=>delivery.status==='failed'&&delivery.error?.includes('RESERVED_TEST_EMAIL_DOMAIN')),'the same conversation retains the delivery failure for review')
  assert.equal(await db.prepare("SELECT conversation_state FROM requests WHERE id='client-1'").first('conversation_state'),'resolved')
  assert(!(await scoped('waiting_on_guest')).some(thread=>thread.id==='client-1'),'canonical merchant queries do not wait for consent already recorded')




 }finally{await runtime.dispose()}
})

test('member working windows retain IANA timezone across DST and merge adjacent hours',()=>{
 const {intervals}=workingWindows('America/New_York',[{weekday:1,start:'09:00',end:'12:00'},{weekday:1,start:'12:00',end:'17:00'}],new Date('2026-10-26T00:00:00.000Z'))
 assert(intervals.some(i=>i.start==='2026-10-26T13:00:00.000Z'&&i.end==='2026-10-26T21:00:00.000Z'))
 assert(intervals.some(i=>i.start==='2026-11-02T14:00:00.000Z'&&i.end==='2026-11-02T22:00:00.000Z'))
 assert.throws(()=>workingWindows('America/New_York',[{weekday:0,start:'01:30',end:'03:30'}],new Date('2026-10-26T00:00:00.000Z')),/multiple|ambiguous/i)
 assert.throws(()=>workingWindows('America/New_York',[{weekday:0,start:'02:30',end:'03:30'}],new Date('2027-03-01T00:00:00.000Z')),/exist|invalid/i)
})
