import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { readIntegration, storeIntegration } from './organization-integrations'
import { requireRecordedManagedSpend } from '~/server/domain/payments/ad-spend'
import { HTTPError } from 'nitro'
import { isValidTimezone } from '~/utils/timezone'

/**
 * Google Ads as a product of its own, over a Better Auth linked Google
 * account. This module owns the Google Ads customer chosen, and the
 * `account_id` it was chosen through; the account and its tokens are Better Auth's.
 */

export interface GoogleAdsCustomer {
  customerId: string
  formattedCustomerId: string
  /** Null when Google would not describe the account; `error` or `notEnabled` says why. */
  descriptiveName: string | null
  currencyCode?: string
  timeZone?: string
  isManager?: boolean
  /** Google reports the account cancelled or not yet set up (`CUSTOMER_NOT_ENABLED`); it cannot be connected. */
  notEnabled?: true
  error?: string
}

/** Google's own code and message for a failed Ads request, kept short enough to show. */
function googleAdsError(status: number, body: string): { code?: string; message: string } {
  if (!body.trimStart().startsWith('{')) return { message: `${status}: ${body.slice(0, 200)}` }
  const parsed = JSON.parse(body) as { error?: { message?: string; details?: Array<{ errors?: Array<{ message?: string; errorCode?: Record<string, string>; location?: { fieldPathElements?: Array<{ fieldName: string; index?: number }> } }> }> } }
  const detail = parsed.error?.details?.[0]?.errors?.[0]
  const code = detail?.errorCode ? Object.values(detail.errorCode)[0] : undefined
  const field = detail?.location?.fieldPathElements?.map(element => element.index === undefined ? element.fieldName : `${element.fieldName}[${element.index}]`).join('.')
  const message = `${detail?.message ?? parsed.error?.message ?? body.slice(0, 200)}${field ? ` (${field})` : ''}`
  return { code, message: code ? `${code}: ${message}` : `${status}: ${message}` }
}

/** Formats a 10-digit customer ID as XXX-XXX-XXXX */
export function formatGoogleAdsCustomerId(customerId: string): string {
  const digits = customerId.replace(/\D/g, '')
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return customerId
}

/** The Google Ads accounts the connected Google account has access to. */
export async function listGoogleAdsAccounts(accessToken: string, developerToken?: string): Promise<GoogleAdsCustomer[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  }
  if (developerToken) {
    headers['developer-token'] = developerToken
  }

  // 1. List accessible customers
  const listResponse = await fetch('https://googleads.googleapis.com/v25/customers:listAccessibleCustomers', {
    headers,
  })

  if (!listResponse.ok) {
    throw new Error(`${listResponse.status} ${listResponse.statusText}: ${(await listResponse.text()).slice(0, 300)}`)
  }

  const listData = (await listResponse.json()) as { resourceNames?: string[] }
  const resourceNames = listData.resourceNames ?? []
  if (resourceNames.length === 0) {
    return []
  }

  // 2. Each customer's own details. Google answers per account, and an account
  // it will not describe is listed with Google's reason, never with a made-up
  // name; a cancelled or never-enabled account is marked as such.
  const customers: GoogleAdsCustomer[] = []
  for (const resourceName of resourceNames) {
    const customerId = resourceName.replace(/^customers\//, '')
    const formattedCustomerId = formatGoogleAdsCustomerId(customerId)
    const searchResponse = await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1',
      }),
    })
    if (!searchResponse.ok) {
      const failure = googleAdsError(searchResponse.status, await searchResponse.text())
      customers.push(failure.code === 'CUSTOMER_NOT_ENABLED'
        ? { customerId, formattedCustomerId, descriptiveName: null, notEnabled: true }
        : { customerId, formattedCustomerId, descriptiveName: null, error: failure.message })
      continue
    }
    const searchData = (await searchResponse.json()) as {
      results?: Array<{ customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean } }>
    }
    const c = searchData.results?.[0]?.customer
    if (!c) throw new Error(`Google Ads returned no customer row for ${formattedCustomerId}`)
    customers.push({ customerId, formattedCustomerId, descriptiveName: c.descriptiveName ?? null, currencyCode: c.currencyCode, timeZone: c.timeZone, isManager: c.manager ?? false })
  }

  return customers
}

