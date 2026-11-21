import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { readAgreementTemplate } from '~/server/domain/agreement-templates'
import { jsonResponse } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'

/** The listing's own agreement template text, or null when it has none. */
export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id'), productId = getRouterParam(event, 'product_id')
  if (!organizationId || !productId) throw new HTTPError({ statusCode: 400, message: 'Organization ID and product ID are required' })
  const { env, db, organization } = await requireProductAccess(event, organizationId, productId)
  return jsonResponse({ text: await readAgreementTemplate(env, db, organization.id, productId) }, { headers: { 'cache-control': 'private, no-store' } })
})
