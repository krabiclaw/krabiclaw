import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { setPublicConsultationMode } from '~/server/utils/professional-services'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'

export default defineHandler(async event => {
  const { env, db, organization } = await requireOrganizationAccess(event, getRouterParam(event, 'organizationId')!)
  const body = await readStrictBody<{ mode: unknown; external_url?: unknown }>(event, { mode: 'unknown', external_url: 'unknown' })
  const settings = await setPublicConsultationMode(db, organization.id, body.mode as 'native' | 'external_url' | 'native_disabled', body.external_url)
  await purgePublicResourceCacheNow(env, organization.id)
  return jsonResponse(settings)
})