/** Connects the Google Ads customer to the organization. */
export async function selectGoogleAdsCustomer(
  env: CloudflareEnv,
  organizationId: string,
  accountId: string,
  customerId: string,
  customerName: string,
): Promise<string> {
  await requireRecordedManagedSpend(env.DB, env, organizationId)
  if (await readIntegration(env.DB, organizationId, 'google_ads')) throw new HTTPError({ statusCode: 409, message: 'Disconnect Google Ads before connecting again.' })
  // A manager account holds other accounts; it has no campaigns or results of its own.
  const { accessToken } = await linkedAccountAccessToken(env, accountId)
  if ((await getGoogleAdsCustomer(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, customerId)).isManager) {
    throw new HTTPError({ statusCode: 422, message: 'That is a Google Ads manager account. Choose one of the accounts it manages.' })
  }
  return await storeIntegration(env.DB, organizationId, 'google_ads', {
    account_id: accountId,
    target_id: customerId,
    target_name: customerName,
  }, { revision: null })
}

function googleAdsHeaders(accessToken: string, developerToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (developerToken) headers['developer-token'] = developerToken
  return headers
}

function cleanCustomerId(customerId: string): string {
  return customerId.replace(/\D/g, '')
}

export interface GoogleAdsCampaignSummary {
  id: string
  name: string
  status: string
  channelType: string
  budgetAmountMicros: number
  budgetId?: string
  clicks: number
  impressions: number
  costMicros: number
  conversions: number
}

/** List active/paused campaigns for a customer */
export async function listGoogleAdsCampaigns(
  accessToken: string,
  developerToken: string | undefined,
  customerId: string,
  statusFilter?: 'ENABLED' | 'PAUSED' | 'ALL',
  /** Metrics for these calendar days (YYYY-MM-DD, the account's time zone); all time when absent. */
  range?: { startDate: string; endDate: string },
): Promise<GoogleAdsCampaignSummary[]> {
  const cid = cleanCustomerId(customerId)
  for (const date of range ? [range.startDate, range.endDate] : []) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`Google Ads date range must be calendar days: ${date}`)
  }
  // A range reports what spent in it, removed campaigns included; without one, the list is what still exists.
  const whereClause = [
    ...(statusFilter && statusFilter !== 'ALL' ? [`campaign.status = '${statusFilter}'`] : range ? [] : [`campaign.status != 'REMOVED'`]),
    ...(range ? [`segments.date BETWEEN '${range.startDate}' AND '${range.endDate}'`] : []),
  ].join(' AND ')

  const response = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers: googleAdsHeaders(accessToken, developerToken),
    body: JSON.stringify({
      query: `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, campaign_budget.id, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM campaign WHERE ${whereClause} ORDER BY metrics.cost_micros DESC LIMIT 100`,
    }),
  })

  if (!response.ok) {
    throw new Error(`Google Ads API error (${response.status}): ${(await response.text()).slice(0, 300)}`)
  }

  const data = (await response.json()) as {
    results?: Array<{
      campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string }
      campaignBudget?: { id?: string; amountMicros?: string }
      metrics?: { clicks?: string; impressions?: string; costMicros?: string; conversions?: number }
    }>
  }

  return (data.results ?? []).map(row => ({
    id: row.campaign?.id ?? '',
    name: row.campaign?.name ?? '',
    status: row.campaign?.status ?? 'UNKNOWN',
    channelType: row.campaign?.advertisingChannelType ?? 'SEARCH',
    budgetAmountMicros: Number(row.campaignBudget?.amountMicros ?? 0),
    budgetId: row.campaignBudget?.id,
    clicks: Number(row.metrics?.clicks ?? 0),
    impressions: Number(row.metrics?.impressions ?? 0),
    costMicros: Number(row.metrics?.costMicros ?? 0),
    conversions: Number(row.metrics?.conversions ?? 0),
  }))
}

