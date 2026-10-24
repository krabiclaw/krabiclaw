import { HTTPError } from 'nitro'
import type { McpToolDefinition } from './shared'
import { organizationTool } from './shared'
import type { McpExecutorContext } from './execution'
import { NOT_HANDLED, optionalString, requiredBoolean, requiredString } from './execution'
import { readIntegration } from '~/server/utils/organization-integrations'
import { linkedAccountAccessToken } from '~/server/utils/auth'
import {
  listGoogleAdsCampaigns,
  getGoogleAdsCampaignDetail,
  createGoogleAdsSearchCampaign,
  updateGoogleAdsCampaign,
  getGoogleAdsCustomer,
} from '~/server/utils/google-ads'

async function resolveGoogleAdsCredentials(ctx: McpExecutorContext) {
  const integration = await readIntegration(ctx.organization.db, ctx.organization.organizationId, 'google_ads')
  if (!integration || !integration.account_id || !integration.target_id) {
    throw new HTTPError({
      statusCode: 400,
      statusMessage: 'Google Ads is not connected for this organization. Connect your Google Ads account in Settings -> Integrations first.',
    })
  }

  const { accessToken } = await linkedAccountAccessToken(ctx.organization.env, integration.account_id)
  const developerToken = ctx.organization.env.GOOGLE_ADS_DEVELOPER_TOKEN
  const customerId = integration.target_id

  return { accessToken, developerToken, customerId, integration }
}

export const GOOGLE_ADS_TOOLS: McpToolDefinition[] = [
  organizationTool({
    name: 'list_google_ads_campaigns',
    description: 'List up to 100 non-removed campaigns in the connected Google Ads account, ordered by all-time spend, when reviewing campaign status, daily budget, spend, impressions, clicks and conversions.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
    inputSchema: {
      status: {
        type: 'string',
        enum: ['ENABLED', 'PAUSED', 'ALL'],
        description: 'Filter campaigns by status: ENABLED, PAUSED, or ALL non-removed campaigns (default: ALL).',
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        currency: { type: 'string', description: 'Connected account currency; budget and spend micros are millionths of this currency.' },
        campaigns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              status: { type: 'string' },
              channelType: { type: 'string' },
              budgetAmountMicros: { type: 'number' },
              budgetId: { type: ['string', 'null'] },
              clicks: { type: 'number' },
              impressions: { type: 'number' },
              costMicros: { type: 'number' },
              conversions: { type: 'number' },
            },
            required: ['id', 'name', 'status', 'channelType', 'budgetAmountMicros', 'clicks', 'impressions', 'costMicros', 'conversions'],
          },
        },
      },
      required: ['customer_id', 'currency', 'campaigns'],
    },
  }),
  organizationTool({
    name: 'get_google_ads_campaign',
    description: 'Read a campaign in the connected Google Ads account when inspecting its status, budget, ad groups, keywords, responsive search ad copy or destination URLs.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
    required: ['campaign_id'],
    inputSchema: {
      campaign_id: {
        type: 'string',
        pattern: '^[0-9]+$',
        description: 'Numeric Google Ads campaign ID.',
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        currency: { type: 'string', description: 'Connected account currency; budget and spend micros are millionths of this currency.' },
        name: { type: 'string' },
        status: { type: 'string' },
        channelType: { type: 'string' },
        budgetAmountMicros: { type: 'number' },
        budgetId: { type: ['string', 'null'] },
        clicks: { type: 'number' },
        impressions: { type: 'number' },
        costMicros: { type: 'number' },
        conversions: { type: 'number' },
        adGroups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['id', 'name', 'status'],
          },
        },
        keywords: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              matchType: { type: 'string' },
              status: { type: ['string', 'null'] },
              negative: { type: 'boolean' },
            },
            required: ['text', 'matchType', 'status', 'negative'],
          },
        },
        headlines: { type: 'array', items: { type: 'string' } },
        descriptions: { type: 'array', items: { type: 'string' } },
        finalUrls: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'currency', 'name', 'status', 'channelType', 'budgetAmountMicros', 'clicks', 'impressions', 'costMicros', 'conversions', 'adGroups', 'keywords', 'headlines', 'descriptions', 'finalUrls'],
    },
  }),
  organizationTool({
    name: 'create_google_ads_search_campaign',
    description: 'Create a Google Ads Search campaign from supplied keywords, ad copy, destination URL and daily budget in the account currency returned by list_google_ads_campaigns. Creates one ad group and responsive search ad. Starts PAUSED unless ENABLED is explicitly requested; enabled campaigns can spend the connected account’s advertising budget. Each create call makes a new campaign; inspect the account before retrying an uncertain result.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
    required: ['name', 'daily_budget_micros', 'target_url', 'keywords', 'headlines', 'descriptions', 'contains_eu_political_advertising'],
    inputSchema: {
      name: {
        type: 'string',
        minLength: 1,
        pattern: '\\S',
        description: 'Campaign name.',
      },
      daily_budget_micros: {
        type: 'integer',
        minimum: 1000000,
        description: 'Daily budget in micros (e.g. 10000000 for 10 units in account currency).',
      },
      target_url: {
        type: 'string',
        description: 'Destination landing page or blog post URL (must start with http:// or https://).',
      },
      keywords: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 1 },
            match_type: { type: 'string', enum: ['EXACT', 'PHRASE', 'BROAD'] },
          },
          required: ['text'],
        },
        description: 'Keywords to target with optional match type (default PHRASE).',
      },
      headlines: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 30 },
        minItems: 3,
        maxItems: 15,
        uniqueItems: true,
        description: 'Headlines for Responsive Search Ad (3 to 15, max 30 chars each).',
      },
      descriptions: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 90 },
        minItems: 2,
        maxItems: 4,
        uniqueItems: true,
        description: 'Descriptions for Responsive Search Ad (2 to 4, max 90 chars each).',
      },
      status: {
        type: 'string',
        enum: ['ENABLED', 'PAUSED'],
        description: 'Initial campaign status (defaults to PAUSED).',
      },
      contains_eu_political_advertising: {
        type: 'boolean',
        description: 'Whether the campaign contains EU political advertising. Google requires this self-declaration on every new campaign; ask the user rather than assuming.',
      },
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
    name: 'update_google_ads_campaign',
    description: 'Pause, enable or change the daily budget of a selected campaign in the connected Google Ads account. Supply status, the budget_id/daily_budget_micros pair, or both. Read get_google_ads_campaign or list_google_ads_campaigns for the current budget ID and account currency first. Enabling or raising a budget can increase advertising spend; changing a shared budget affects every campaign using it.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
    required: ['campaign_id'],
    inputSchema: {
      oneOf: [
        { required: ['status'], not: { anyOf: [{ required: ['budget_id'] }, { required: ['daily_budget_micros'] }] } },
        { required: ['budget_id', 'daily_budget_micros'] },
      ],
      campaign_id: {
        type: 'string',
        pattern: '^[0-9]+$',
        description: 'Google Ads campaign ID to update.',
      },
      status: {
        type: 'string',
        enum: ['ENABLED', 'PAUSED'],
        description: 'New campaign status (ENABLED or PAUSED).',
      },
      budget_id: {
        type: 'string',
        pattern: '^[0-9]+$',
        description: 'Budget ID returned for this campaign by get_google_ads_campaign or list_google_ads_campaigns. Required with daily_budget_micros; shared budget changes affect every campaign using it.',
      },
      daily_budget_micros: {
        type: 'integer',
        minimum: 1000000,
        description: 'New daily budget in micros. Required with budget_id.',
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        status: { type: ['string', 'null'] },
        budget_id: { type: ['string', 'null'] },
        daily_budget_micros: { type: ['integer', 'null'] },
      },
      required: ['campaign_id'],
    },
  }),
]

