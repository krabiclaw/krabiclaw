import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { readToday } from '~/server/domain/today'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { dashboardOrgQueryParam } from '~/server/utils/dashboard-context'

/**
 * Today and Upcoming for the person looking, one list (server/domain/today.ts).
 * After the session, one D1 round trip: the membership by the route's slug and every row.
 */
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } })
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization context is required. Use /dashboard/{orgSlug} routes.', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const range = getQuery(event).range ?? 'today'
  if (range !== 'today' && range !== 'upcoming') throw new HTTPError({ statusCode: 400, message: 'range must be today or upcoming', data: { code: 'INVALID_TODAY_QUERY', field: 'range' } })
  const today = await readToday(env.DB, { slug, userId: session.user.id, range, now: new Date() })
  return jsonResponse(finalizeRequestMetrics(event, 'dashboard-today', today), { headers: { 'cache-control': 'private, no-store' } })
})