/** One row of a Google Ads `googleAds:search` response, as the fields the readers below use. */
interface GoogleAdsSearchRow {
  campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string }
  campaignBudget?: { id?: string; amountMicros?: string | number }
  metrics?: { clicks?: string | number; impressions?: string | number; costMicros?: string | number; conversions?: string | number }
  adGroup?: { id?: string; name?: string; status?: string }
  adGroupCriterion?: { keyword?: { text?: string; matchType?: GoogleAdsKeyword['matchType'] }; status?: GoogleAdsKeyword['status']; negative?: boolean }
  adGroupAd?: { ad?: { responsiveSearchAd?: { headlines?: Array<{ text?: string }>; descriptions?: Array<{ text?: string }> }; finalUrls?: string[] } }
}

export interface GoogleAdsKeyword {
  text: string
  matchType: 'EXACT' | 'PHRASE' | 'BROAD'
  status?: 'ENABLED' | 'PAUSED'
  negative?: boolean
}

export interface GoogleAdsCampaignDetail extends GoogleAdsCampaignSummary {
  adGroups: Array<{
    id: string
    name: string
    status: string
  }>
  keywords: GoogleAdsKeyword[]
  headlines: string[]
  descriptions: string[]
  finalUrls: string[]
}

/** Get detailed campaign structure including keywords and ad copy */
export async function getGoogleAdsCampaignDetail(
  accessToken: string,
  developerToken: string | undefined,
  customerId: string,
  campaignId: string,
): Promise<GoogleAdsCampaignDetail> {
  if (!/^\d+$/u.test(campaignId)) throw new Error('campaignId must be a numeric Google Ads campaign ID')
  const cid = cleanCustomerId(customerId)
  const headers = googleAdsHeaders(accessToken, developerToken)

  // 1. Campaign & metrics
  const campResp = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, campaign_budget.id, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`,
    }),
  })
  if (!campResp.ok) throw new Error(`Google Ads query failed: ${(await campResp.text()).slice(0, 300)}`)
  const campData = await campResp.json() as { results?: GoogleAdsSearchRow[] }
  const cRow = campData.results?.[0]
  if (!cRow) throw new Error(`Campaign ${campaignId} not found`)
  if (!cRow.campaign?.id || !cRow.campaign.name || !cRow.campaign.status || !cRow.campaign.advertisingChannelType) {
    throw new Error(`Google Ads returned incomplete campaign details for ${campaignId}`)
  }

  // 2. Ad groups
  const adGroupResp = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.campaign = 'customers/${cid}/campaigns/${campaignId}' AND ad_group.status != 'REMOVED'`,
    }),
  })
  if (!adGroupResp.ok) throw await googleAdsFailure('Google Ads ad group query failed', adGroupResp)
  const adGroupsData = await adGroupResp.json() as { results?: GoogleAdsSearchRow[] }
  const adGroups = (adGroupsData.results ?? []).map(r => {
    if (!r.adGroup?.id || !r.adGroup.name || !r.adGroup.status) throw new Error(`Google Ads returned an incomplete ad group for campaign ${campaignId}`)
    return { id: r.adGroup.id, name: r.adGroup.name, status: r.adGroup.status }
  })

  // 3. Keywords
  const kwResp = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.negative FROM ad_group_criterion WHERE ad_group.campaign = 'customers/${cid}/campaigns/${campaignId}' AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`,
    }),
  })
  if (!kwResp.ok) throw await googleAdsFailure('Google Ads keyword query failed', kwResp)
  const kwData = await kwResp.json() as { results?: GoogleAdsSearchRow[] }
  const keywords: GoogleAdsKeyword[] = (kwData.results ?? []).map(r => {
    const keyword = r.adGroupCriterion?.keyword
    if (!keyword?.text || !keyword.matchType || !r.adGroupCriterion?.status) throw new Error(`Google Ads returned an incomplete keyword for campaign ${campaignId}`)
    return { text: keyword.text, matchType: keyword.matchType, status: r.adGroupCriterion.status, negative: r.adGroupCriterion.negative ?? false }
  })

  // 4. Responsive Search Ads
  const adResp = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `SELECT ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group.campaign = 'customers/${cid}/campaigns/${campaignId}' AND ad_group_ad.status != 'REMOVED'`,
    }),
  })
  if (!adResp.ok) throw await googleAdsFailure('Google Ads responsive search ad query failed', adResp)
  const adData = await adResp.json() as { results?: GoogleAdsSearchRow[] }
  const headlines: string[] = []
  const descriptions: string[] = []
  const finalUrls: string[] = []

  for (const row of adData.results ?? []) {
    const rsa = row.adGroupAd?.ad?.responsiveSearchAd
    if (rsa?.headlines) {
      for (const h of rsa.headlines) {
        if (h.text && !headlines.includes(h.text)) headlines.push(h.text)
      }
    }
    if (rsa?.descriptions) {
      for (const d of rsa.descriptions) {
        if (d.text && !descriptions.includes(d.text)) descriptions.push(d.text)
      }
    }
    const urls = row.adGroupAd?.ad?.finalUrls ?? []
    for (const u of urls) {
      if (u && !finalUrls.includes(u)) finalUrls.push(u)
    }
  }

  return {
    id: cRow.campaign.id,
    name: cRow.campaign.name,
    status: cRow.campaign.status,
    channelType: cRow.campaign.advertisingChannelType,
    budgetAmountMicros: Number(cRow.campaignBudget?.amountMicros ?? 0),
    budgetId: cRow.campaignBudget?.id,
    clicks: Number(cRow.metrics?.clicks ?? 0),
    impressions: Number(cRow.metrics?.impressions ?? 0),
    costMicros: Number(cRow.metrics?.costMicros ?? 0),
    conversions: Number(cRow.metrics?.conversions ?? 0),
    adGroups,
    keywords,
    headlines,
    descriptions,
    finalUrls,
  }
}

export interface CreateSearchCampaignInput {
  name: string
  dailyBudgetAmountMicros: number
  targetUrl: string
  keywords: Array<{ text: string; matchType?: 'EXACT' | 'PHRASE' | 'BROAD' }>
  headlines: string[]
  descriptions: string[]
  status?: 'ENABLED' | 'PAUSED'
  /** The advertiser's EU political advertising self-declaration, which Google requires on every new campaign. */
  containsEuPoliticalAdvertising: boolean
}

export interface CreateCampaignResult {
  campaignId: string
  resourceName: string
  budgetResourceName: string
  adGroupResourceName: string
  adResourceName: string
  status: string
}

/** Atomically creates a Search Campaign with Budget, Ad Group, Keywords, and RSA */
export async function createGoogleAdsSearchCampaign(
  accessToken: string,
  developerToken: string | undefined,
  customerId: string,
  input: CreateSearchCampaignInput,
): Promise<CreateCampaignResult> {
  const cid = cleanCustomerId(customerId)
  const headers = googleAdsHeaders(accessToken, developerToken)

  const tempBudgetId = '-1'
  const tempCampaignId = '-2'
  const tempAdGroupId = '-3'

  if (!input.name.trim()) throw new Error('Campaign name is required')
  if (!Number.isSafeInteger(input.dailyBudgetAmountMicros) || input.dailyBudgetAmountMicros < 1000000) throw new Error('dailyBudgetAmountMicros must be an integer of at least 1000000')
  if (typeof input.containsEuPoliticalAdvertising !== 'boolean') throw new Error('The advertiser must declare whether the campaign contains EU political advertising')
  if (input.status !== undefined && input.status !== 'ENABLED' && input.status !== 'PAUSED') throw new Error('Campaign status must be ENABLED or PAUSED')
  if (input.headlines.length < 3 || input.headlines.length > 15 || new Set(input.headlines).size !== input.headlines.length || input.headlines.some(text => !text.trim() || text.length > 30)) {
    throw new Error('Google Responsive Search Ads require 3 to 15 unique nonempty headlines of at most 30 characters each')
  }
  if (input.descriptions.length < 2 || input.descriptions.length > 4 || new Set(input.descriptions).size !== input.descriptions.length || input.descriptions.some(text => !text.trim() || text.length > 90)) {
    throw new Error('Google Responsive Search Ads require 2 to 4 unique nonempty descriptions of at most 90 characters each')
  }
  const headlines = input.headlines.map(text => ({ text }))
  const descriptions = input.descriptions.map(text => ({ text }))
  if (!['http:', 'https:'].includes(new URL(input.targetUrl).protocol)) {
    throw new Error('targetUrl must be a valid http or https URL')
  }
  if (input.keywords.some(keyword => !keyword.text.trim() || (keyword.matchType !== undefined && !['EXACT', 'PHRASE', 'BROAD'].includes(keyword.matchType)))) {
    throw new Error('Keywords require nonempty text and an EXACT, PHRASE or BROAD match type')
  }

  const mutateOperations: Array<Record<string, unknown>> = [
    // 1. Budget
    {
      campaignBudgetOperation: {
        create: {
          resourceName: `customers/${cid}/campaignBudgets/${tempBudgetId}`,
          name: `Budget: ${input.name} (${Date.now()})`,
          amountMicros: String(input.dailyBudgetAmountMicros),
          deliveryMethod: 'STANDARD',
          explicitlyShared: false,
        },
      },
    },
    // 2. Campaign
    {
      campaignOperation: {
        create: {
          resourceName: `customers/${cid}/campaigns/${tempCampaignId}`,
          name: input.name,
          status: input.status ?? 'PAUSED',
          advertisingChannelType: 'SEARCH',
          campaignBudget: `customers/${cid}/campaignBudgets/${tempBudgetId}`,
          containsEuPoliticalAdvertising: input.containsEuPoliticalAdvertising ? 'CONTAINS_EU_POLITICAL_ADVERTISING' : 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          // Google Search only: Google refused Search Partners on create (CANNOT_TARGET_SEARCH_NETWORK).
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: false,
            targetContentNetwork: false,
            targetPartnerSearchNetwork: false,
          },
          targetSpend: {},
        },
      },
    },
    // 3. Ad Group
    {
      adGroupOperation: {
        create: {
          resourceName: `customers/${cid}/adGroups/${tempAdGroupId}`,
          name: `${input.name} - Ad Group`,
          campaign: `customers/${cid}/campaigns/${tempCampaignId}`,
          status: 'ENABLED',
          type: 'SEARCH_STANDARD',
        },
      },
    },
  ]

  // 4. Keywords
  for (const kw of input.keywords) {
    mutateOperations.push({
      adGroupCriterionOperation: {
        create: {
          adGroup: `customers/${cid}/adGroups/${tempAdGroupId}`,
          status: 'ENABLED',
          keyword: {
            text: kw.text.trim(),
            matchType: kw.matchType ?? 'PHRASE',
          },
        },
      },
    })
  }

  // 5. Responsive Search Ad
  mutateOperations.push({
    adGroupAdOperation: {
      create: {
        adGroup: `customers/${cid}/adGroups/${tempAdGroupId}`,
        status: 'ENABLED',
        ad: {
          finalUrls: [input.targetUrl],
          responsiveSearchAd: {
            headlines,
            descriptions,
          },
        },
      },
    },
  })

  const response = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:mutate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mutateOperations }),
  })

  if (!response.ok) {
    throw new Error(`Google Ads campaign creation failed: ${googleAdsError(response.status, await response.text()).message}`)
  }

  const result = await response.json() as {
    mutateOperationResponses?: Array<{
      campaignBudgetResult?: { resourceName: string }
      campaignResult?: { resourceName: string }
      adGroupResult?: { resourceName: string }
      adGroupAdResult?: { resourceName: string }
    }>
  }

  const responses = result.mutateOperationResponses ?? []
  const budgetRes = responses[0]?.campaignBudgetResult?.resourceName
  const campRes = responses[1]?.campaignResult?.resourceName
  const adGroupRes = responses[2]?.adGroupResult?.resourceName
  const adRes = responses[responses.length - 1]?.adGroupAdResult?.resourceName
  if (!budgetRes || !campRes || !adGroupRes || !adRes) throw new Error('Google Ads did not return a complete campaign creation receipt; inspect the account before retrying')
  const campaignId = campRes.split('/').pop()!

  return {
    campaignId,
    resourceName: campRes,
    budgetResourceName: budgetRes,
    adGroupResourceName: adGroupRes,
    adResourceName: adRes,
    status: input.status ?? 'PAUSED',
  }
}

/** Updates a campaign's requested status and budget in one Google Ads transaction. */
export async function updateGoogleAdsCampaign(
  accessToken: string,
  developerToken: string | undefined,
  customerId: string,
  input: { campaignId: string; status?: 'ENABLED' | 'PAUSED'; budgetId?: string; dailyBudgetAmountMicros?: number },
): Promise<void> {
  if (!/^\d+$/u.test(input.campaignId)) throw new Error('campaignId must be a numeric Google Ads campaign ID')
  if (input.status !== undefined && input.status !== 'ENABLED' && input.status !== 'PAUSED') throw new Error('Campaign status must be ENABLED or PAUSED')
  if ((input.budgetId !== undefined) !== (input.dailyBudgetAmountMicros !== undefined)) throw new Error('budget_id and daily_budget_micros must be supplied together')
  if (input.status === undefined && input.dailyBudgetAmountMicros === undefined) throw new Error('Supply a status or daily budget to update')
  if (input.dailyBudgetAmountMicros !== undefined && (!Number.isSafeInteger(input.dailyBudgetAmountMicros) || input.dailyBudgetAmountMicros < 1000000)) throw new Error('dailyBudgetAmountMicros must be an integer of at least 1000000')
  if (input.budgetId !== undefined && !/^\d+$/u.test(input.budgetId)) throw new Error('budgetId must be a numeric Google Ads budget ID')

  const cid = cleanCustomerId(customerId)
  const headers = googleAdsHeaders(accessToken, developerToken)
  const mutateOperations: Array<Record<string, unknown>> = []

  if (input.budgetId !== undefined) {
    const response = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
      method: 'POST', headers,
      body: JSON.stringify({ query: `SELECT campaign_budget.id FROM campaign WHERE campaign.id = ${input.campaignId} LIMIT 1` }),
    })
    if (!response.ok) throw await googleAdsFailure('Google Ads campaign budget query failed', response)
    const data = await response.json() as { results?: GoogleAdsSearchRow[] }
    if (data.results?.[0]?.campaignBudget?.id !== input.budgetId) throw new Error(`Budget ${input.budgetId} does not belong to campaign ${input.campaignId}`)
    mutateOperations.push({ campaignBudgetOperation: {
      update: { resourceName: `customers/${cid}/campaignBudgets/${input.budgetId}`, amountMicros: String(input.dailyBudgetAmountMicros) },
      updateMask: 'amountMicros',
    } })
  }
  if (input.status !== undefined) {
    mutateOperations.push({ campaignOperation: {
      update: { resourceName: `customers/${cid}/campaigns/${input.campaignId}`, status: input.status },
      updateMask: 'status',
    } })
  }

  const response = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:mutate`, {
    method: 'POST', headers, body: JSON.stringify({ mutateOperations }),
  })
  if (!response.ok) throw await googleAdsFailure('Google Ads campaign update failed', response)
  const result = await response.json() as { mutateOperationResponses?: Array<{ campaignBudgetResult?: { resourceName: string }; campaignResult?: { resourceName: string } }> }
  const receipts = result.mutateOperationResponses ?? []
  if (receipts.length !== mutateOperations.length || (input.budgetId !== undefined && !receipts.some(receipt => receipt.campaignBudgetResult?.resourceName === `customers/${cid}/campaignBudgets/${input.budgetId}`)) || (input.status !== undefined && !receipts.some(receipt => receipt.campaignResult?.resourceName === `customers/${cid}/campaigns/${input.campaignId}`))) {
    throw new Error('Google Ads did not return a complete campaign update receipt; inspect the account before retrying')
  }
}

