import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatGoogleAdsCustomerId,
  listGoogleAdsAccounts,
  listGoogleAdsCampaigns,
  getGoogleAdsCampaignDetail,
  createGoogleAdsSearchCampaign,
  updateGoogleAdsCampaign,
  getGoogleAdsPerformanceSummary,
} from '../../server/utils/google-ads.ts'

test('formatGoogleAdsCustomerId formats 10 digits into XXX-XXX-XXXX format', () => {
  assert.equal(formatGoogleAdsCustomerId('3317427925'), '331-742-7925')
  assert.equal(formatGoogleAdsCustomerId('331-742-7925'), '331-742-7925')
  assert.equal(formatGoogleAdsCustomerId('12345'), '12345')
})

test('listGoogleAdsAccounts queries accessible customers and retrieves descriptive names', async (t) => {
  const requests: Array<{ url: string; method?: string; body?: string }> = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input)
    requests.push({ url, method: init?.method, body: init?.body ? String(init.body) : undefined })
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token')
    assert.equal(new Headers(init?.headers).get('developer-token'), 'dev-tok-123')

    if (url.endsWith('/customers:listAccessibleCustomers')) {
      return Response.json({
        resourceNames: ['customers/3317427925', 'customers/1234567890', 'customers/5555555555', 'customers/8699514202'],
      })
    }

    if (url.includes('/customers/3317427925/googleAds:search')) {
      return Response.json({
        results: [
          {
            customer: {
              id: '3317427925',
              descriptiveName: 'KrabiClaw',
              currencyCode: 'USD',
              timeZone: 'America/New_York',
              manager: false,
            },
          },
        ],
      })
    }

    if (url.includes('/customers/5555555555/googleAds:search')) {
      return Response.json({ error: { code: 403, message: 'The caller does not have permission', details: [{ errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, message: 'The developer token is only approved for use with test accounts.' }] }] } }, { status: 403 })
    }

    if (url.includes('/customers/8699514202/googleAds:search')) {
      return Response.json({ error: { code: 403, message: 'The caller does not have permission', details: [{ errors: [{ errorCode: { authorizationError: 'CUSTOMER_NOT_ENABLED' }, message: "The customer account can't be accessed because it is not yet enabled or has been deactivated." }] }] } }, { status: 403 })
    }

    if (url.includes('/customers/1234567890/googleAds:search')) {
      return Response.json({
        results: [
          {
            customer: {
              id: '1234567890',
              descriptiveName: 'Client Account',
              currencyCode: 'THB',
              timeZone: 'Asia/Bangkok',
              manager: true,
            },
          },
        ],
      })
    }

    return new Response('Not found', { status: 404 })
  })

  const accounts = await listGoogleAdsAccounts('test-token', 'dev-tok-123')
  assert.equal(accounts.length, 4)
  // An account Google will not describe carries Google's reason, not a made-up name.
  assert.deepEqual(accounts[2], { customerId: '5555555555', formattedCustomerId: '555-555-5555', descriptiveName: null, error: 'DEVELOPER_TOKEN_NOT_APPROVED: The developer token is only approved for use with test accounts.' })
  // A cancelled or never-enabled account is marked, not reported as a failure.
  assert.deepEqual(accounts[3], { customerId: '8699514202', formattedCustomerId: '869-951-4202', descriptiveName: null, notEnabled: true })
  assert.deepEqual(accounts[0], {
    customerId: '3317427925',
    formattedCustomerId: '331-742-7925',
    descriptiveName: 'KrabiClaw',
    currencyCode: 'USD',
    timeZone: 'America/New_York',
    isManager: false,
  })
  assert.deepEqual(accounts[1], {
    customerId: '1234567890',
    formattedCustomerId: '123-456-7890',
    descriptiveName: 'Client Account',
    currencyCode: 'THB',
    timeZone: 'Asia/Bangkok',
    isManager: true,
  })
  assert.equal(requests.length, 5)
})

