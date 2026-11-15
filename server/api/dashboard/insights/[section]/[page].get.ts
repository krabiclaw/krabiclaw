import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { insightsReader, readInsightsPage } from '~/server/domain/insights'

/** One Insights page (`GET /api/dashboard/insights/<section>/<page>?kind=&location_id=&start_date=&end_date=`), in one read. */
export default defineHandler(async (event) => {
  const { db, userId, organization } = await getDashboardMemberContext(event, {})
  const query = getQuery(event)
  const value = (name: string) => typeof query[name] === 'string' ? query[name] as string : undefined
  return jsonResponse(await readInsightsPage(db, await insightsReader(organization, userId), `${getRouterParam(event, 'section')}/${getRouterParam(event, 'page')}`, {
    kind: value('kind'), location_id: value('location_id'), start_date: value('start_date'), end_date: value('end_date'),
  }), { headers: { 'cache-control': 'private, no-store' } })
})
