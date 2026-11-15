import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { insightsReader, readInsightsIndex } from '~/server/domain/insights'

/** Insights: what the business books, its locations, and the pages this member may open. */
export default defineHandler(async (event) => {
  const { db, userId, organization } = await getDashboardMemberContext(event, {})
  return jsonResponse(await readInsightsIndex(db, await insightsReader(organization, userId)), { headers: { 'cache-control': 'private, no-store' } })
})
