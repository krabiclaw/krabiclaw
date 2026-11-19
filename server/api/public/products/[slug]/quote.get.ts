import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { preparePublicTimedQuote, type PublicTimedQuoteRead } from '~/server/domain/product-bookings'
import { executeBatch } from '~/server/db'
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
  const preloaded = event.context.timedQuote as PublicTimedQuoteRead | undefined
  const prepared = preloaded?.slug === slug ? preloaded : undefined
  const plan = prepared?.plan ?? preparePublicTimedQuote({ query: '?', params: [organizationId] }, { ...query, slug })
  const result = await plan.read(env, organizationId, prepared?.rows ?? await executeBatch(db, plan.queries, { operation: 'Read booking quote terms' }))
  const quote = result.unit === 'nights'
    ? { unit: 'nights' as const, ...await quoteStay(db, organizationId, await readPublicStayHome(db, organizationId, result.productId), {
      check_in_date: query.check_in_date, check_out_date: query.check_out_date,
      adults: whole(query.adults), children: query.children === undefined ? 0 : whole(query.children), infants: query.infants === undefined ? 0 : whole(query.infants),
    }) }
    : result
  return jsonResponse({ quote }, { headers: { 'cache-control': 'private, no-store' } })
})
