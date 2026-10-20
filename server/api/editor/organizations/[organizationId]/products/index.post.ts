import type { CreateProductInput } from '~/server/types/products'
import { jsonResponse, readRequiredBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { createProduct } from '~/server/utils/product-management'
import type { TenantPageEditorInput } from '~/server/utils/content/pages'
import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'

type ProductPageIntent = Omit<TenantPageEditorInput, 'productId' | 'pageId' | 'locale' | 'path'> & { path?: string }

/** The page intent as the page writer takes it; anything else is the caller's mistake. */
function pageIntent(value: unknown): ProductPageIntent | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.title !== 'string' || (value.path !== undefined && typeof value.path !== 'string')) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'page must be an object with a title and, optionally, a path' })
  }
  return value as unknown as ProductPageIntent
}

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  try {
    const { db, env, session, organization } = await requireOrganizationAccess(event, organizationId)
    const { page, idempotency_key: idempotencyKey, ...product } = await readRequiredBody<CreateProductInput & { page?: unknown; idempotency_key?: string }>(event)
    const intent = pageIntent(page)
    // Creating from a site's editor means that site carries the product. It
    // is NOT published by that act: publication is a separate, explicit state,
    // written with the product so it is carried from the first moment it exists.
    const created = await createProduct(db, {
      organizationId: organization.id,
      env,
      product,
      actor: { actorId: session.user.id },
      publication: { published: false },
      ...(intent ? { page: { data: intent, env } } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    })
    return jsonResponse({ success: true, product: created, organization_id: organizationId }, { status: 201 })
  } catch (error) {
    rethrowHttpError(error)
    console.error('product_create_failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to create product' }, { status: 500 })
  }
})
