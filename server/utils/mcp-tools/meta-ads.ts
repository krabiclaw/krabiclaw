import { HTTPError } from 'nitro'
import type { McpToolDefinition } from './shared'
import { organizationTool } from './shared'
import type { McpExecutorContext } from './execution'
import { NOT_HANDLED, optionalString, requiredString } from './execution'
import { readIntegration } from '~/server/utils/organization-integrations'
import { linkedAccountAccessToken } from '~/server/utils/auth'
import {
  listMetaAdsCampaigns,
  createMetaAdsCampaign,
  updateMetaAdsCampaign,
  getMetaAdsPerformanceSummary,
  getMetaCampaignAccountId,
  rawMetaAdAccountId,
} from '~/server/utils/meta-ads'

async function resolveMetaAdsCredentials(ctx: McpExecutorContext) {
  const integration = await readIntegration(ctx.organization.db, ctx.organization.organizationId, 'meta_ads')
  if (!integration || !integration.account_id || !integration.target_id) {
    throw new HTTPError({
      statusCode: 400,
      statusMessage: 'Meta Ads is not connected for this organization. Connect your Meta Ads account in Settings -> Integrations first.',
    })
  }

  const { accessToken } = await linkedAccountAccessToken(ctx.organization.env, integration.account_id)
  const adAccountId = integration.target_id
  return { accessToken, adAccountId, integration }
}

export const META_ADS_TOOLS: McpToolDefinition[] = [
  organizationTool({
    name: 'list_meta_ads_campaigns',
    description: 'List up to 100 campaigns in the connected Meta Ad Account, with status, objective, and daily budget.',
    domain: 'meta_ads',
    minimumRole: 'admin',
    inputSchema: {},
    outputSchema: {
      type: 'object',
      properties: {
        ad_account_id: { type: 'string' },
        campaigns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              status: { type: 'string' },
              objective: { type: ['string', 'null'] },
              daily_budget: { type: ['string', 'null'] },
            },
            required: ['id', 'name', 'status'],
          },
        },
      },
      required: ['ad_account_id', 'campaigns'],
    },
  }),

  organizationTool({
    name: 'query_meta_ads_report',
    description: 'Query Meta Ads performance summary (spend, impressions, reach, clicks, conversions) for a given date range.',
    domain: 'meta_ads',
    minimumRole: 'admin',
    inputSchema: {
      start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Start date YYYY-MM-DD.' },
      end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'End date YYYY-MM-DD.' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ad_account_id: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        cost_cents: { type: 'number' },
        impressions: { type: 'number' },
        reach: { type: 'number' },
        clicks: { type: 'number' },
        conversions: { type: 'number' },
        currency: { type: 'string' },
      },
      required: ['ad_account_id', 'start_date', 'end_date', 'cost_cents', 'impressions', 'reach', 'clicks', 'conversions'],
    },
  }),

  organizationTool({
    name: 'create_meta_ads_campaign',
    description: 'Create a new campaign in PAUSED status in the connected Meta Ad Account.',
    domain: 'meta_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'google_ads_management',
    inputSchema: {
      name: { type: 'string', description: 'Campaign name' },
      daily_budget_cents: { type: 'integer', minimum: 1, description: 'Daily budget in cents (e.g. 1000 for $10.00)' },
      objective: { type: 'string', enum: ['OUTCOME_TRAFFIC', 'OUTCOME_LEADS', 'OUTCOME_AWARENESS'], description: 'Campaign objective (default: OUTCOME_TRAFFIC)' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['campaign_id', 'status'],
    },
  }),

  organizationTool({
    name: 'update_meta_ads_campaign',
    description: 'Update the status or daily budget of an existing Meta Ads campaign.',
    domain: 'meta_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'google_ads_management',
    inputSchema: {
      campaign_id: { type: 'string', pattern: '^\\d+$', description: 'Meta campaign ID' },
      status: { type: 'string', enum: ['ACTIVE', 'PAUSED'], description: 'Campaign status' },
      daily_budget_cents: { type: 'integer', minimum: 1, description: 'New daily budget in cents' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        success: { type: 'boolean' },
      },
      required: ['campaign_id', 'success'],
    },
  }),
]

export async function handleMetaAdsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args } = ctx

  if (toolName === 'list_meta_ads_campaigns') {
    const { accessToken, adAccountId } = await resolveMetaAdsCredentials(ctx)
    const campaigns = await listMetaAdsCampaigns(accessToken, adAccountId)
    return {
      ad_account_id: adAccountId,
      campaigns: campaigns.map(c => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective ?? null,
        daily_budget: c.dailyBudget ?? null,
      })),
    }
  }

  if (toolName === 'query_meta_ads_report') {
    const { accessToken, adAccountId } = await resolveMetaAdsCredentials(ctx)
    const startDate = requiredString(args, 'start_date')
    const endDate = requiredString(args, 'end_date')
    const summary = await getMetaAdsPerformanceSummary(accessToken, adAccountId, startDate, endDate)
    return {
      ad_account_id: adAccountId,
      start_date: startDate,
      end_date: endDate,
      cost_cents: summary.costCents,
      impressions: summary.impressions,
      reach: summary.reach,
      clicks: summary.clicks,
      conversions: summary.conversions,
      currency: summary.currency,
    }
  }

  if (toolName === 'create_meta_ads_campaign') {
    const { accessToken, adAccountId } = await resolveMetaAdsCredentials(ctx)
    const name = requiredString(args, 'name')
    const dailyBudgetCents = typeof args.daily_budget_cents === 'number' ? args.daily_budget_cents : undefined
    const objective = optionalString(args, 'objective') ?? undefined
    const result = await createMetaAdsCampaign(accessToken, adAccountId, { name, dailyBudgetCents, objective })
    return { campaign_id: result.id, status: 'PAUSED' }
  }

  if (toolName === 'update_meta_ads_campaign') {
    const { accessToken, adAccountId } = await resolveMetaAdsCredentials(ctx)
    const campaignId = requiredString(args, 'campaign_id')
    const owningAccountId = await getMetaCampaignAccountId(accessToken, campaignId)
    if (owningAccountId !== rawMetaAdAccountId(adAccountId)) {
      throw new HTTPError({ statusCode: 404, statusMessage: 'That campaign is not in the connected Meta Ad Account.' })
    }
    const status = (optionalString(args, 'status') ?? undefined) as 'ACTIVE' | 'PAUSED' | undefined
    const dailyBudgetCents = typeof args.daily_budget_cents === 'number' ? args.daily_budget_cents : undefined
    const result = await updateMetaAdsCampaign(accessToken, campaignId, { status, dailyBudgetCents })
    return { campaign_id: campaignId, success: result.success }
  }

  return NOT_HANDLED
}
