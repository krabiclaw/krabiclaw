import { HTTPError } from 'nitro'
import { organizationTool, type McpToolDefinition } from './shared'
import { memberSchedulingList, readMemberScheduling, requireSchedulingAccess, writeMemberScheduling, selectBusyCalendars, refreshMemberBusy } from '~/server/domain/member-scheduling'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { requiredString, NOT_HANDLED, type McpExecutorContext } from './execution'
const member={member_id:{type:'string',description:'Existing Better Auth organization member ID. Ordinary members may name only themselves.'}}
const interval={type:'object',properties:{start:{type:'string'},end:{type:'string'}},required:['start','end'],additionalProperties:false}
const nullableString = { type: ['string', 'null'] }
const scheduling = { type: 'object', properties: {
  member_id: { type: 'string' }, organization_id: { type: 'string' }, timezone: { type: 'string' }, updated_at: { type: 'string' }, updated_by: { type: 'string' },
  weekly: { type: 'array', items: { type: 'object', properties: { weekday: { type: 'integer', minimum: 0, maximum: 6 }, start: { type: 'string' }, end: { type: 'string' } }, required: ['weekday', 'start', 'end'] } }, time_off: { type: 'array', items: interval },
  public_name: nullableString, public_photo_url: nullableString, public_bio: nullableString, public_approved: { type: 'integer', enum: [0, 1] },
  calendar_account_id: nullableString, calendar_ids: { type: 'array', items: { type: 'string' } }, calendar_status: { type: 'string', enum: ['internal', 'disconnected', 'error', 'stale', 'ready'] },
  busy_from: nullableString, busy_until: nullableString, busy_checked_at: nullableString, busy_error: nullableString,
  calendar_conflict_count: { type: 'integer' }, calendar_conflicts: { type: 'array', items: { type: 'object', properties: { session_id: { type: 'string' }, starts_at: { type: 'string' }, ends_at: { type: 'string' }, booking_count: { type: 'integer', minimum: 1 } }, required: ['session_id', 'starts_at', 'ends_at', 'booking_count'] } },
}, required: ['member_id', 'organization_id', 'timezone', 'updated_at', 'weekly', 'time_off', 'calendar_status'], additionalProperties: false }
const schedulingResult = { type: 'object', properties: { scheduling }, required: ['scheduling'], additionalProperties: false }
const schedulingListResult = { type: 'object', properties: { scheduling, members: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, image: nullableString, self: { type: 'boolean' }, scheduling: { ...scheduling, type: ['object', 'null'] } }, required: ['id', 'name', 'image', 'self', 'scheduling'] } } }, anyOf: [{ required: ['scheduling'] }, { required: ['members'] }], additionalProperties: false }
export const PROVIDERS_TOOLS:McpToolDefinition[]=[
 organizationTool({name:'get_member_scheduling',outputSchema:schedulingListResult,domain:'providers',minimumRole:'member',description:'List accessible members and their scheduling when member_id is omitted, or read one member’s hours, time off, explicitly approved public profile and Calendar status. Ordinary members can read only their own scheduling record; owners/admins can inspect their team. No Google event content or credentials are returned.',inputSchema:{...member}}),
 organizationTool({name:'set_member_scheduling',outputSchema:schedulingResult,domain:'providers',minimumRole:'member',description:'Replace a member’s own timezone, weekly working hours and UTC time-off intervals using the latest updated_at. Owner/admin may oversee any member and approve public profile. Profile edits revoke approval unless explicitly approved by an admin. Existing Booking assignments and times stay fixed. Returns the saved scheduling record; no guest messages are sent.',inputSchema:{...member,timezone:{type:'string'},weekly:{type:'array',maxItems:28,items:{type:'object',properties:{weekday:{type:'integer',minimum:0,maximum:6},start:{type:'string'},end:{type:'string'}},required:['weekday','start','end'],additionalProperties:false}},time_off:{type:'array',maxItems:100,items:interval},expected_updated_at:{type:['string','null']},public_name:{type:['string','null']},public_photo_url:{type:['string','null']},public_bio:{type:['string','null']},public_approved:{type:'boolean'}},required:['member_id','timezone','weekly','time_off','expected_updated_at']}),
 organizationTool({name:'set_member_busy_calendars',outputSchema:schedulingResult,domain:'providers',minimumRole:'member',description:'Select busy-input calendars on the member’s already-linked Google account, returning scheduling and check status. Stale or disconnected selected calendars block availability; no selection uses internal scheduling.',inputSchema:{...member,account_id:{type:['string','null'],description:'Existing member Google account with free/busy scopes; null with no calendars disconnects. Does not grant OAuth access.'},calendar_ids:{type:'array',maxItems:10,items:{type:'string'},description:'Busy-input calendars, separate from organization booking output. Empty pauses checking; existing bookings and Google events are unchanged.'}},required:['member_id','account_id','calendar_ids']}),
]
export async function handleProvidersTools(ctx:McpExecutorContext):Promise<unknown> {
 const {organization,args,toolName}=ctx
 const actor={env:organization.env,organizationId:organization.organizationId,userId:organization.userId}
 if(toolName==='get_member_scheduling' && args.member_id===undefined)return {members:(await memberSchedulingList(actor)).members}
 const memberId=requiredString(args,'member_id')
 await requireSchedulingAccess(actor,memberId)
 let saved
 if(toolName==='get_member_scheduling') saved=await readMemberScheduling(organization.db,actor.organizationId,memberId)
 else if(toolName==='set_member_scheduling') {saved=await writeMemberScheduling(actor,memberId,args as unknown as Parameters<typeof writeMemberScheduling>[2]);await purgePublicResourceCacheNow(actor.env,actor.organizationId)}
 else if(toolName==='set_member_busy_calendars') {
  await selectBusyCalendars(actor,memberId,args as unknown as Parameters<typeof selectBusyCalendars>[2])
  const refreshed=await refreshMemberBusy(organization.db,actor.env,memberId,true)
  if(refreshed?.error)throw new HTTPError({statusCode:502,message:refreshed.error,data:{code:'MEMBER_CALENDAR_REFRESH_FAILED'}})
  saved=await readMemberScheduling(organization.db,actor.organizationId,memberId)
 } else return NOT_HANDLED
 if(!saved)throw new HTTPError({statusCode:404,message:'Member scheduling not found',data:{code:'MEMBER_SCHEDULING_NOT_FOUND'}})
 return {scheduling:saved}
}