export async function handleGoogleAdsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args } = ctx

  if (toolName === 'list_google_ads_campaigns') {
    const { accessToken, developerToken, customerId } = await resolveGoogleAdsCredentials(ctx)
    const status = (optionalString(args, 'status') ?? undefined) as 'ENABLED' | 'PAUSED' | 'ALL' | undefined
    const [campaigns, account] = await Promise.all([listGoogleAdsCampaigns(accessToken, developerToken, customerId, status), getGoogleAdsCustomer(accessToken, developerToken, customerId)])
    return {
      customer_id: customerId,
      currency: account.currencyCode,
      campaigns,
    }
  }

  if (toolName === 'get_google_ads_campaign') {
    const { accessToken, developerToken, customerId } = await resolveGoogleAdsCredentials(ctx)
    const campaignId = requiredString(args, 'campaign_id')
    const [campaign, account] = await Promise.all([getGoogleAdsCampaignDetail(accessToken, developerToken, customerId, campaignId), getGoogleAdsCustomer(accessToken, developerToken, customerId)])
    return { ...campaign, currency: account.currencyCode }
  }

  if (toolName === 'create_google_ads_search_campaign') {
    const { accessToken, developerToken, customerId } = await resolveGoogleAdsCredentials(ctx)
    const name = requiredString(args, 'name')
    const dailyBudgetAmountMicros = Number(args.daily_budget_micros)
    const targetUrl = requiredString(args, 'target_url')
    const keywordsInput = (args.keywords as Array<{ text: string; match_type?: 'EXACT' | 'PHRASE' | 'BROAD' }>) ?? []
    const keywords = keywordsInput.map(k => ({
      text: k.text,
      matchType: k.match_type ?? 'PHRASE',
    }))
    const headlines = (args.headlines as string[]) ?? []
    const descriptions = (args.descriptions as string[]) ?? []
    const status = (optionalString(args, 'status') as 'ENABLED' | 'PAUSED') ?? 'PAUSED'

    const result = await createGoogleAdsSearchCampaign(accessToken, developerToken, customerId, {
      name,
      dailyBudgetAmountMicros,
      targetUrl,
      keywords,
      headlines,
      descriptions,
      status,
      containsEuPoliticalAdvertising: requiredBoolean(args, 'contains_eu_political_advertising'),
    })

    return {
      campaign_id: result.campaignId,
      status: result.status,
    }
  }

  if (toolName === 'update_google_ads_campaign') {
    const { accessToken, developerToken, customerId } = await resolveGoogleAdsCredentials(ctx)
    const campaignId = requiredString(args, 'campaign_id')
    const status = (optionalString(args, 'status') ?? undefined) as 'ENABLED' | 'PAUSED' | undefined
    const budgetId = optionalString(args, 'budget_id')
    const dailyBudgetAmountMicros = args.daily_budget_micros !== undefined ? Number(args.daily_budget_micros) : undefined

    await updateGoogleAdsCampaign(accessToken, developerToken, customerId, {
      campaignId,
      status,
      budgetId: budgetId ?? undefined,
      dailyBudgetAmountMicros,
    })

    return { campaign_id: campaignId, status: status ?? null, budget_id: budgetId, daily_budget_micros: dailyBudgetAmountMicros ?? null }
  }

  return NOT_HANDLED
}
