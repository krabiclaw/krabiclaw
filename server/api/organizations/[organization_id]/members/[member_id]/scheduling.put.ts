import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { memberSchedulingContext } from '~/server/utils/member-scheduling-context'
import { writeMemberScheduling } from '~/server/domain/member-scheduling'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
export default defineHandler(async event=>{const {actor,memberId}=await memberSchedulingContext(event);const scheduling=await writeMemberScheduling(actor,memberId,(await readBody<Parameters<typeof writeMemberScheduling>[2]>(event))!);await purgePublicResourceCacheNow(actor.env,actor.organizationId);return jsonResponse({scheduling})})
