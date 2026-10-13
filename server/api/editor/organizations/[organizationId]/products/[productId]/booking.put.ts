import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { setProductBookingConfig } from '~/server/utils/availability'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const productId = getRouterParam(event, 'productId')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization ID and product ID are required' }, { status: 400 })
  const body = await readStrictBody<Parameters<typeof setProductBookingConfig>[1]['patch']>(event, { duration_minutes: 'unknown', default_capacity: 'unknown', confirmation_mode: 'unknown', online_payment_required: 'unknown', held_online: 'unknown', scheduling_mode: 'unknown', assigned_member_id: 'unknown', assigned_team_id: 'unknown' })
  const { env, db, session, organization } = await requireProductAccess(event, organizationId, productId, body as Record<string, unknown>)
  await setProductBookingConfig(db, { organizationId: organization.id, productId, actorId: session.user.id, env, patch: body })
  await purgePublicResourceCacheNow(env, organization.id)
  return jsonResponse({ success: true, product_id: productId })
})
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