/** The account's currency, reporting timezone and name, independent of any reporting range. */
/**
 * Google's own reason for a refused request: each error's code and message from
 * the GoogleAdsFailure details, which a truncated body cuts off.
 */
async function googleAdsFailure(label: string, response: Response): Promise<Error> {
  const text = await response.text()
  type Failure = { error?: { message?: string; details?: Array<{ errors?: Array<{ errorCode?: Record<string, string>; message?: string }> }> } }
  // A body that is not Google's JSON failure is reported as it came.
  const body = (() => { try { return JSON.parse(text) as Failure } catch { return null } })()
  const reasons = (body?.error?.details ?? []).flatMap(detail => detail.errors ?? [])
    .map(error => [Object.values(error.errorCode ?? {}).join(', '), error.message].filter(Boolean).join(': '))
  const reason = reasons.join('; ') || body?.error?.message || text.slice(0, 500)
  return new Error(`${label} (${response.status}): ${reason}`)
}

export async function getGoogleAdsCustomer(accessToken: string, developerToken: string | undefined, customerId: string): Promise<{ descriptiveName: string; currencyCode: string; timeZone: string; isManager: boolean }> {
  const cid = cleanCustomerId(customerId)
  const response = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers: googleAdsHeaders(accessToken, developerToken),
    body: JSON.stringify({ query: 'SELECT customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1' }),
  })
  if (!response.ok) throw await googleAdsFailure('Google Ads API error', response)
  const data = (await response.json()) as { results?: Array<{ customer?: { descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean } }> }
  const customer = data.results?.[0]?.customer
  if (!customer?.currencyCode) throw new Error(`Google Ads did not describe customer ${cid}`)
  if (!isValidTimezone(customer.timeZone)) throw new Error(`Google Ads did not provide a valid reporting timezone for customer ${cid}`)
  return { descriptiveName: customer.descriptiveName ?? '', currencyCode: customer.currencyCode, timeZone: customer.timeZone, isManager: customer.manager === true }
}

