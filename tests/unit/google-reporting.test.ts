import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv from 'ajv'
import { GOOGLE_ADS_TOOLS } from '../../server/utils/mcp-tools/google-ads.ts'
import { getCampaignBiddingSettings, getCampaignDeliveryDiagnostics, getConversionTrackingHealth, listConversionActions, queryGoogleAdsChangeHistory } from '../../server/utils/google-ads-diagnostics.ts'
import { getGoogleAdsReport } from '../../server/utils/google-ads.ts'
import { runGa4Report } from '../../server/utils/google-analytics.ts'
import { querySearchAnalytics } from '../../server/utils/google-search-console.ts'

test('a Google Ads report asks GAQL for the chosen days and maps each row', async (t) => {
  let body: { query?: string } = {}
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(String(input), 'https://googleads.googleapis.com/v25/customers/6495293607/googleAds:search')
    body = JSON.parse(String(init?.body))
    return Response.json({ results: [
      { searchTermView: { searchTerm: 'iep lawyer raleigh', status: 'NONE' }, campaign: { id: '11', name: 'IEP' }, adGroup: { id: '21' }, metrics: { impressions: '120', clicks: '9', costMicros: '23450000', conversions: 2, conversionsValue: 0 } },
      // Google leaves zero-valued metrics out of the JSON.
      { searchTermView: { searchTerm: 'special education attorney', status: 'ADDED' }, campaign: { id: '11', name: 'IEP' }, adGroup: { id: '21' }, metrics: { impressions: '40' } },
    ] })
  })
  const rows = await getGoogleAdsReport('token', 'dev', '649-529-3607', { report: 'search_terms', startDate: '2025-10-01', endDate: '2025-10-29', campaignId: '11', limit: 50 })
  assert.equal(body.query, "SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, ad_group.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE segments.date BETWEEN '2025-10-01' AND '2025-10-29' AND campaign.id = 11 ORDER BY metrics.clicks DESC LIMIT 50")
  assert.deepEqual(rows, [
    { text: 'iep lawyer raleigh', detail: 'NONE', date: null, campaignId: '11', campaignName: 'IEP', adGroupId: '21', impressions: 120, clicks: 9, costMicros: 23450000, conversions: 2, conversionsValue: 0 },
    { text: 'special education attorney', detail: 'ADDED', date: null, campaignId: '11', campaignName: 'IEP', adGroupId: '21', impressions: 40, clicks: 0, costMicros: 0, conversions: 0, conversionsValue: 0 },
  ])
  await assert.rejects(getGoogleAdsReport('token', 'dev', '6495293607', { report: 'keywords', startDate: '2025-10-1', endDate: '2025-10-29', limit: 10 }), /calendar days/)
})

test('a GA4 report sends the ranges, filters and order, and reads rows by header', async (t) => {
  let body: Record<string, unknown> = {}
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(String(input), 'https://analyticsdata.googleapis.com/v1beta/properties/356115887:runReport')
    body = JSON.parse(String(init?.body))
    return Response.json({
      dimensionHeaders: [{ name: 'date' }, { name: 'dateRange' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'sessions' }],
      rows: [{ dimensionValues: [{ value: '20251001' }, { value: 'last_year' }], metricValues: [{ value: '57' }, { value: '63' }] }],
      rowCount: 31, metadata: { timeZone: 'America/New_York', currencyCode: 'USD' }, propertyQuota: { tokensPerDay: { consumed: 12, remaining: 199988 } },
    })
  })
  const report = await runGa4Report('token', '356115887', {
    dateRanges: [{ startDate: '2025-10-01', endDate: '2025-10-31', name: 'last_year' }, { startDate: '2026-10-01', endDate: '2026-10-31' }],
    dimensions: ['date'], metrics: ['activeUsers', 'sessions'],
    filters: [{ dimension: 'landingPage', match: 'BEGINS_WITH', value: '/blog/' }],
    orderBy: { field: 'date', kind: 'dimension', desc: false }, limit: 100, offset: 0,
  })
  assert.deepEqual(body.dimensionFilter, { andGroup: { expressions: [{ filter: { fieldName: 'landingPage', stringFilter: { matchType: 'BEGINS_WITH', value: '/blog/' } } }] } })
  assert.deepEqual(body.orderBys, [{ desc: false, dimension: { dimensionName: 'date' } }])
  assert.equal(body.returnPropertyQuota, true)
  assert.deepEqual(report, { rows: [{ dimensions: { date: '20251001', dateRange: 'last_year' }, metrics: { activeUsers: 57, sessions: 63 } }], rowCount: 31, timeZone: 'America/New_York', currencyCode: 'USD', propertyQuota: { tokensPerDay: { consumed: 12, remaining: 199988 } } })
})

