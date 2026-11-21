import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { queryFirst } from '~/server/db'
import { readAgreementTemplate, saveAgreementTemplate } from '~/server/domain/agreement-templates'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { assertProductKind } from '~/shared/product-details'

/** Save the listing's own agreement template, or remove it with `text: null`; answers with the saved text read back. */
export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id'), productId = getRouterParam(event, 'product_id')
  if (!organizationId || !productId) throw new HTTPError({ statusCode: 400, message: 'Organization ID and product ID are required' })
  const body = await readRequiredBody<{ text?: unknown }>(event)
  // Removing takes an explicit `text: null`; a body without `text` is a mistake, not a removal.
  if (!('text' in body)) throw new HTTPError({ statusCode: 400, message: 'text is required: the template, or null to remove it', data: { code: 'VALIDATION_ERROR', field: 'text' } })
  const { env, db, session, organization } = await requireProductAccess(event, organizationId, productId, { agreement_template: body.text })
  const product = await queryFirst<{ kind: string }>(db, 'SELECT kind FROM products WHERE organization_id = ? AND id = ?', [organization.id, productId])
  if (!product) throw new HTTPError({ statusCode: 404, message: 'Product not found', data: { code: 'PRODUCT_NOT_FOUND', field: 'product_id' } })
  await saveAgreementTemplate(env, db, { organizationId: organization.id, userId: session.user.id, productId, kind: assertProductKind(product.kind), text: body.text })
  const saved = await readAgreementTemplate(env, db, organization.id, productId)
  if (saved !== body.text) throw new Error('The saved agreement template did not read back as written')
  return jsonResponse({ text: saved })
})
