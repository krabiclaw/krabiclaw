import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { readPublicStayCalendar } from '~/server/domain/stays'

/** The nights a guest can choose at a place to stay, with their prices and the home's stay rules. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const slug = getRouterParam(event, 'slug')
  if (!organizationId || !slug) return jsonResponse({ error: 'organizationId and slug required', code: 'STAY_NOT_FOUND', field: 'slug' }, { status: 400 })
  const query = getQuery(event)
  const calendar = await readPublicStayCalendar(cloudflareEnv(event).DB, organizationId, slug, { from: query.from, to: query.to })
  return jsonResponse(calendar, { headers: { 'cache-control': 'private, no-store' } })
})