test('a GA4 row without its metric values is refused, not counted as zero', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    dimensionHeaders: [{ name: 'date' }], metricHeaders: [{ name: 'sessions' }],
    rows: [{ dimensionValues: [{ value: '20251001' }] }], metadata: { timeZone: 'America/New_York', currencyCode: 'USD' },
  }))
  await assert.rejects(runGa4Report('token', '356115887', { dateRanges: [{ startDate: '2025-10-01', endDate: '2025-10-01' }], dimensions: ['date'], metrics: ['sessions'], filters: [], orderBy: null, limit: 10, offset: 0 }), /incomplete row/)
})

test('Search Console analytics name each key by its dimension and keep Google\'s figures', async (t) => {
  let request: { url: string; body: Record<string, unknown> } = { url: '', body: {} }
  const providerFetch = t.mock.method(globalThis, 'fetch', async (input, init) => {
    request = { url: String(input), body: JSON.parse(String(init?.body)) }
    return Response.json({ rows: [{ keys: ['iep vs 504', 'https://www.northcarolinalegalservices.org/blog/iep-vs-504'], clicks: 12, impressions: 340, ctr: 0.0353, position: 7.4 }], responseAggregationType: 'byPage' })
  })
  const result = await querySearchAnalytics('token', 'sc-domain:northcarolinalegalservices.org', {
    startDate: '2025-10-01', endDate: '2025-10-29', dimensions: ['query', 'page'], filters: [{ dimension: 'country', operator: 'equals', expression: 'usa' }],
    searchType: 'web', dataState: 'final', aggregationType: 'byPage', rowLimit: 1000, startRow: 0,
  })
  assert.equal(request.url, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Anorthcarolinalegalservices.org/searchAnalytics/query')
  assert.deepEqual(request.body.dimensionFilterGroups, [{ groupType: 'and', filters: [{ dimension: 'country', operator: 'equals', expression: 'usa' }] }])
  assert.equal(request.body.dataState, 'final')
  assert.equal(request.body.aggregationType, 'byPage')
  assert.deepEqual(result, { rows: [{ keys: { query: 'iep vs 504', page: 'https://www.northcarolinalegalservices.org/blog/iep-vs-504' }, clicks: 12, impressions: 340, ctr: 0.0353, position: 7.4 }], aggregationType: 'byPage' })

  // A total with no dimensions is one row without keys.
  providerFetch.mock.mockImplementation(async () => Response.json({ rows: [{ clicks: 310, impressions: 9200, ctr: 0.0337, position: 11.2 }], responseAggregationType: 'byProperty' }))
  const total = await querySearchAnalytics('token', 'sc-domain:northcarolinalegalservices.org', {
    startDate: '2025-10-01', endDate: '2025-10-29', dimensions: [], filters: [], searchType: 'web', dataState: 'final', aggregationType: 'auto', rowLimit: 1, startRow: 0,
  })
  assert.deepEqual(total.rows, [{ keys: {}, clicks: 310, impressions: 9200, ctr: 0.0337, position: 11.2 }])
})


const adsConnection = { accessToken: 'test-access', developerToken: 'test-developer', customerId: '1234567890' }
const october = { start_date: '2026-10-01', end_date: '2026-10-31' }

function assertAdsToolOutput(toolName: string, value: unknown) {
  const tool = GOOGLE_ADS_TOOLS.find(tool => tool.name === toolName)
  assert.ok(tool)
  const ajv = new Ajv({ strict: false })
  assert.equal(ajv.validate(tool.outputSchema, value), true, ajv.errorsText())
  assert.equal(tool.annotations?.readOnlyHint, true)
}

test('Google Ads change history preserves actor and changed values and refuses dates outside retention', async (t) => {
  const queries: string[] = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(String(input), 'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search')
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-access')
    const { query } = JSON.parse(String(init?.body))
    queries.push(query)
    if (query.includes('FROM customer')) return Response.json({ results: [{ customer: { timeZone: 'America/New_York' } }] })
    const event = { resourceName: 'customers/1234567890/changeEvents/1~0~0', changeDateTime: '2026-10-30 08:01:59.000001',
      userEmail: 'editor@example.test', clientType: 'GOOGLE_ADS_WEB_CLIENT', changedFields: 'primaryForGoal,includeInConversionsMetric',
      oldResource: { conversionAction: { primaryForGoal: true } }, newResource: { conversionAction: { primaryForGoal: false } } }
    return Response.json({ results: [{ changeEvent: event }, { changeEvent: event }] })
  })
  const now = new Date('2026-11-18T03:00:00Z')
  await assert.rejects(queryGoogleAdsChangeHistory(adsConnection, october, 10, now), /available from 2026-10-19 through 2026-11-17.*Google Ads console/)
  assert.equal(queries.length, 1)
  const result = await queryGoogleAdsChangeHistory(adsConnection, { start_date: '2026-10-30', end_date: '2026-10-30' }, 1, now)
  assert.match(queries.at(-1)!, /change_event\.change_date_time < '2026-10-31 00:00:00'/)
  assert.match(queries.at(-1)!, /LIMIT 2/)
  assert.deepEqual(result.changes.map(row => [row.actor_email, row.changed_fields, row.new_resource]), [
    ['editor@example.test', ['primaryForGoal', 'includeInConversionsMetric'], { conversionAction: { primaryForGoal: false } }],
  ])
  assert.equal(result.has_more, true)
  assertAdsToolOutput('query_google_ads_change_history', result)
})