test('listGoogleAdsCampaigns queries campaigns and formats performance metrics', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input)
    assert.ok(url.includes('/customers/3317427925/googleAds:search'))
    const body = JSON.parse(String(init?.body))
    assert.ok(body.query.includes('FROM campaign'))

    return Response.json({
      results: [
        {
          campaign: { id: '111', name: 'Blog Post Promotion', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
          campaignBudget: { id: '999', amountMicros: '10000000' },
          metrics: { clicks: '50', impressions: '1000', costMicros: '25000000', conversions: 5 },
        },
      ],
    })
  })

  const campaigns = await listGoogleAdsCampaigns('test-token', 'dev-tok', '331-742-7925', 'ENABLED')
  assert.equal(campaigns.length, 1)
  assert.equal(campaigns[0].id, '111')
  assert.equal(campaigns[0].name, 'Blog Post Promotion')
  assert.equal(campaigns[0].budgetAmountMicros, 10000000)
  assert.equal(campaigns[0].clicks, 50)
  assert.equal(campaigns[0].impressions, 1000)
  assert.equal(campaigns[0].costMicros, 25000000)
  assert.equal(campaigns[0].conversions, 5)
})

test('creating a search campaign submits its budget, targeting and copy atomically while paused and returns Google resource names', async (t) => {
  const targetUrl = 'https://krabiclaw.com/blog/operations/preview'
  const headlines = ['Discover Krabi', 'Authentic Tours', 'Book Online Now']
  const descriptions = ['Explore breathtaking islands with local experts.', 'Personalized tours with guaranteed quality.']
  const providerFetch = t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://googleads.googleapis.com')
    assert.match(url.pathname, /^\/v\d+\/customers\/3317427925\/googleAds:mutate$/)
    assert.equal(init?.method, 'POST')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('Authorization'), 'Bearer test-token')
    assert.equal(headers.get('developer-token'), 'dev-tok')
    assert.equal(headers.get('Content-Type'), 'application/json')

    const { mutateOperations: operations, partialFailure } = JSON.parse(String(init?.body))
    assert.notEqual(partialFailure, true)
    assert.equal(operations.length, 6)
    const budget = operations[0].campaignBudgetOperation.create
    const campaign = operations[1].campaignOperation.create
    const adGroup = operations[2].adGroupOperation.create
    assert.match(budget.resourceName, /^customers\/3317427925\/campaignBudgets\/-\d+$/)
    assert.match(campaign.resourceName, /^customers\/3317427925\/campaigns\/-\d+$/)
    assert.match(adGroup.resourceName, /^customers\/3317427925\/adGroups\/-\d+$/)
    assert.equal(budget.amountMicros, '15000000')
    assert.equal(budget.explicitlyShared, false)
    assert.equal(campaign.name, 'New Blog Post Campaign')
    assert.equal(campaign.status, 'PAUSED')
    assert.equal(campaign.advertisingChannelType, 'SEARCH')
    assert.equal(campaign.containsEuPoliticalAdvertising, 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING')
    assert.deepEqual(campaign.networkSettings, { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false })
    assert.equal(campaign.campaignBudget, budget.resourceName)
    assert.equal(adGroup.campaign, campaign.resourceName)
    assert.deepEqual(operations.slice(3, 5).map((operation: {
      adGroupCriterionOperation: { create: { adGroup: string; keyword: { text: string; matchType: string } } }
    }) => ({
      adGroup: operation.adGroupCriterionOperation.create.adGroup,
      keyword: operation.adGroupCriterionOperation.create.keyword,
    })), [
      { adGroup: adGroup.resourceName, keyword: { text: 'krabi tours', matchType: 'PHRASE' } },
      { adGroup: adGroup.resourceName, keyword: { text: 'local island guide', matchType: 'EXACT' } },
    ])
    const ad = operations[5].adGroupAdOperation.create
    assert.equal(ad.adGroup, adGroup.resourceName)
    assert.deepEqual(ad.ad.finalUrls, [targetUrl])
    assert.deepEqual(ad.ad.responsiveSearchAd, {
      headlines: headlines.map(text => ({ text })),
      descriptions: descriptions.map(text => ({ text })),
    })

    return Response.json({
      mutateOperationResponses: [
        { campaignBudgetResult: { resourceName: 'customers/3317427925/campaignBudgets/888' } },
        { campaignResult: { resourceName: 'customers/3317427925/campaigns/222' } },
        { adGroupResult: { resourceName: 'customers/3317427925/adGroups/333' } },
        { adGroupCriterionResult: { resourceName: 'customers/3317427925/adGroupCriteria/444' } },
        { adGroupCriterionResult: { resourceName: 'customers/3317427925/adGroupCriteria/445' } },
        { adGroupAdResult: { resourceName: 'customers/3317427925/adGroupAds/555' } },
      ],
    })
  })

  const result = await createGoogleAdsSearchCampaign('test-token', 'dev-tok', '331-742-7925', {
    name: 'New Blog Post Campaign',
    dailyBudgetAmountMicros: 15000000,
    targetUrl,
    keywords: [{ text: 'krabi tours', matchType: 'PHRASE' }, { text: 'local island guide', matchType: 'EXACT' }],
    headlines,
    descriptions,
    containsEuPoliticalAdvertising: false,
  })

  assert.equal(providerFetch.mock.callCount(), 1)
  assert.deepEqual(result, {
    campaignId: '222',
    resourceName: 'customers/3317427925/campaigns/222',
    budgetResourceName: 'customers/3317427925/campaignBudgets/888',
    adGroupResourceName: 'customers/3317427925/adGroups/333',
    adResourceName: 'customers/3317427925/adGroupAds/555',
    status: 'PAUSED',
  })
})

