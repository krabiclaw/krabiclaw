import type { CloudflareEnv } from './auth'
import { storeIntegration } from './organization-integrations'

/**
 * Google Ads as a product of its own, over a Better Auth linked Google
 * account. This module owns the Google Ads customer chosen, and the
 * `account_id` it was chosen through; the account and its tokens are Better Auth's.
 */

export interface GoogleAdsCustomer {
  customerId: string
  formattedCustomerId: string
  /** Null when Google would not describe the account; `error` says why. */
  descriptiveName: string | null
  currencyCode?: string
  timeZone?: string
  isManager?: boolean
  error?: string
}

/** Google's own message for a failed Ads request, kept short enough to show. */
function googleAdsErrorMessage(status: number, body: string): string {
  if (!body.trimStart().startsWith('{')) return `${status}: ${body.slice(0, 200)}`
  const parsed = JSON.parse(body) as { error?: { message?: string; details?: Array<{ errors?: Array<{ message?: string; errorCode?: Record<string, string> }> }> } }
  const detail = parsed.error?.details?.[0]?.errors?.[0]
  const code = detail?.errorCode ? Object.values(detail.errorCode)[0] : undefined
  const message = detail?.message ?? parsed.error?.message ?? body.slice(0, 200)
  return code ? `${code}: ${message}` : `${status}: ${message}`
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
  // it will not describe (a token without access, a deactivated sub-account) is
  // listed with Google's reason, never with a made-up name.
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
      customers.push({ customerId, formattedCustomerId, descriptiveName: null, error: googleAdsErrorMessage(searchResponse.status, await searchResponse.text()) })
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
  expected?: { revision: string | null },
): Promise<string> {
  return await storeIntegration(env.DB, organizationId, 'google_ads', {
    account_id: accountId,
    target_id: customerId,
    target_name: customerName,
  }, expected)
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
  const whereClause = [
    statusFilter && statusFilter !== 'ALL' ? `campaign.status = '${statusFilter}'` : `campaign.status != 'REMOVED'`,
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
  adGroupCriterion?: { keyword?: { text?: string; matchType?: GoogleAdsKeyword['matchType'] }; status?: string }
  adGroupAd?: { ad?: { responsiveSearchAd?: { headlines?: Array<{ text?: string }>; descriptions?: Array<{ text?: string }> }; finalUrls?: string[] } }
}

export interface GoogleAdsKeyword {
  text: string
  matchType: 'EXACT' | 'PHRASE' | 'BROAD'
  status?: string
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

  // 2. Ad groups
  const adGroupResp = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.campaign = 'customers/${cid}/campaigns/${campaignId}' AND ad_group.status != 'REMOVED'`,
    }),
  })
  const adGroupsData = adGroupResp.ok ? (await adGroupResp.json() as { results?: GoogleAdsSearchRow[] }) : { results: [] }
  const adGroups = (adGroupsData.results ?? []).map(r => ({
    id: r.adGroup?.id ?? '',
    name: r.adGroup?.name ?? '',
    status: r.adGroup?.status ?? '',
  }))

  // 3. Keywords
  const kwResp = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status FROM ad_group_criterion WHERE ad_group.campaign = 'customers/${cid}/campaigns/${campaignId}' AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`,
    }),
  })
  const kwData = kwResp.ok ? (await kwResp.json() as { results?: GoogleAdsSearchRow[] }) : { results: [] }
  const keywords: GoogleAdsKeyword[] = (kwData.results ?? []).map(r => ({
    text: r.adGroupCriterion?.keyword?.text ?? '',
    matchType: r.adGroupCriterion?.keyword?.matchType ?? 'PHRASE',
    status: r.adGroupCriterion?.status,
  }))

  // 4. Responsive Search Ads
  const adResp = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `SELECT ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group.campaign = 'customers/${cid}/campaigns/${campaignId}' AND ad_group_ad.status != 'REMOVED' LIMIT 5`,
    }),
  })
  const adData = adResp.ok ? (await adResp.json() as { results?: GoogleAdsSearchRow[] }) : { results: [] }
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
    id: cRow.campaign?.id ?? '',
    name: cRow.campaign?.name ?? '',
    status: cRow.campaign?.status ?? 'UNKNOWN',
    channelType: cRow.campaign?.advertisingChannelType ?? 'SEARCH',
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

  // Validate copy length according to Google Ads limits
  const headlines = input.headlines.slice(0, 15).map(h => ({ text: h.slice(0, 30) }))
  const descriptions = input.descriptions.slice(0, 4).map(d => ({ text: d.slice(0, 90) }))
  if (headlines.length < 3) throw new Error('Google Responsive Search Ads require at least 3 headlines')
  if (descriptions.length < 2) throw new Error('Google Responsive Search Ads require at least 2 descriptions')
  if (!input.targetUrl.startsWith('http://') && !input.targetUrl.startsWith('https://')) {
    throw new Error('targetUrl must be a valid http or https URL')
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
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: true,
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
  for (const kw of input.keywords.slice(0, 50)) {
    if (!kw.text.trim()) continue
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
    const errorText = await response.text()
    throw new Error(`Google Ads campaign creation failed (${response.status}): ${errorText.slice(0, 500)}`)
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
  const budgetRes = responses[0]?.campaignBudgetResult?.resourceName ?? ''
  const campRes = responses[1]?.campaignResult?.resourceName ?? ''
  const adGroupRes = responses[2]?.adGroupResult?.resourceName ?? ''
  const adRes = responses[responses.length - 1]?.adGroupAdResult?.resourceName ?? ''
  const campaignId = campRes.split('/').pop() ?? ''

  return {
    campaignId,
    resourceName: campRes,
    budgetResourceName: budgetRes,
    adGroupResourceName: adGroupRes,
    adResourceName: adRes,
    status: input.status ?? 'PAUSED',
  }
}

export interface CloneCampaignInput {
  sourceCampaignId: string
  newCampaignName: string
  targetUrl: string
  dailyBudgetAmountMicros?: number
  headlineReplacements?: Record<string, string>
  additionalKeywords?: string[]
  status?: 'ENABLED' | 'PAUSED'
}

/** Clones an existing campaign structure adapting it for a new landing page */
export async function cloneGoogleAdsCampaign(
  accessToken: string,
  developerToken: string | undefined,
  customerId: string,
  input: CloneCampaignInput,
): Promise<CreateCampaignResult> {
  const source = await getGoogleAdsCampaignDetail(accessToken, developerToken, customerId, input.sourceCampaignId)

  // Map headlines with replacements
  let headlines = source.headlines.slice()
  if (input.headlineReplacements) {
    for (const [from, to] of Object.entries(input.headlineReplacements)) {
      headlines = headlines.map(h => h.replace(new RegExp(from, 'gi'), to))
    }
  }
  if (headlines.length < 3) {
    headlines.push(input.newCampaignName.slice(0, 30))
  }

  // Keywords
  const keywords = source.keywords.map(k => ({ text: k.text, matchType: k.matchType }))
  if (input.additionalKeywords) {
    for (const kw of input.additionalKeywords) {
      if (kw.trim() && !keywords.some(k => k.text.toLowerCase() === kw.toLowerCase())) {
        keywords.push({ text: kw.trim(), matchType: 'PHRASE' })
      }
    }
  }

  return await createGoogleAdsSearchCampaign(accessToken, developerToken, customerId, {
    name: input.newCampaignName,
    dailyBudgetAmountMicros: input.dailyBudgetAmountMicros ?? source.budgetAmountMicros,
    targetUrl: input.targetUrl,
    keywords,
    headlines,
    descriptions: source.descriptions.length >= 2 ? source.descriptions : [
      'Discover authentic experiences and services today. Book directly online.',
      'Quality guaranteed with personalized service. Explore our latest offerings.',
    ],
    status: input.status ?? 'PAUSED',
  })
}

/** Pause or enable a campaign */
export async function updateGoogleAdsCampaignStatus(
  accessToken: string,
  developerToken: string | undefined,
  customerId: string,
  campaignId: string,
  status: 'ENABLED' | 'PAUSED',
): Promise<{ campaignId: string; status: string }> {
  const cid = cleanCustomerId(customerId)
  const headers = googleAdsHeaders(accessToken, developerToken)

  const response = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/campaigns:mutate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      operations: [{
        update: {
          resourceName: `customers/${cid}/campaigns/${campaignId}`,
          status,
        },
        updateMask: 'status',
      }],
    }),
  })

  if (!response.ok) {
    throw new Error(`Google Ads status update failed: ${(await response.text()).slice(0, 300)}`)
  }

  return { campaignId, status }
}

