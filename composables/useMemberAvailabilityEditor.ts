import type { InjectionKey } from 'vue'
import type { readMemberScheduling } from '~/server/domain/member-scheduling'
import type { WorkingHours } from '~/shared/member-scheduling'
export type MemberSchedule = Awaited<ReturnType<typeof readMemberScheduling>>
const isSchedulingResponse = (value: unknown): value is { scheduling: MemberSchedule } => isRecord(value) && (value.scheduling === null || isRecord(value.scheduling))
export const memberAvailabilityKey = Symbol('member-availability') as InjectionKey<ReturnType<typeof createMemberAvailabilityEditor>>
export function createMemberAvailabilityEditor(organizationId:string, memberId:string, admin:boolean, self:boolean) {
 const base=`/api/organizations/${organizationId}/members/${memberId}`
 const record=ref<MemberSchedule>(null), loaded=ref(false), error=ref(''), saving=ref(false)
 const draft=ref({timezone:null as string|null,weekly:[] as WorkingHours[],time_off:[] as {start:string;end:string}[],public_name:'',public_photo_url:null as string|null,public_bio:'',public_approved:false})
 function revert(){const value=record.value; draft.value={timezone:value?.timezone??null,weekly:value?.weekly.map(w=>({...w}))??[],time_off:value?.time_off.map(i=>({...i}))??[],public_name:value?.public_name??'',public_photo_url:value?.public_photo_url??null,public_bio:value?.public_bio??'',public_approved:Boolean(value?.public_approved)}}
 function apply(value:MemberSchedule){record.value=value;revert()}
 const baseline=ref('')
 function reset(value:MemberSchedule){apply(value);baseline.value=JSON.stringify(draft.value)}
 const dirty=computed(()=>baseline.value!==JSON.stringify(draft.value))
 async function run(action:()=>Promise<void>){error.value='';saving.value=true;try{await action()}catch(cause){error.value=getErrorMessage(cause,'Your availability could not be saved.')}finally{saving.value=false}}
 async function load(){await run(async()=>{const value=await applicationFetch(`${base}/scheduling`,{validate:isSchedulingResponse});reset(value.scheduling);loaded.value=true})}
 async function save(){await run(async()=>{if(!draft.value.timezone)throw new Error('Choose your timezone in Hours first.');reset((await applicationFetch(`${base}/scheduling`,{method:'PUT',body:{...draft.value,public_name:draft.value.public_name||null,public_bio:draft.value.public_bio||null,public_approved:admin && draft.value.public_approved!==Boolean(record.value?.public_approved)?draft.value.public_approved:undefined,expected_updated_at:record.value?.updated_at??null},validate:isSchedulingResponse})).scheduling)})}
 async function calendar(enabled:boolean,accountId?:string){await run(async()=>{reset((await applicationFetch(`${base}/calendar`,{method:'POST',body:{enabled,account_id:accountId},validate:isSchedulingResponse})).scheduling)})}
 return {organizationId,memberId,admin,self,record,draft,loaded,error,saving,dirty,revert,load,save,calendar}
}
export function useMemberAvailabilityEditor(){const editor=inject(memberAvailabilityKey);if(!editor)throw new Error('Member availability context is missing');return editor}
