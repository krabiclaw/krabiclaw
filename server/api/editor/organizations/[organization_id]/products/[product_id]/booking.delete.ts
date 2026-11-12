import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { deleteProductBookingConfig } from '~/server/utils/availability'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const productId = getRouterParam(event, 'product_id')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization ID and product ID are required' }, { status: 400 })
  const { db, organization } = await requireOrganizationAccess(event, organizationId)
  await deleteProductBookingConfig(db, { organizationId: organization.id, productId })
  return jsonResponse({ success: true, product_id: productId })
})