test('delivery and bidding diagnostics keep shared budgets, rank losses, and portfolio targets visible', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    const { query } = JSON.parse(String(init?.body))
    if (query.includes('FROM accessible_bidding_strategy')) return Response.json({ results: [{
      accessibleBiddingStrategy: { name: 'Shared Leads', ownerCustomerId: '1234567890', maximizeConversions: { targetCpaMicros: '75000000' } },
    }] })
    assert.match(query, /campaign\.id = 11/)
    if (query.includes('campaign.bidding_strategy_type')) return Response.json({ results: [{
      campaign: { name: 'Leads', biddingStrategyType: 'MAXIMIZE_CONVERSIONS', biddingStrategy: 'customers/1234567890/biddingStrategies/42',
        accessibleBiddingStrategy: 'customers/1234567890/accessibleBiddingStrategies/42' }, customer: { currencyCode: 'USD' },
    }] })
    if (query.includes('campaign.primary_status')) return Response.json({ results: [{
      campaign: { name: 'Leads', primaryStatus: 'LIMITED', primaryStatusReasons: ['HAS_ADS_DISAPPROVED'] },
      campaignBudget: { id: '123', amountMicros: '329000000', explicitlyShared: true, referenceCount: '3' },
      customer: { status: 'ENABLED', currencyCode: 'USD', timeZone: 'America/New_York' },
    }] })
    if (query.includes('metrics.search_impression_share')) return Response.json({ results: [{
      metrics: { impressions: '5403', clicks: '352', searchRankLostImpressionShare: 0.9001, searchBudgetLostImpressionShare: 0.0038 },
    }] })
    if (query.includes('FROM campaign_criterion')) return Response.json({ results: [{
      campaignCriterion: { criterionId: '3', type: 'LOCATION', status: 'ENABLED', location: { geoTargetConstant: 'geoTargetConstants/21137' } },
    }] })
    if (query.includes('FROM ad_group_criterion')) return Response.json({ results: [{
      adGroup: { id: '9' }, adGroupCriterion: { criterionId: '7', type: 'USER_LIST', negative: true, userList: { userList: 'customers/1234567890/userLists/7' } },
    }] })
    assert.match(query, /FROM ad_group_ad/)
    return Response.json({ results: [{ adGroup: { id: '9' }, adGroupAd: { ad: { id: '2' }, policySummary: {
      approvalStatus: 'DISAPPROVED', policyTopicEntries: [{ topic: 'DESTINATION_NOT_WORKING' }],
    } } }] })
  })
  const bidding = await getCampaignBiddingSettings(adsConnection, '11')
  assert.equal(bidding.target_cpa_micros, 75_000_000)
  assert.equal(bidding.portfolio_name, 'Shared Leads')
  assertAdsToolOutput('get_campaign_bidding_settings', bidding)
  const delivery = await getCampaignDeliveryDiagnostics(adsConnection, '11', october)
  assert.deepEqual([delivery.shared_budget, delivery.budget_reference_count], [true, 3])
  assert.deepEqual([delivery.metrics?.search_rank_lost_impression_share, delivery.metrics?.search_budget_lost_impression_share], [0.9001, 0.0038])
  assert.equal(delivery.ads[0]?.policy_topics[0], 'DESTINATION_NOT_WORKING')
  assert.equal(delivery.campaign_criteria[0]?.resource, 'geoTargetConstants/21137')
  assert.deepEqual(delivery.ad_group_criteria.map(row => [row.ad_group_id, row.negative, row.resource]), [['9', true, 'customers/1234567890/userLists/7']])
  assertAdsToolOutput('get_campaign_delivery_diagnostics', delivery)
  await assert.rejects(getCampaignDeliveryDiagnostics(adsConnection, '11 OR 1=1', october), /numeric Google Ads campaign_id/)
})

