import { defineHandler, HTTPError } from 'nitro'
import { readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { memberSchedulingContext } from '~/server/utils/member-scheduling-context'
import { connectPersonalCalendar, readMemberScheduling, selectBusyCalendars } from '~/server/domain/member-scheduling'
export default defineHandler(async event => {
 const {actor,memberId}=await memberSchedulingContext(event)
 const body=await readBody<{enabled?:boolean;account_id?:string}>(event)
 if(typeof body?.enabled!=='boolean' || (body.enabled && (typeof body.account_id!=='string' || !body.account_id)))throw new HTTPError({statusCode:400,message:'Choose whether to avoid double bookings.'})
 if(body.enabled) await connectPersonalCalendar(actor,memberId,body.account_id!)
 else {
  const current=await readMemberScheduling(actor.env.DB,actor.env,actor.organizationId,memberId)
  await selectBusyCalendars(actor,memberId,{account_id:current?.calendar_account_id??null,calendar_ids:[]})
 }
 return jsonResponse({scheduling:await readMemberScheduling(actor.env.DB,actor.env,actor.organizationId,memberId)})
})
