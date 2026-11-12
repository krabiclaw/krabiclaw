import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { quoteTimedBooking } from '~/server/domain/product-bookings'
import { queryFirst } from '~/server/db'
import { quoteStay, readPublicStayHome } from '~/server/domain/stays'

/** What a stay costs for these nights and guests, or the rule it breaks, named by code and field. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const slug = getRouterParam(event, 'slug')
  if (!organizationId || !slug) return jsonResponse({ error: 'organizationId and slug required', code: 'STAY_NOT_FOUND', field: 'slug' }, { status: 400 })
  const env = cloudflareEnv(event)
  const db = env.DB
  const query = getQuery(event)
  const whole = (value: unknown) => typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : value
  const product = await queryFirst<{ kind: string }>(db, 'SELECT kind FROM products WHERE organization_id=? AND slug=?', [organizationId, slug])
  if (!product) throw new HTTPError({ statusCode: 404, message: 'Product not found' })
  const quote = product.kind === 'stay'
    ? { unit: 'nights' as const, ...await quoteStay(db, organizationId, await readPublicStayHome(db, organizationId, slug), {
      check_in_date: query.check_in_date, check_out_date: query.check_out_date,
      adults: whole(query.adults), children: query.children === undefined ? 0 : whole(query.children), infants: query.infants === undefined ? 0 : whole(query.infants),
    }) }
    : await quoteTimedBooking(db, env, { organizationId, slug, product_session_id: query.product_session_id,
      product_variant_id: query.product_variant_id, party_size: whole(query.party_size) })
  return jsonResponse({ quote }, { headers: { 'cache-control': 'private, no-store' } })
})