test('creating a search campaign reports a provider rejection instead of returning a campaign receipt', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://googleads.googleapis.com')
    assert.match(url.pathname, /^\/v\d+\/customers\/3317427925\/googleAds:mutate$/)
    assert.equal(init?.method, 'POST')
    return Response.json({ error: { code: 400, message: 'Request contains an invalid argument.', details: [{ errors: [{ errorCode: { fieldError: 'REQUIRED' }, message: 'The required field was not present.', location: { fieldPathElements: [{ fieldName: 'mutate_operations', index: 1 }, { fieldName: 'campaign_operation' }, { fieldName: 'create' }, { fieldName: 'contains_eu_political_advertising' }] } }] }] } }, { status: 400 })
  })

  await assert.rejects(createGoogleAdsSearchCampaign('test-token', 'dev-tok', '331-742-7925', {
    name: 'New Blog Post Campaign',
    dailyBudgetAmountMicros: 15000000,
    targetUrl: 'https://krabiclaw.com/blog/operations/preview',
    keywords: [{ text: 'krabi tours', matchType: 'PHRASE' }],
    headlines: ['Discover Krabi', 'Authentic Tours', 'Book Online Now'],
    descriptions: ['Explore breathtaking islands with local experts.', 'Personalized tours with guaranteed quality.'],
    containsEuPoliticalAdvertising: false,
  }), { message: 'Google Ads campaign creation failed: REQUIRED: The required field was not present. (mutate_operations[1].campaign_operation.create.contains_eu_political_advertising)' })
})

test('campaign detail reports provider read failures instead of returning empty targeting or ad copy', async (t) => {
  for (const failedQuery of ['FROM ad_group WHERE', 'FROM ad_group_criterion WHERE', 'FROM ad_group_ad WHERE']) {
    const providerFetch = t.mock.method(globalThis, 'fetch', async (_input, init) => {
      const { query } = JSON.parse(String(init?.body))
      if (query.includes(failedQuery)) return new Response('Access denied', { status: 403 })
      if (query.includes('FROM campaign WHERE')) return Response.json({ results: [{ campaign: { id: '100', name: 'Source', status: 'PAUSED', advertisingChannelType: 'SEARCH' } }] })
      return Response.json({ results: [] })
    })
    await assert.rejects(getGoogleAdsCampaignDetail('token', 'dev', '3317427925', '100'), /query failed \(403\): Access denied/u)
    providerFetch.mock.restore()
  }
})

