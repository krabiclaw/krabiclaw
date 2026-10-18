import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { loadGoogleAdsInsights } from '~/server/utils/google-ads-insights'
import { googleAdsInsightsSchema } from '~/shared/google-ads-insights'

/** Insights → Google Ads: the connected account's results for the requested range. */
export default defineHandler(async (event) => {
  const { organization } = await getDashboardContext(event, {})
  if (!organization) throw new HTTPError({ statusCode: 403, statusMessage: 'Organization access required' })
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { analytics: ['read'] } })
  const query = getQuery(event)
  return jsonResponse(googleAdsInsightsSchema.parse(await loadGoogleAdsInsights(cloudflareEnv(event), organization.id, {
    startDate: typeof query.startDate === 'string' ? query.startDate : undefined,
    endDate: typeof query.endDate === 'string' ? query.endDate : undefined,
  })), { headers: { 'cache-control': 'private, no-store' } })
})