/** Query aggregated Google Ads performance for date range */
export async function getGoogleAdsPerformanceSummary(
  accessToken: string,
  developerToken: string | undefined,
  customerId: string,
  startDate?: string,
  endDate?: string,
): Promise<{
  clicks: number
  impressions: number
  costMicros: number
  conversions: number
  averageCpcMicros: number
  /** The account's currency, which `costMicros` is in. */
  currencyCode: string
}> {
  const cid = cleanCustomerId(customerId)
  const headers = googleAdsHeaders(accessToken, developerToken)

  const start = startDate ?? new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
  const end = endDate ?? new Date().toISOString().slice(0, 10)

  const response = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `SELECT customer.currency_code, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM customer WHERE segments.date BETWEEN '${start}' AND '${end}'`,
    }),
  })

  if (!response.ok) throw await googleAdsFailure('Google Ads search query failed', response)

  const data = await response.json() as {
    results?: Array<{
      customer?: { currencyCode?: string }
      metrics?: { clicks?: string; impressions?: string; costMicros?: string; conversions?: number }
    }>
  }

  const currencyCode = data.results?.[0]?.customer?.currencyCode
  if (data.results?.length && !currencyCode) throw new Error('Google Ads did not report the account currency')
  let clicks = 0
  let impressions = 0
  let costMicros = 0
  let conversions = 0

  for (const r of data.results ?? []) {
    clicks += Number(r.metrics?.clicks ?? 0)
    impressions += Number(r.metrics?.impressions ?? 0)
    costMicros += Number(r.metrics?.costMicros ?? 0)
    conversions += Number(r.metrics?.conversions ?? 0)
  }

  const averageCpcMicros = clicks > 0 ? Math.round(costMicros / clicks) : 0
  return { clicks, impressions, costMicros, conversions, averageCpcMicros, currencyCode: currencyCode ?? '' }
}
