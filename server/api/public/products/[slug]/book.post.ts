import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { createProductBooking, type BookingCreationRead } from '~/server/domain/product-bookings'

export default defineHandler(async event => {
  const organizationId = event.context.organizationId as string | undefined
  const slug = getRouterParam(event, 'slug')
  if (!organizationId || !slug) return jsonResponse({ error: 'organizationId and slug required' }, { status: 400 })
  if (event.context.checkoutBodyError) return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  let body: Record<string, unknown>
  try { body = (event.context.checkoutBody as Record<string, unknown> | undefined) ?? await readRequiredBody<Record<string, unknown>>(event) } catch { return jsonResponse({ error: 'Invalid request body' }, { status: 400 }) }
  const prepared = event.context.bookingCreation as { slug: string; facts: BookingCreationRead } | undefined
  const result = await createProductBooking(event, { organizationId, slug, body }, prepared?.slug === slug ? prepared.facts : undefined)
  return jsonResponse(result.body, { status: result.status })
})
