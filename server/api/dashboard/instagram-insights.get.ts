import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { loadInstagramInsights } from '~/server/utils/instagram-insights'
import { instagramInsightsSchema } from '~/shared/instagram-insights'

/** Insights → Instagram: the connected account's insights for the requested range. */
export default defineHandler(async (event) => {
  const { organization } = await getDashboardContext(event, {})
  if (!organization) throw new HTTPError({ statusCode: 403, statusMessage: 'Organization access required' })
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { analytics: ['read'] } })
  const query = getQuery(event)
  return jsonResponse(instagramInsightsSchema.parse(await loadInstagramInsights(cloudflareEnv(event), organization.id, {
    startDate: typeof query.start_date === 'string' ? query.start_date : undefined,
    endDate: typeof query.end_date === 'string' ? query.end_date : undefined,
  })), { headers: { 'cache-control': 'private, no-store' } })
})
