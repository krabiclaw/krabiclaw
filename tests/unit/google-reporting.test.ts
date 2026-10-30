import assert from 'node:assert/strict'
import test from 'node:test'
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

test('a geography report names each country through Google\'s geo target constants', async (t) => {
  const queries: string[] = []
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    const query = String(JSON.parse(String(init?.body)).query)
    queries.push(query)
    if (query.includes('FROM geographic_view')) return Response.json({ results: [{ geographicView: { countryCriterionId: '2840', locationType: 'LOCATION_OF_PRESENCE' }, campaign: { id: '11', name: 'IEP' }, metrics: { clicks: '30', impressions: '400' } }] })
    return Response.json({ results: [{ geoTargetConstant: { id: '2840', name: 'United States' } }] })
  })
  const rows = await getGoogleAdsReport('token', 'dev', '6495293607', { report: 'geography', startDate: '2025-10-01', endDate: '2025-10-29', limit: 20 })
  assert.equal(queries[1], 'SELECT geo_target_constant.id, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.id IN (2840)')
  assert.deepEqual(rows.map(row => [row.text, row.detail, row.clicks]), [['United States', 'LOCATION_OF_PRESENCE', 30]])
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
  t.mock.method(globalThis, 'fetch', async (input, init) => {
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
})

test('a Search Console total with no dimensions is one row without keys', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ rows: [{ clicks: 310, impressions: 9200, ctr: 0.0337, position: 11.2 }], responseAggregationType: 'byProperty' }))
  const result = await querySearchAnalytics('token', 'sc-domain:northcarolinalegalservices.org', {
    startDate: '2025-10-01', endDate: '2025-10-29', dimensions: [], filters: [], searchType: 'web', dataState: 'final', aggregationType: 'auto', rowLimit: 1, startRow: 0,
  })
  assert.deepEqual(result.rows, [{ keys: {}, clicks: 310, impressions: 9200, ctr: 0.0337, position: 11.2 }])
})
