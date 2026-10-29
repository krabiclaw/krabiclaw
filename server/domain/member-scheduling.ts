import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { assertRoleAllows, resolveOrganizationMembership } from '~/server/utils/member-access'
import { linkedAccountAccessToken, requireIntegrationAccount, type CloudflareEnv } from '~/server/utils/auth'
import { addLocalDays, localDateAt, localDateTimeToInstant, isValidTimezone, isValidInstant } from '~/utils/timezone'
import { BUSY_FRESHNESS_MS, MEMBER_BUSY_SCOPES, MEMBER_NAME_SQL, type WorkingHours, type SchedulingInterval } from '~/shared/member-scheduling'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { getOrganizationTeamsData } from '~/server/utils/dashboard-members'
import { getR2KeyFromPublicUrl } from '~/server/utils/cloudflare-r2'

export interface SchedulingActor { env: CloudflareEnv; userId: string; organizationId: string }
export interface MemberScheduling {
 member_id: string; organization_id: string; timezone: string | null; weekly_json: string | null; time_off_json: string | null; windows_json: string | null; windows_until: string | null
 public_name: string | null; public_photo_url: string | null; public_bio: string | null; public_approved: number
 calendar_account_id: string | null; calendar_ids_json: string; calendar_revision: string; busy_json: string
 busy_from: string | null; busy_until: string | null; busy_checked_at: string | null; busy_error: string | null; updated_at: string; updated_by: string
}
export async function requireSchedulingAccess(actor: SchedulingActor, memberId: string, admin = false) {
 const membership = await resolveOrganizationMembership(actor.env, { organizationId: actor.organizationId, userId: actor.userId })
 if (!membership) throw new HTTPError({ statusCode: 403, message: 'Organization membership required' })
 const target = await queryFirst<{ id: string; userId: string }>(actor.env.DB, 'SELECT id,userId FROM member WHERE id=? AND organizationId=?', [memberId, actor.organizationId])
 if (!target) throw new HTTPError({ statusCode: 404, message: 'Member not found' })
 if (admin || target.userId !== actor.userId) await assertRoleAllows({ ...membership, permissions: { members: ['update'] } })
 else await assertRoleAllows({ ...membership, permissions: { scheduling: ['own'] } })
 return target
}
function weeklyHours(value: unknown): WorkingHours[] {
 if (!Array.isArray(value) || value.length > 28) throw new HTTPError({ statusCode: 400, message: 'At most 28 weekly working windows are allowed' })
 return value.map(slot => {
  if (!slot || typeof slot!=='object' || !Number.isInteger(slot.weekday) || slot.weekday < 0 || slot.weekday > 6 || typeof slot.start!=='string' || typeof slot.end!=='string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.end) || slot.end <= slot.start) throw new HTTPError({ statusCode: 400, message: 'Hours require weekday 0–6 and start before end on the same day' })
  return { weekday: slot.weekday, start: slot.start, end: slot.end }
 })
}
export function workingWindows(timezone: string, weekly: WorkingHours[], now = new Date()): { intervals: SchedulingInterval[]; until: string } {
 if (!isValidTimezone(timezone)) throw new HTTPError({ statusCode: 400, message: 'Choose an IANA timezone' })
 weekly = weeklyHours(weekly)
 const intervals: SchedulingInterval[] = []
 const from = localDateAt(now, timezone)
 for (let day = 0; day < 370; day++) {
  const date = addLocalDays(from, day)
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
  for (const slot of weekly.filter(slot => slot.weekday === weekday)) {
   try {
    const start = localDateTimeToInstant(date, slot.start, timezone, 'reject').toISOString()
    const end = localDateTimeToInstant(date, slot.end, timezone, 'reject').toISOString()
    if (end > start) intervals.push({ start, end })
   } catch {
    throw new HTTPError({statusCode:400,message:`Working hours on ${date} have a nonexistent or ambiguous DST boundary; choose an unambiguous start and end`})
   }
  }
 }
 // Merge adjacent/overlapping hours: a Session may span both working windows.
 const merged: SchedulingInterval[] = []
 for (const interval of intervals.sort((a,b)=>a.start.localeCompare(b.start))) {
  const previous=merged.at(-1)
  if (previous && previous.end>=interval.start) previous.end=previous.end>interval.end?previous.end:interval.end
  else merged.push({...interval})
 }
 return { intervals: merged, until: localDateTimeToInstant(addLocalDays(from,370),'00:00',timezone,'compatible').toISOString() }
}
function validIntervals(value: unknown): SchedulingInterval[] {
 if (!Array.isArray(value) || value.length > 100) throw new HTTPError({ statusCode: 400, message: 'At most 100 time-off intervals are allowed' })
 return value.map(v=>{
  if (!v || typeof v.start!=='string' || typeof v.end!=='string' || !isValidInstant(v.start) || !isValidInstant(v.end) || Date.parse(v.end)<=Date.parse(v.start)) throw new HTTPError({statusCode:400,message:'Time off requires valid start and end instants'})
  return {start:new Date(v.start).toISOString(),end:new Date(v.end).toISOString()}
 })
}
export async function readMemberScheduling(db: DbClient, organizationId: string, memberId: string) {
 const row=await queryFirst<MemberScheduling>(db,'SELECT * FROM member_scheduling WHERE organization_id=? AND member_id=?',[organizationId,memberId])
 if (!row) return null
 const linked = row.calendar_account_id ? await queryFirst(db,"SELECT a.id FROM account a JOIN member m ON m.userId=a.userId WHERE a.id=? AND a.providerId='google' AND m.id=? AND m.organizationId=?",[row.calendar_account_id,memberId,organizationId]) : null
 const conflicts = row.calendar_account_id ? await queryAll<{ session_id: string; starts_at: string; ends_at: string; booking_count: number; total: number }>(db, `
  SELECT s.id session_id,s.starts_at,s.ends_at,count(b.id) booking_count,count(*) OVER() total
  FROM bookings b JOIN product_sessions s ON s.id=b.product_session_id AND s.organization_id=b.organization_id
  WHERE b.organization_id=? AND b.assigned_member_id=? AND b.status IN ('pending','confirmed') AND s.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND EXISTS(SELECT 1 FROM json_each(?) busy WHERE json_extract(busy.value,'$.start')<s.ends_at AND json_extract(busy.value,'$.end')>s.starts_at)
  GROUP BY s.id,s.starts_at,s.ends_at ORDER BY s.starts_at,s.id LIMIT 25`, [organizationId,memberId,row.busy_json]) : []
 return {
  calendar_conflict_count:conflicts[0]?.total??0,
  calendar_conflicts:conflicts.map(({total,...conflict})=>conflict),
  member_id:row.member_id,organization_id:row.organization_id,timezone:row.timezone,
  weekly:row.weekly_json===null?null:JSON.parse(row.weekly_json) as WorkingHours[],time_off:row.time_off_json===null?null:JSON.parse(row.time_off_json) as SchedulingInterval[],
  public_name:row.public_name,public_photo_url:row.public_photo_url,public_bio:row.public_bio,public_approved:row.public_approved,
  calendar_account_id:row.calendar_account_id,calendar_ids:JSON.parse(row.calendar_ids_json) as string[],
  busy_from:row.busy_from,busy_until:row.busy_until,busy_checked_at:row.busy_checked_at,busy_error:row.busy_error,
  updated_at:row.updated_at,updated_by:row.updated_by,
  calendar_status:!row.calendar_account_id || !JSON.parse(row.calendar_ids_json).length?'internal':!linked?'disconnected':row.busy_error?'error':!row.busy_checked_at||Date.now()-Date.parse(row.busy_checked_at)>BUSY_FRESHNESS_MS?'stale':'ready',
 }
}
export async function writeMemberScheduling(actor: SchedulingActor, memberId: string, input: {timezone?: string; weekly?: WorkingHours[]; time_off?: SchedulingInterval[]; expected_updated_at: string | null; public_name?: string | null; public_photo_url?: string | null; public_bio?: string | null; public_approved?: boolean}) {
 const fields=['timezone','weekly','time_off','public_name','public_photo_url','public_bio','public_approved'] as const
 if(!input || typeof input!=='object' || Array.isArray(input) || (input.expected_updated_at!==null && (typeof input.expected_updated_at!=='string' || !isValidInstant(input.expected_updated_at))) || Object.keys(input).some(key=>key!=='expected_updated_at' && !fields.includes(key as typeof fields[number])) || !fields.some(key=>input[key]!==undefined))throw new HTTPError({statusCode:400,message:'Choose the settings to change and provide their current revision'})
 if(input.timezone!==undefined && (typeof input.timezone!=='string' || !isValidTimezone(input.timezone)))throw new HTTPError({statusCode:400,message:'Choose an IANA timezone'})
 if(input.public_approved!==undefined && typeof input.public_approved!=='boolean')throw new HTTPError({statusCode:400,message:'Approval must be boolean'})
 const member = await requireSchedulingAccess(actor,memberId)
 const db=actor.env.DB
 const current=await queryFirst<MemberScheduling>(db,'SELECT * FROM member_scheduling WHERE organization_id=? AND member_id=?',[actor.organizationId,memberId])
 if ((current?.updated_at??null)!==input.expected_updated_at) throw new HTTPError({statusCode:409,message:'Member settings changed; reload before saving'})
 if(input.public_approved!==undefined) await requireSchedulingAccess(actor,memberId,true)
 const suppliedHours=input.timezone!==undefined || input.weekly!==undefined || input.time_off!==undefined
 if(current?.timezone==null && suppliedHours && (input.timezone===undefined || input.weekly===undefined || input.time_off===undefined))throw new HTTPError({statusCode:400,message:'Set timezone, weekly hours and time off together the first time hours are saved'})
 const timezone=input.timezone===undefined?current?.timezone??null:input.timezone
 const currentWeekly=current?.weekly_json==null?null:weeklyHours(JSON.parse(current.weekly_json))
 const currentTimeOff=current?.time_off_json==null?null:validIntervals(JSON.parse(current.time_off_json))
 const weekly=input.weekly===undefined?currentWeekly:weeklyHours(input.weekly)
 const timeOff=input.time_off===undefined?currentTimeOff:validIntervals(input.time_off)
 const changedHours=timezone!==(current?.timezone??null) || JSON.stringify(weekly)!==JSON.stringify(currentWeekly)
 const changedTimeOff=JSON.stringify(timeOff)!==JSON.stringify(currentTimeOff)
 const windows=changedHours?workingWindows(timezone!,weekly!):null
 for(const [key,max] of [['public_name',100],['public_bio',2000],['public_photo_url',2048]] as const) if(input[key]!==undefined && input[key]!==null && (typeof input[key]!=='string' || input[key]!.length>max)) throw new HTTPError({statusCode:400,message:`Invalid ${key}`})
 if(input.public_photo_url) { if(!URL.canParse(input.public_photo_url))throw new HTTPError({statusCode:400,message:'Public photo must be a valid HTTPS URL'});const url=new URL(input.public_photo_url); if((url.protocol!=='https:' && getR2KeyFromPublicUrl(actor.env,input.public_photo_url)===null) || url.username || url.password) throw new HTTPError({statusCode:400,message:'Public photo must use HTTPS'}) }
 const changedProfile=['public_name','public_photo_url','public_bio'].some(key=>input[key as keyof typeof input]!==undefined && input[key as keyof typeof input]!==current?.[key as keyof typeof current])
 const approved=input.public_approved??(changedProfile?false:Boolean(current?.public_approved))
 const publicName=input.public_name===undefined?current?.public_name??null:input.public_name
 if(approved && !publicName?.trim())throw new HTTPError({statusCode:400,message:'Set a nonblank public name before publishing the member profile'})
 const now=new Date(Math.max(Date.now(),current?Date.parse(current.updated_at)+1:0)).toISOString()
 const updates=['public_name','public_photo_url','public_bio','public_approved','updated_at','updated_by',...(changedHours?['timezone','weekly_json','windows_json','windows_until']:[]),...(changedTimeOff?['time_off_json']:[])]
 await executeBatch(db,[{query:`INSERT INTO member_scheduling(member_id,organization_id,timezone,weekly_json,time_off_json,windows_json,windows_until,public_name,public_photo_url,public_bio,public_approved,calendar_revision,updated_at,updated_by)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM member WHERE id=? AND organizationId=?)
  AND (? IS NULL OR EXISTS(SELECT 1 FROM member_scheduling WHERE member_id=? AND organization_id=? AND updated_at=?))
 ON CONFLICT(member_id) DO UPDATE SET ${updates.map(field=>`${field}=excluded.${field}`).join(',')}
 WHERE member_scheduling.organization_id=excluded.organization_id AND member_scheduling.updated_at IS ?`,params:[memberId,actor.organizationId,timezone,weekly===null?null:JSON.stringify(weekly),timeOff===null?null:JSON.stringify(timeOff),windows?JSON.stringify(windows.intervals):current?.windows_json??null,windows?.until??current?.windows_until??null,publicName,input.public_photo_url===undefined?current?.public_photo_url??null:input.public_photo_url,input.public_bio===undefined?current?.public_bio??null:input.public_bio,Number(approved),crypto.randomUUID(),now,actor.userId,memberId,actor.organizationId,input.expected_updated_at,memberId,actor.organizationId,input.expected_updated_at,input.expected_updated_at]},
 {query:"SELECT CASE WHEN changes() = 1 THEN NULL ELSE json('Member settings changed; reload before saving') END"},
 publicResourceCacheInvalidationQuery(actor.organizationId,'member-profile')],{operation:'Save member settings'}).catch(error=>{
  if(error instanceof Error && /malformed JSON/.test(error.message))throw new HTTPError({statusCode:409,message:'Member settings changed; reload before saving',cause:error})
  throw error
 })
 // An explicit Hours save also finishes interrupted, idempotent session work.
 // Profile edits never enter that operation.
 if(suppliedHours) {
  const { materializeMemberSessions } = await import('~/server/utils/availability')
  await materializeMemberSessions(db, { organizationId: actor.organizationId, userId: member.userId, actorId: actor.userId })
 }
 const saved=await readMemberScheduling(db,actor.organizationId,memberId)
 if(!saved)throw new HTTPError({statusCode:500,message:'Saved member settings could not be read back'})
 return saved
}
export async function refreshWorkingWindows(db: DbClient) {
 const rows=await queryAll<MemberScheduling & {timezone:string;weekly_json:string}>(db,"SELECT * FROM member_scheduling WHERE timezone IS NOT NULL AND windows_until<strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 days') ORDER BY windows_until LIMIT 25")
 for(const row of rows) { const windows=workingWindows(row.timezone,JSON.parse(row.weekly_json)); await executeBatch(db,[{query:'UPDATE member_scheduling SET windows_json=?,windows_until=? WHERE member_id=? AND updated_at=?',params:[JSON.stringify(windows.intervals),windows.until,row.member_id,row.updated_at]}]) }
}
export async function selectBusyCalendars(actor: SchedulingActor, memberId: string, input: {account_id: string | null; calendar_ids: string[]}) {
 if(!input || (input.account_id!==null && (typeof input.account_id!=='string' || !input.account_id)))throw new HTTPError({statusCode:400,message:'Choose a linked account or explicitly disconnect it'})
 const member=await requireSchedulingAccess(actor,memberId)
 // Turning the sync on is Business; turning it off never needs a plan.
 if(Array.isArray(input.calendar_ids)&&input.calendar_ids.length&&!await hasOrganizationEntitlement(actor.env,actor.organizationId,'calendar_sync'))throw new HTTPError({statusCode:403,message:'Google Calendar sync comes with the Business plan',data:{code:'ENTITLEMENT_REQUIRED',entitlement:'calendar_sync'}})
 if(input.account_id && member.userId!==actor.userId) throw new HTTPError({statusCode:403,message:'Only the member may select their linked Google account'})
 if(!Array.isArray(input.calendar_ids)||input.calendar_ids.length>10||input.calendar_ids.some(id=>typeof id!=='string'||!id||id.length>1024)||(!input.account_id && input.calendar_ids.length>0)) throw new HTTPError({statusCode:400,message:'Choose an account and 1–10 calendars, or disconnect both'})
 const current=await queryFirst<MemberScheduling>(actor.env.DB,'SELECT * FROM member_scheduling WHERE member_id=? AND organization_id=?',[memberId,actor.organizationId])
 if(current?.timezone==null)throw new HTTPError({statusCode:409,message:'Save member hours first before selecting busy-input calendars'})
 if(input.account_id) await requireIntegrationAccount(actor.env,input.account_id,{userId:member.userId,currentAccountId:null,providerId:'google',scopes:input.calendar_ids.length?MEMBER_BUSY_SCOPES:[]})
 const now=new Date(Math.max(Date.now(),Date.parse(current.updated_at)+1)).toISOString()
 const results=await executeBatch(actor.env.DB,[{query:`UPDATE member_scheduling SET calendar_account_id=?,calendar_ids_json=?,calendar_revision=?,busy_json='[]',busy_from=NULL,busy_until=NULL,busy_checked_at=NULL,busy_error=NULL,updated_at=?,updated_by=? WHERE member_id=? AND organization_id=? AND timezone IS NOT NULL AND updated_at=? AND NOT EXISTS(SELECT 1 FROM organization_integrations WHERE organization_id=? AND provider='google_calendar' AND status<>'disabled' AND target_id IN (SELECT value FROM json_each(?)))`,params:[input.account_id,JSON.stringify(input.calendar_ids),crypto.randomUUID(),now,actor.userId,memberId,actor.organizationId,current.updated_at,actor.organizationId,JSON.stringify(input.calendar_ids)]}])
 if(!results[0]?.meta.changes) throw new HTTPError({statusCode:409,message:'Member settings changed or this calendar is used for booking output; reload before saving'})
 return readMemberScheduling(actor.env.DB,actor.organizationId,memberId)
}
export async function refreshMemberBusy(db: DbClient, env: CloudflareEnv, memberId: string, force=false) {
 const row=await queryFirst<MemberScheduling>(db,'SELECT * FROM member_scheduling WHERE member_id=? AND timezone IS NOT NULL',[memberId])
 if(!row?.calendar_account_id || !JSON.parse(row.calendar_ids_json).length)return
 if(!force && row.busy_checked_at && Date.now()-Date.parse(row.busy_checked_at)<BUSY_FRESHNESS_MS/2)return row.busy_error?{error:row.busy_error}:undefined
 const now=new Date().toISOString(), until=new Date(Date.parse(now)+94*86400000).toISOString()
 try {
  // A selection kept after the plan lapsed fails closed, visibly: availability waits until the sync is back on or turned off.
  if(!await hasOrganizationEntitlement(env,row.organization_id,'calendar_sync')) throw new Error('Google Calendar sync comes with the Business plan; turn it off or upgrade to keep checking this calendar')
  const member=await queryFirst<{userId:string}>(db,'SELECT userId FROM member WHERE id=? AND organizationId=?',[memberId,row.organization_id])
  if(!member) throw new Error('Member is no longer connected')
  await requireIntegrationAccount(env,row.calendar_account_id,{userId:member.userId,currentAccountId:null,providerId:'google',scopes:MEMBER_BUSY_SCOPES})
  const output=await queryFirst<{calendar:string|null}>(db,"SELECT target_id calendar FROM organization_integrations WHERE organization_id=? AND provider='google_calendar' AND status<>'disabled'",[row.organization_id])
  const ids=JSON.parse(row.calendar_ids_json) as string[]
  if(output?.calendar && ids.includes(output.calendar)) throw new Error('Busy input overlaps booking output calendar; change the selection')
  const token=await linkedAccountAccessToken(env,row.calendar_account_id)
  const busy:SchedulingInterval[]=[]
  // Google rejects the full scheduling horizon in one freeBusy request.
  // Commit coverage only after every contiguous window succeeds.
  for(let from=Date.parse(now);from<Date.parse(until);from+=30*86400000) {
   const timeMax=new Date(Math.min(from+30*86400000,Date.parse(until))).toISOString()
   const response=await fetch('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',headers:{Authorization:`Bearer ${token.accessToken}`,'content-type':'application/json'},body:JSON.stringify({timeMin:new Date(from).toISOString(),timeMax,items:ids.map(id=>({id}))})})
   if(!response.ok) {
    const failure=await response.json().catch((cause:unknown)=>{
     throw new Error(`Google busy-calendar check failed (${response.status}): Invalid error response${cause instanceof Error?` (${cause.message})`:''}`)
    }) as {error?:{message?:string}} | null
    throw new Error(`Google busy-calendar check failed (${response.status})${typeof failure?.error?.message==='string'?`: ${failure.error.message}`:''}`)
   }
   const data=await response.json() as {calendars?:Record<string,{errors?:unknown[];busy?:SchedulingInterval[]}>}
   for(const id of ids) {const calendar=data.calendars?.[id];if(!calendar||calendar.errors?.length||!Array.isArray(calendar.busy))throw new Error('A selected Google calendar could not be checked'); for(const interval of calendar.busy) {if(!Number.isFinite(Date.parse(interval.start))||!Number.isFinite(Date.parse(interval.end))||Date.parse(interval.end)<=Date.parse(interval.start))throw new Error('Google returned an invalid busy interval');busy.push({start:new Date(interval.start).toISOString(),end:new Date(interval.end).toISOString()})}}
  }
  if(busy.length>20000) throw new Error('Selected calendars exceed the bounded busy cache')
  await executeBatch(db,[{query:'UPDATE member_scheduling SET busy_json=?,busy_from=?,busy_until=?,busy_checked_at=?,busy_error=NULL WHERE member_id=? AND calendar_revision=?',params:[JSON.stringify(busy),now,until,new Date().toISOString(),memberId,row.calendar_revision]}])
 } catch(error) {
  const message=error instanceof Error?error.message:String(error)
  await executeBatch(db,[{query:'UPDATE member_scheduling SET busy_error=?,busy_checked_at=? WHERE member_id=? AND calendar_revision=?',params:[message,new Date().toISOString(),memberId,row.calendar_revision]}])
  return {error:message}
 }
}
export async function refreshProductBusy(db: DbClient,env:CloudflareEnv,organizationId:string,productId:string) {
 const members=await queryAll<{id:string}>(db,`SELECT candidates.id FROM (SELECT assigned_member_id id FROM product_booking_configs WHERE organization_id=? AND product_id=? AND scheduling_mode='provider' AND assigned_member_id IS NOT NULL UNION SELECT m.id FROM product_booking_configs c JOIN team t ON t.id=c.assigned_team_id AND t.organizationId=c.organization_id JOIN teamMember tm ON tm.teamId=t.id JOIN member m ON m.userId=tm.userId AND m.organizationId=t.organizationId WHERE c.organization_id=? AND c.product_id=? AND c.scheduling_mode='provider' UNION SELECT assigned_member_id FROM product_sessions WHERE organization_id=? AND product_id=? AND assigned_member_id IS NOT NULL AND ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) candidates JOIN member_scheduling ms ON ms.member_id=candidates.id AND ms.organization_id=? AND ms.timezone IS NOT NULL`,[organizationId,productId,organizationId,productId,organizationId,productId,organizationId])
 for(const member of members) {
  const refreshed=await refreshMemberBusy(db,env,member.id)
  if(refreshed?.error)throw new HTTPError({statusCode:502,message:refreshed.error,data:{code:'MEMBER_CALENDAR_REFRESH_FAILED'}})
 }
}
export async function memberSchedulingList(actor: SchedulingActor) {
 const membership=await resolveOrganizationMembership(actor.env,{organizationId:actor.organizationId,userId:actor.userId})
 if(!membership)throw new HTTPError({statusCode:403,message:'Membership required'})
 const {roleAllows}=await import('~/server/utils/member-access')
 const admin=await roleAllows({...membership,permissions:{members:['read']}})
 const members=await queryAll<{id:string;name:string;image:string|null;is_self:number}>(actor.env.DB,`SELECT m.id,${MEMBER_NAME_SQL} name,u.image,m.userId=? AS is_self FROM member m JOIN user u ON u.id=m.userId LEFT JOIN member_scheduling ms ON ms.member_id=m.id AND ms.organization_id=m.organizationId WHERE m.organizationId=? AND (?=1 OR m.userId=?)`,[actor.userId,actor.organizationId,Number(admin),actor.userId])
 return { members: await Promise.all(members.map(async ({is_self,...member})=>({...member,self:Boolean(is_self),scheduling:await readMemberScheduling(actor.env.DB,actor.organizationId,member.id)}))), teams: admin ? await getOrganizationTeamsData(actor.env, actor.organizationId) : [] }
}
export async function connectPersonalCalendar(actor:SchedulingActor, memberId:string, accountId:string) {
 const member=await requireSchedulingAccess(actor,memberId)
 if(member.userId!==actor.userId)throw new HTTPError({statusCode:403,message:'Connect your own Google account in My account.'})
 await requireIntegrationAccount(actor.env,accountId,{userId:actor.userId,currentAccountId:null,providerId:'google',scopes:MEMBER_BUSY_SCOPES})
 const token=await linkedAccountAccessToken(actor.env,accountId)
 let next:string|undefined
 for(let page=0;page<4;page++) {
  const response=await fetch(`https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&fields=items(id,primary),nextPageToken${next?`&pageToken=${encodeURIComponent(next)}`:''}`,{headers:{Authorization:`Bearer ${token.accessToken}`}})
  if(!response.ok)throw new HTTPError({statusCode:502,message:'Your personal calendar could not be connected. Try again.'})
  const data=await response.json() as {items?:{id:string;primary?:boolean}[];nextPageToken?:string}
  const primary=data.items?.find(calendar=>calendar.primary)
  if(primary) {
   const current=await readMemberScheduling(actor.env.DB,actor.organizationId,memberId)
   if(current?.calendar_account_id===accountId && current.calendar_ids.length===1 && current.calendar_ids[0]===primary.id)return current
   return selectBusyCalendars(actor,memberId,{account_id:accountId,calendar_ids:[primary.id]})
  }
  next=data.nextPageToken
  if(!next)break
 }
 throw new HTTPError({statusCode:502,message:'Google did not return your primary calendar.'})
}