test('conversion diagnostics separate Ads goal settings from recorded activity and surface provider failures', async (t) => {
  let denied = false
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    const { query } = JSON.parse(String(init?.body))
    if (denied) return Response.json({ error: { message: 'Access to the connected customer was denied' } }, { status: 403 })
    if (query.includes('FROM conversion_action')) return Response.json({ results: [{ conversionAction: {
      id: '5', resourceName: 'customers/1234567890/conversionActions/5', name: 'Generate lead', status: 'ENABLED',
      primaryForGoal: true, googleAnalytics4Settings: { propertyId: '100', eventName: 'generate_lead' },
    } }] })
    if (query.includes('FROM customer_conversion_goal')) return Response.json({ results: [{ customerConversionGoal: { category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true } }] })
    if (query.includes('segments.conversion_action')) return Response.json({ results: [{
      segments: { conversionAction: 'customers/1234567890/conversionActions/6', conversionActionName: 'CTA click' }, metrics: { allConversions: 12 },
    }] })
    return Response.json({ results: [{ customer: { autoTaggingEnabled: true, timeZone: 'America/New_York', conversionTrackingSetting: {
      conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_SELF', googleAdsConversionCustomer: 'customers/1234567890',
    } } }] })
  })
  const actions = await listConversionActions(adsConnection)
  assert.equal(actions.actions[0]?.ga4_event_name, 'generate_lead')
  assert.equal(actions.actions[0]?.primary_for_goal, true)
  assert.equal(actions.actions[0]?.include_in_conversions_metric, null)
  assertAdsToolOutput('list_conversion_actions', actions)
  const health = await getConversionTrackingHealth(adsConnection, october)
  assert.equal(health.auto_tagging_enabled, true)
  assert.equal(health.account_goals[0]?.category, 'SUBMIT_LEAD_FORM')
  assert.deepEqual(health.activity.map(row => [row.name, row.conversions, row.all_conversions]), [['CTA click', 0, 12]])
  assertAdsToolOutput('get_conversion_tracking_health', health)
  denied = true
  await assert.rejects(getConversionTrackingHealth(adsConnection, october), /\(403\): Access to the connected customer was denied/)
})
