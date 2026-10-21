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
  cloneGoogleAdsCampaign,
  updateGoogleAdsCampaignStatus,
  updateGoogleAdsCampaignBudget,
} from '~/server/utils/google-ads'

export async function resolveGoogleAdsCredentials(ctx: McpExecutorContext) {
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
    description: 'List Google Ads campaigns for the connected Google Ads account, including status, daily budget, spend, impressions, clicks, and conversions.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
    inputSchema: {
      status: {
        type: 'string',
        enum: ['ENABLED', 'PAUSED', 'ALL'],
        description: 'Filter campaigns by status: ENABLED, PAUSED, or ALL (default: ALL).',
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
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
      required: ['customer_id', 'campaigns'],
    },
  }),
  organizationTool({
    name: 'get_google_ads_campaign',
    description: 'Read full details of a Google Ads campaign, including its budget, ad groups, criteria/keywords, and responsive search ad headlines, descriptions, and final URLs.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
    required: ['campaign_id'],
    inputSchema: {
      campaign_id: {
        type: 'string',
        description: 'Numeric Google Ads campaign ID.',
      },
    },
    outputSchema: {
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
            },
            required: ['text', 'matchType'],
          },
        },
        headlines: { type: 'array', items: { type: 'string' } },
        descriptions: { type: 'array', items: { type: 'string' } },
        finalUrls: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'name', 'status', 'channelType', 'budgetAmountMicros', 'clicks', 'impressions', 'costMicros', 'conversions', 'adGroups', 'keywords', 'headlines', 'descriptions', 'finalUrls'],
    },
  }),
  organizationTool({
    name: 'create_google_ads_search_campaign',
    description: 'Create and launch a new Google Ads Search campaign with an atomic mutate batch including daily budget, campaign, ad group, keywords, and responsive search ad.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
    required: ['name', 'daily_budget_micros', 'target_url', 'keywords', 'headlines', 'descriptions', 'contains_eu_political_advertising'],
    inputSchema: {
      name: {
        type: 'string',
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
            text: { type: 'string' },
            match_type: { type: 'string', enum: ['EXACT', 'PHRASE', 'BROAD'] },
          },
          required: ['text'],
        },
        description: 'Keywords to target with optional match type (defaults to PHRASE).',
      },
      headlines: {
        type: 'array',
        items: { type: 'string', maxLength: 30 },
        minItems: 3,
        maxItems: 15,
        description: 'Headlines for Responsive Search Ad (3 to 15, max 30 chars each).',
      },
      descriptions: {
        type: 'array',
        items: { type: 'string', maxLength: 90 },
        minItems: 2,
        maxItems: 4,
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
        resource_name: { type: 'string' },
        budget_resource_name: { type: 'string' },
        ad_group_resource_name: { type: 'string' },
        ad_resource_name: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['campaign_id', 'resource_name', 'budget_resource_name', 'ad_group_resource_name', 'ad_resource_name', 'status'],
    },
  }),
  organizationTool({
    name: 'clone_google_ads_campaign',
    description: 'Clone an existing Google Ads campaign structure for a new landing page or blog post, copying keywords, updating destination URL, and adapting ad headlines and daily budget.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
    required: ['source_campaign_id', 'new_campaign_name', 'target_url', 'contains_eu_political_advertising'],
    inputSchema: {
      source_campaign_id: {
        type: 'string',
        description: 'Google Ads campaign ID of the template campaign to clone.',
      },
      new_campaign_name: {
        type: 'string',
        description: 'Name for the cloned campaign.',
      },
      target_url: {
        type: 'string',
        description: 'Destination landing page or blog post URL for the new campaign.',
      },
      daily_budget_micros: {
        type: 'integer',
        minimum: 1000000,
        description: 'Optional daily budget in micros. Defaults to the source campaign budget.',
      },
      headline_replacements: {
        type: 'object',
        description: 'Optional mapping of text patterns to replace in source ad headlines (e.g. {"Old Title": "New Title"}).',
      },
      additional_keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional additional keywords to include.',
      },
      status: {
        type: 'string',
        enum: ['ENABLED', 'PAUSED'],
        description: 'Initial status of the cloned campaign (default PAUSED).',
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
        resource_name: { type: 'string' },
        budget_resource_name: { type: 'string' },
        ad_group_resource_name: { type: 'string' },
        ad_resource_name: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['campaign_id', 'resource_name', 'budget_resource_name', 'ad_group_resource_name', 'ad_resource_name', 'status'],
    },
  }),
  organizationTool({
    name: 'update_google_ads_campaign',
    description: 'Update the status (ENABLED/PAUSED) or daily budget of an existing Google Ads campaign.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
    required: ['campaign_id'],
    inputSchema: {
      campaign_id: {
        type: 'string',
        description: 'Google Ads campaign ID to update.',
      },
      status: {
        type: 'string',
        enum: ['ENABLED', 'PAUSED'],
        description: 'New campaign status (ENABLED or PAUSED).',
      },
      budget_id: {
        type: 'string',
        description: 'Optional budget ID when updating daily budget.',
      },
      daily_budget_micros: {
        type: 'integer',
        minimum: 1000000,
        description: 'Optional new daily budget in micros.',
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
    const status = optionalString(args, 'status') as 'ENABLED' | 'PAUSED' | 'ALL' | undefined
    const campaigns = await listGoogleAdsCampaigns(accessToken, developerToken, customerId, status)
    return {
      customer_id: customerId,
      campaigns,
    }
  }

  if (toolName === 'get_google_ads_campaign') {
    const { accessToken, developerToken, customerId } = await resolveGoogleAdsCredentials(ctx)
    const campaignId = requiredString(args, 'campaign_id')
    return await getGoogleAdsCampaignDetail(accessToken, developerToken, customerId, campaignId)
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
      resource_name: result.resourceName,
      budget_resource_name: result.budgetResourceName,
      ad_group_resource_name: result.adGroupResourceName,
      ad_resource_name: result.adResourceName,
      status: result.status,
    }
  }

  if (toolName === 'clone_google_ads_campaign') {
    const { accessToken, developerToken, customerId } = await resolveGoogleAdsCredentials(ctx)
    const sourceCampaignId = requiredString(args, 'source_campaign_id')
    const newCampaignName = requiredString(args, 'new_campaign_name')
    const targetUrl = requiredString(args, 'target_url')
    const dailyBudgetAmountMicros = args.daily_budget_micros !== undefined ? Number(args.daily_budget_micros) : undefined
    const headlineReplacements = args.headline_replacements as Record<string, string> | undefined
    const additionalKeywords = args.additional_keywords as string[] | undefined
    const status = (optionalString(args, 'status') as 'ENABLED' | 'PAUSED') ?? 'PAUSED'

    const result = await cloneGoogleAdsCampaign(accessToken, developerToken, customerId, {
      sourceCampaignId,
      newCampaignName,
      targetUrl,
      dailyBudgetAmountMicros,
      headlineReplacements,
      additionalKeywords,
      status,
      containsEuPoliticalAdvertising: requiredBoolean(args, 'contains_eu_political_advertising'),
    })

    return {
      campaign_id: result.campaignId,
      resource_name: result.resourceName,
      budget_resource_name: result.budgetResourceName,
      ad_group_resource_name: result.adGroupResourceName,
      ad_resource_name: result.adResourceName,
      status: result.status,
    }
  }

  if (toolName === 'update_google_ads_campaign') {
    const { accessToken, developerToken, customerId } = await resolveGoogleAdsCredentials(ctx)
    const campaignId = requiredString(args, 'campaign_id')
    const status = optionalString(args, 'status') as 'ENABLED' | 'PAUSED' | undefined
    const budgetId = optionalString(args, 'budget_id')
    const dailyBudgetAmountMicros = args.daily_budget_micros !== undefined ? Number(args.daily_budget_micros) : undefined

    let updatedStatus: string | null = null
    let updatedBudgetId: string | null = null
    let updatedBudgetAmount: number | null = null

    if (status) {
      await updateGoogleAdsCampaignStatus(accessToken, developerToken, customerId, campaignId, status)
      updatedStatus = status
    }

    if (budgetId && dailyBudgetAmountMicros) {
      await updateGoogleAdsCampaignBudget(accessToken, developerToken, customerId, budgetId, dailyBudgetAmountMicros)
      updatedBudgetId = budgetId
      updatedBudgetAmount = dailyBudgetAmountMicros
    }

    return {
      campaign_id: campaignId,
      status: updatedStatus,
      budget_id: updatedBudgetId,
      daily_budget_micros: updatedBudgetAmount,
    }
  }

  return NOT_HANDLED
}
