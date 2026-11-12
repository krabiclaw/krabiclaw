import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { getPublicConsultationSettings } from '~/server/utils/professional-services'
import { jsonResponse } from '~/server/utils/api-response'

export default defineHandler(async event => {
  const { db, organization } = await requireOrganizationAccess(event, getRouterParam(event, 'organization_id')!)
  return jsonResponse(await getPublicConsultationSettings(db, organization.id))
})
