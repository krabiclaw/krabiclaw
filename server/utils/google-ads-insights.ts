import { linkedAccountAccessToken, readLinkedAccount, type CloudflareEnv } from '~/server/utils/auth'
import { readIntegration } from '~/server/utils/organization-integrations'
import { resolveOrganizationAnalyticsContext } from '~/server/utils/analytics-report'
import { parseAnalyticsRange } from '~/server/utils/analytics-calendar'
import { getGoogleAdsCustomer, getGoogleAdsPerformanceSummary, listGoogleAdsCampaigns } from '~/server/utils/google-ads'
import { listServices } from '~/server/utils/organization-services'
import type { GoogleAdsInsights } from '~/shared/google-ads-insights'

/**
 * Insights → Google Ads: the connected account's spend, clicks, impressions and
 * conversions for the range, in the organization's calendar days, plus its
 * campaigns by spend. Google's own failures are thrown with its message.
 */
export async function loadGoogleAdsInsights(env: CloudflareEnv, organizationId: string, query: { startDate?: string; endDate?: string }): Promise<GoogleAdsInsights> {
  const connection = await readIntegration(env.DB, organizationId, 'google_ads')
  if (!connection) return { status: 'not_connected', message: 'No Google Ads account is connected. Connect one in Menu → Integrations → Google Ads.' }
  const account = await readLinkedAccount(env, connection.account_id)
  if (!account) return { status: 'account_unlinked', message: 'The Google login this connection was made through is no longer linked. Connect Google Ads again.' }
  const context = await resolveOrganizationAnalyticsContext(env.DB, organizationId)
  const range = parseAnalyticsRange({ startDate: query.startDate, endDate: query.endDate, timeZone: context.timezone, now: new Date() })
  const { accessToken } = await linkedAccountAccessToken(env, connection.account_id)
  // The currency is the account's, read on its own: a quiet range returns no metric rows at all.
  const [customer, summary, campaigns, services] = await Promise.all([
    getGoogleAdsCustomer(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, connection.target_id),
    getGoogleAdsPerformanceSummary(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, connection.target_id, range.startDate, range.endDate),
    listGoogleAdsCampaigns(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, connection.target_id, 'ALL', { startDate: range.startDate, endDate: range.endDate }),
    listServices(env.DB, organizationId),
  ])
  return {
    status: 'connected',
    customer: { id: connection.target_id, name: connection.target_name, currency: customer.currencyCode },
    period: { startDate: range.startDate, endDate: range.endDate },
    totals: { costMicros: summary.costMicros, clicks: summary.clicks, impressions: summary.impressions, conversions: summary.conversions, averageCpcMicros: summary.averageCpcMicros },
    // A removed campaign belongs in the range only by what it spent there.
    campaigns: campaigns
      .filter(campaign => campaign.status !== 'REMOVED' || campaign.costMicros > 0 || campaign.clicks > 0 || campaign.impressions > 0)
      .map(campaign => ({ id: campaign.id, name: campaign.name, status: campaign.status, costMicros: campaign.costMicros, clicks: campaign.clicks, impressions: campaign.impressions, conversions: campaign.conversions }))
      .sort((a, b) => b.costMicros - a.costMicros),
    managed: services.managed_ads !== null,
  }
}
