import { HTTPError } from 'nitro'
import type { McpToolDefinition } from './shared'
import { organizationTool } from './shared'
import type { McpExecutorContext } from './execution'
import { NOT_HANDLED, optionalString, requiredBoolean, requiredString } from './execution'
import { readIntegration } from '~/server/utils/organization-integrations'
import { linkedAccountAccessToken } from '~/server/utils/auth'
import { executeBatch } from '~/server/db'
import { organizationEventQuery } from '~/server/utils/organization-events'
import {
  listGoogleAdsCampaigns,
  getGoogleAdsCampaignDetail,
  createGoogleAdsSearchCampaign,
  updateGoogleAdsCampaign,
  getGoogleAdsCustomer,
  validateGoogleAdsSearchCampaign,
  validateGoogleAdsCampaignUpdate,
  GoogleAdsMutationError,
  type CreateSearchCampaignInput,
  type UpdateGoogleAdsCampaignInput,
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
    description: 'Create a paused Google Ads Search campaign with one ad group and responsive search ad from the supplied keywords, copy, destination and daily budget. The campaign cannot serve ads until separately enabled. Each call creates a new campaign; inspect the account before retrying an uncertain result.',
    domain: 'google_ads',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
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

  if (toolName === 'create_google_ads_search_campaign' || toolName === 'update_google_ads_campaign') {
    const { db, organizationId, userId } = ctx.organization
    const creating = toolName === 'create_google_ads_search_campaign'
    const campaignId = creating ? null : requiredString(args, 'campaign_id')
    const status = creating ? 'PAUSED' : optionalString(args, 'status') as 'ENABLED' | 'PAUSED' | null
    const budgetId = creating ? null : optionalString(args, 'budget_id')
    const dailyBudget = args.daily_budget_micros === undefined ? null : Number(args.daily_budget_micros)
    const creation: CreateSearchCampaignInput | null = creating ? {
      name: requiredString(args, 'name'), dailyBudgetAmountMicros: Number(args.daily_budget_micros),
      targetUrl: requiredString(args, 'target_url'),
      keywords: ((args.keywords as Array<{ text: string; match_type?: 'EXACT' | 'PHRASE' | 'BROAD' }>) ?? []).map(keyword => ({ text: keyword.text, matchType: keyword.match_type ?? 'PHRASE' })),
      headlines: (args.headlines as string[]) ?? [], descriptions: (args.descriptions as string[]) ?? [], status: 'PAUSED',
      containsEuPoliticalAdvertising: requiredBoolean(args, 'contains_eu_political_advertising'),
    } : null
    const update: UpdateGoogleAdsCampaignInput | null = creating ? null : {
      campaignId: campaignId!, status: status ?? undefined, budgetId: budgetId ?? undefined, dailyBudgetAmountMicros: dailyBudget ?? undefined,
    }
    // The same validation protects direct provider callers and runs here
    // before any intent can imply that a mutation was dispatched.
    if (creation) validateGoogleAdsSearchCampaign(creation)
    else validateGoogleAdsCampaignUpdate(update!)
    const { accessToken, developerToken, customerId } = await resolveGoogleAdsCredentials(ctx)
    const account = await getGoogleAdsCustomer(accessToken, developerToken, customerId)
    const before = campaignId ? await getGoogleAdsCampaignDetail(accessToken, developerToken, customerId, campaignId) : null
    if (budgetId && before?.budgetId !== budgetId) throw new HTTPError({ statusCode: 400, message: 'The budget does not belong to this campaign.' })
    const beforeState = before ? {
      name: before.name, status: before.status, budget_id: before.budgetId ?? null,
      daily_budget_micros: before.budgetId ? before.budgetAmountMicros : null, currency: account.currencyCode,
    } : null
    const requestedState = creating ? {
      name: requiredString(args, 'name'), status, daily_budget_micros: dailyBudget,
      target_url: requiredString(args, 'target_url'), currency: account.currencyCode,
    } : {
      ...beforeState,
      ...status ? { status } : {},
      ...budgetId ? { budget_id: budgetId, daily_budget_micros: dailyBudget } : {},
    }
    const changedFields = Object.keys(requestedState).filter(key => !beforeState || requestedState[key as keyof typeof requestedState] !== beforeState[key as keyof typeof beforeState])
    if (!creating && !changedFields.length) return { campaign_id: campaignId, status, budget_id: budgetId, daily_budget_micros: dailyBudget }
    const operationId = crypto.randomUUID()
    const metadata = { operation_id: operationId, provider: 'google_ads', customer_id: customerId, currency: account.currencyCode, changed_fields: changedFields, requested_state: requestedState }
    await executeBatch(db, [organizationEventQuery({
      id: operationId, organizationId, actorId: userId, eventType: 'google_ads.campaign_change_requested',
      entityType: campaignId ? 'google_ads_campaign' : 'google_ads_customer', entityId: campaignId ?? customerId,
      beforeState, metadata,
    })])
    let result: { campaign_id: string; status: string | null; budget_id?: string | null; daily_budget_micros?: number | null }
    let resourceNames: string[], requestId: string | null
    try {
      if (creating) {
        const created = await createGoogleAdsSearchCampaign(accessToken, developerToken, customerId, creation!)
        result = { campaign_id: created.campaignId, status: created.status }
        resourceNames = [created.resourceName, created.budgetResourceName, created.adGroupResourceName, created.adResourceName]
        requestId = created.requestId
      } else {
        const updated = await updateGoogleAdsCampaign(accessToken, developerToken, customerId, update!)
        result = { campaign_id: campaignId!, status, budget_id: budgetId, daily_budget_micros: dailyBudget }
        resourceNames = updated.resourceNames
        requestId = updated.requestId
      }
    } catch (error) {
      // Google's definite atomic refusal is not a response lost after a
      // possible commit. Preserve that distinction in the actual result.
      const refused = error instanceof GoogleAdsMutationError && error.outcome === 'not_applied'
      try {
        await executeBatch(db, [organizationEventQuery({
          organizationId, actorId: userId, eventType: refused ? 'google_ads.campaign_change_failed' : 'google_ads.campaign_change_unconfirmed',
          entityType: campaignId ? 'google_ads_campaign' : 'google_ads_customer', entityId: campaignId ?? customerId,
          beforeState, metadata: { ...metadata, verification_status: refused ? 'failed' : 'unconfirmed', verification_basis: 'provider_acceptance',
            provider_request_id: error instanceof GoogleAdsMutationError ? error.requestId : null,
            error: error instanceof Error ? error.message : String(error) },
        })])
      } catch (auditError) {
        throw new AggregateError([error, auditError], refused
          ? 'Google Ads did not apply the change, but the refusal could not be recorded.'
          : 'The Google Ads outcome is uncertain and could not be recorded. Inspect the account before retrying.', { cause: auditError })
      }
      throw error
    }
    try {
      await executeBatch(db, [organizationEventQuery({
        organizationId, actorId: userId, eventType: creating ? 'google_ads.campaign_created' : 'google_ads.campaign_updated',
        entityType: 'google_ads_campaign', entityId: result.campaign_id, beforeState, afterState: requestedState,
        metadata: { ...metadata, verification_status: 'verified', verification_basis: 'provider_acceptance', provider_request_id: requestId, provider_resource_names: resourceNames },
      })])
    } catch (error) {
      throw new Error('Google Ads accepted the campaign change, but its result could not be recorded. Inspect the account before retrying.', { cause: error })
    }
    return result
  }

  return NOT_HANDLED
}
