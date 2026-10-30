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
  getGoogleAdsReport,
  GOOGLE_ADS_REPORTS,
  type GoogleAdsReport,
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

/** Calendar days in the account's time zone: both or neither, unless the report needs them. */
function reportRange(args: Record<string, unknown>, required: boolean): { startDate: string; endDate: string } | null {
  const startDate = optionalString(args, 'start_date')
  const endDate = optionalString(args, 'end_date')
  if (!startDate && !endDate && !required) return null
  if (!startDate || !endDate) throw new HTTPError({ statusCode: 400, statusMessage: 'Supply start_date and end_date together (YYYY-MM-DD).' })
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/u.test(endDate) || startDate > endDate) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'start_date and end_date must be YYYY-MM-DD with start_date on or before end_date.' })
  }
  return { startDate, endDate }
}

export const GOOGLE_ADS_TOOLS: McpToolDefinition[] = [
  organizationTool({
    name: 'list_google_ads_campaigns',
    description: 'List up to 100 campaigns in the connected Google Ads account, most spend first, with status, daily budget, spend, impressions, clicks and conversions. With start_date and end_date the metrics cover those days in the account time zone and include campaigns removed since; without them they are all-time for campaigns not removed. Reading is free with the connection.',
    domain: 'google_ads',
    minimumRole: 'admin',
    inputSchema: {
      status: {
        type: 'string',
        enum: ['ENABLED', 'PAUSED', 'ALL'],
        description: 'Filter campaigns by status: ENABLED, PAUSED, or ALL non-removed campaigns (default: ALL).',
      },
      start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First day of the metrics, YYYY-MM-DD in the account time zone. Requires end_date.' },
      end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Last day of the metrics, inclusive. Requires start_date.' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        currency: { type: 'string', description: 'Connected account currency; budget and spend micros are millionths of this currency.' },
        time_zone: { type: 'string', description: 'The account time zone the dates are in.' },
        start_date: { type: ['string', 'null'] },
        end_date: { type: ['string', 'null'] },
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
      required: ['customer_id', 'currency', 'time_zone', 'start_date', 'end_date', 'campaigns'],
    },
  }),
  organizationTool({
    name: 'get_google_ads_campaign',
    description: 'Read a campaign in the connected Google Ads account when inspecting its status, budget, ad groups, keywords, responsive search ad copy or destination URLs.',
    domain: 'google_ads',
    minimumRole: 'admin',
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
    name: 'query_google_ads_report',
    description: 'Read a Google Ads report for chosen days from the connected account: campaign_daily (each campaign per day), search_terms, keywords, landing_pages or geography (countries), with impressions, clicks, spend, conversions and conversion value. Dates are in the account time zone; spend is micros of the account currency. Google omits low-volume search terms for privacy, so a missing term is not zero demand. Reading is free with the connection.',
    domain: 'google_ads',
    minimumRole: 'admin',
    required: ['report', 'start_date', 'end_date'],
    inputSchema: {
      report: { type: 'string', enum: [...GOOGLE_ADS_REPORTS], description: 'campaign_daily: each campaign per day; search_terms: what people searched; keywords: the keywords that matched; landing_pages: the final URLs ads sent people to; geography: the countries clicks came from.' },
      start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First day, YYYY-MM-DD in the account time zone.' },
      end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Last day, inclusive.' },
      campaign_id: { type: 'string', pattern: '^[0-9]+$', description: 'Only this campaign.' },
      limit: { type: 'integer', minimum: 1, maximum: 10000, description: 'Rows to return, most clicks first; campaign_daily is by day (default 100).' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        currency: { type: 'string', description: 'Connected account currency; costMicros are millionths of it.' },
        time_zone: { type: 'string' },
        report: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The campaign, search term, keyword, landing page URL or country.' },
              detail: { type: ['string', 'null'], description: 'keywords: match type; search_terms: whether the term was added or excluded; geography: physical presence or area of interest.' },
              date: { type: ['string', 'null'], description: 'campaign_daily: the day.' },
              campaignId: { type: ['string', 'null'] },
              campaignName: { type: ['string', 'null'] },
              adGroupId: { type: ['string', 'null'] },
              impressions: { type: 'number' },
              clicks: { type: 'number' },
              costMicros: { type: 'number' },
              conversions: { type: 'number' },
              conversionsValue: { type: 'number' },
            },
            required: ['text', 'detail', 'date', 'campaignId', 'campaignName', 'adGroupId', 'impressions', 'clicks', 'costMicros', 'conversions', 'conversionsValue'],
          },
        },
      },
      required: ['customer_id', 'currency', 'time_zone', 'report', 'start_date', 'end_date', 'rows'],
    },
  }),
  organizationTool({
    name: 'create_google_ads_search_campaign',
    description: 'Create a paused Google Ads Search campaign with one ad group and responsive search ad from the supplied keywords, copy, destination and daily budget. The campaign cannot serve ads until separately enabled. Each call creates a new campaign; inspect the account before retrying an uncertain result.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'google_ads_management',
    required: ['name', 'daily_budget_micros', 'target_url', 'keywords', 'headlines', 'descriptions', 'contains_eu_political_advertising'],
    inputSchema: {
      name: {
        type: 'string',
        minLength: 1,
        pattern: '^[\\s\\S]*\\S[\\s\\S]*$',
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
      contains_eu_political_advertising: {
        type: 'boolean',
        description: 'Whether the campaign contains EU political advertising. Google requires this self-declaration on every new campaign; ask the user rather than assuming.',
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        status: { const: 'PAUSED' },
      },
      required: ['campaign_id', 'status'],
    },
  }),
  organizationTool({
    name: 'update_google_ads_campaign',
    description: 'Pause, enable or change the daily budget of a selected campaign in the connected Google Ads account. Supply status, the budget_id/daily_budget_micros pair, or both. Read get_google_ads_campaign or list_google_ads_campaigns for the current budget ID and account currency first. Enabling or raising a budget can increase advertising spend; changing a shared budget affects every campaign using it.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'google_ads_management',
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
    const range = reportRange(args, false)
    const [campaigns, account] = await Promise.all([listGoogleAdsCampaigns(accessToken, developerToken, customerId, status, range ?? undefined), getGoogleAdsCustomer(accessToken, developerToken, customerId)])
    return {
      customer_id: customerId,
      currency: account.currencyCode,
      time_zone: account.timeZone,
      start_date: range?.startDate ?? null,
      end_date: range?.endDate ?? null,
      campaigns,
    }
  }

  if (toolName === 'query_google_ads_report') {
    const { accessToken, developerToken, customerId } = await resolveGoogleAdsCredentials(ctx)
    const report = requiredString(args, 'report') as GoogleAdsReport
    if (!GOOGLE_ADS_REPORTS.includes(report)) throw new HTTPError({ statusCode: 400, statusMessage: `report must be one of ${GOOGLE_ADS_REPORTS.join(', ')}` })
    const range = reportRange(args, true)!
    const [rows, account] = await Promise.all([
      getGoogleAdsReport(accessToken, developerToken, customerId, { report, ...range, campaignId: optionalString(args, 'campaign_id'), limit: args.limit === undefined ? 100 : Number(args.limit) }),
      getGoogleAdsCustomer(accessToken, developerToken, customerId),
    ])
    return { customer_id: customerId, currency: account.currencyCode, time_zone: account.timeZone, report, start_date: range.startDate, end_date: range.endDate, rows }
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

    const result = await createGoogleAdsSearchCampaign(accessToken, developerToken, customerId, {
      name,
      dailyBudgetAmountMicros,
      targetUrl,
      keywords,
      headlines,
      descriptions,
      status: 'PAUSED',
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