/** Update daily budget for a campaign */
export async function updateGoogleAdsCampaignBudget(
  accessToken: string,
  developerToken: string | undefined,
  customerId: string,
  budgetId: string,
  amountMicros: number,
): Promise<{ budgetId: string; amountMicros: number }> {
  const cid = cleanCustomerId(customerId)
  const headers = googleAdsHeaders(accessToken, developerToken)

  const response = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/campaignBudgets:mutate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      operations: [{
        update: {
          resourceName: `customers/${cid}/campaignBudgets/${budgetId}`,
          amountMicros: String(amountMicros),
        },
        updateMask: 'amountMicros',
      }],
    }),
  })

  if (!response.ok) {
    throw new Error(`Google Ads budget update failed: ${(await response.text()).slice(0, 300)}`)
  }

  return { budgetId, amountMicros }
}

/** The account's currency and name, independent of any reporting range. */
export async function getGoogleAdsCustomer(accessToken: string, developerToken: string | undefined, customerId: string): Promise<{ descriptiveName: string; currencyCode: string; timeZone: string }> {
  const cid = cleanCustomerId(customerId)
  const response = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers: googleAdsHeaders(accessToken, developerToken),
    body: JSON.stringify({ query: 'SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1' }),
  })
  if (!response.ok) throw new Error(`Google Ads API error (${response.status}): ${(await response.text()).slice(0, 300)}`)
  const data = (await response.json()) as { results?: Array<{ customer?: { descriptiveName?: string; currencyCode?: string; timeZone?: string } }> }
  const customer = data.results?.[0]?.customer
  if (!customer?.currencyCode || !customer.timeZone) throw new Error(`Google Ads did not describe customer ${cid}`)
  return { descriptiveName: customer.descriptiveName ?? '', currencyCode: customer.currencyCode, timeZone: customer.timeZone }
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

  if (!response.ok) {
    const errorText = (await response.text()).slice(0, 300)
    throw new Error(`Google Ads search query failed (${response.status}): ${errorText}`)
  }

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