test('campaign creation refuses invalid copy before sending a provider mutation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Invalid copy must not reach the provider') })
  await assert.rejects(createGoogleAdsSearchCampaign('token', 'dev', '3317427925', {
    name: 'Campaign', dailyBudgetAmountMicros: 1000000, targetUrl: 'https://example.com', keywords: [],
    headlines: ['A'.repeat(31), 'Second headline', 'Third headline'],
    descriptions: ['First description', 'Second description'], containsEuPoliticalAdvertising: false,
  }), /3 to 15 unique nonempty headlines of at most 30 characters/u)
})

test('campaign status and budget updates validate ownership and submit one atomic provider mutation', async (t) => {
  const mutations: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body))
    if (url.endsWith('/googleAds:search')) {
      assert.equal(body.query, 'SELECT campaign_budget.id FROM campaign WHERE campaign.id = 222 LIMIT 1')
      return Response.json({ results: [{ campaignBudget: { id: '888' } }] })
    }
    assert.ok(url.endsWith('/googleAds:mutate'))
    assert.notEqual(body.partialFailure, true)
    mutations.push(body.mutateOperations)
    return Response.json({ mutateOperationResponses: [
      { campaignBudgetResult: { resourceName: 'customers/3317427925/campaignBudgets/888' } },
      { campaignResult: { resourceName: 'customers/3317427925/campaigns/222' } },
    ] })
  })

  await updateGoogleAdsCampaign('test-token', 'dev-tok', '331-742-7925', { campaignId: '222', status: 'PAUSED', budgetId: '888', dailyBudgetAmountMicros: 20000000 })
  assert.deepEqual(mutations, [[
    { campaignBudgetOperation: { update: { resourceName: 'customers/3317427925/campaignBudgets/888', amountMicros: '20000000' }, updateMask: 'amountMicros' } },
    { campaignOperation: { update: { resourceName: 'customers/3317427925/campaigns/222', status: 'PAUSED' }, updateMask: 'status' } },
  ]])
})

test('campaign updates reject incomplete input and another campaign’s budget before any write', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.ok(String(input).endsWith('/googleAds:search'), 'invalid input must not trigger a mutation')
    return Response.json({ results: [{ campaignBudget: { id: '999' } }] })
  })
  await assert.rejects(updateGoogleAdsCampaign('token', 'dev', '3317427925', { campaignId: '222', status: 'ENABLED', dailyBudgetAmountMicros: 20000000 }), /must be supplied together/u)
  await assert.rejects(updateGoogleAdsCampaign('token', 'dev', '3317427925', { campaignId: '222' }), /Supply a status or daily budget/u)
  await assert.rejects(updateGoogleAdsCampaign('token', 'dev', '3317427925', { campaignId: '222', status: 'ENABLED', budgetId: '888', dailyBudgetAmountMicros: 20000000 }), /does not belong to campaign 222/u)
})

test('getGoogleAdsPerformanceSummary queries customer aggregates and calculates blended CPC', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    return Response.json({
      results: [
        {
          customer: { currencyCode: 'USD' },
          metrics: { clicks: '100', impressions: '2000', costMicros: '50000000', conversions: 10 },
        },
      ],
    })
  })

  const summary = await getGoogleAdsPerformanceSummary('test-token', 'dev-tok', '331-742-7925', '2026-09-01', '2026-09-30')
  assert.equal(summary.currencyCode, 'USD')
  assert.equal(summary.clicks, 100)
  assert.equal(summary.impressions, 2000)
  assert.equal(summary.costMicros, 50000000)
  assert.equal(summary.conversions, 10)
  assert.equal(summary.averageCpcMicros, 500000) // 50M / 100
})

