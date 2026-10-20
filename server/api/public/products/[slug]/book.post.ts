import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { createProductBooking, createStayBooking } from '~/server/domain/product-bookings'
import { queryFirst } from '~/server/db'

export default defineHandler(async event => {
  const organizationId = event.context.organizationId as string | undefined
  const slug = getRouterParam(event, 'slug')
  if (!organizationId || !slug) return jsonResponse({ error: 'organizationId and slug required' }, { status: 400 })
  let body: Record<string, unknown>
  try { body = await readRequiredBody<Record<string, unknown>>(event) } catch { return jsonResponse({ error: 'Invalid request body' }, { status: 400 }) }
  // A place to stay is booked by its nights; every other product by a session.
  const product = await queryFirst<{ kind: string }>(cloudflareEnv(event).DB, 'SELECT kind FROM products WHERE organization_id = ? AND slug = ?', [organizationId, slug])
  const result = product?.kind === 'stay' ? await createStayBooking(event, { organizationId, slug, body }) : await createProductBooking(event, { organizationId, slug, body })
  return jsonResponse(result.body, { status: result.status })
})
