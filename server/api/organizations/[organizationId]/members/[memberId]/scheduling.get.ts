import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { memberSchedulingContext } from '~/server/utils/member-scheduling-context'
import { readMemberScheduling } from '~/server/domain/member-scheduling'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
// The schedule, and whether the plan lets this member sync their calendar: the one read the leaf needs.
export default defineHandler(async event=>{const {actor,memberId}=await memberSchedulingContext(event);return jsonResponse({scheduling:await readMemberScheduling(actor.env.DB,actor.organizationId,memberId),calendar_sync:await hasOrganizationEntitlement(actor.env,actor.organizationId,'calendar_sync')})})
