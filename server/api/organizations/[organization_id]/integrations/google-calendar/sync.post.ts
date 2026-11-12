import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'

import { syncCalendarOrganization } from '~/server/utils/google-calendar'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'organization_id')
  if (!id) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { env, organization } = await requireOrganizationAccess(event, id)
  const result=await syncCalendarOrganization(env,organization.id)
  if(result.failed)return jsonResponse({error:'Your calendar could not be synced. Try again.',...result},{status:502})
  return jsonResponse({success:true,...result})
})
