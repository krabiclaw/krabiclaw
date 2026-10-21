import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatGoogleAdsCustomerId,
  listGoogleAdsAccounts,
  listGoogleAdsCampaigns,
  createGoogleAdsSearchCampaign,
  cloneGoogleAdsCampaign,
  updateGoogleAdsCampaignStatus,
  updateGoogleAdsCampaignBudget,
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
    assert.equal(campaign.name, 'New Blog Post Campaign')
    assert.equal(campaign.status, 'PAUSED')
    assert.equal(campaign.advertisingChannelType, 'SEARCH')
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
    return Response.json({ error: { message: 'Customer account is not enabled.' } }, { status: 403 })
  })

  await assert.rejects(createGoogleAdsSearchCampaign('test-token', 'dev-tok', '331-742-7925', {
    name: 'New Blog Post Campaign',
    dailyBudgetAmountMicros: 15000000,
    targetUrl: 'https://krabiclaw.com/blog/operations/preview',
    keywords: [{ text: 'krabi tours', matchType: 'PHRASE' }],
    headlines: ['Discover Krabi', 'Authentic Tours', 'Book Online Now'],
    descriptions: ['Explore breathtaking islands with local experts.', 'Personalized tours with guaranteed quality.'],
  }), /Google Ads campaign creation failed \(403\).*Customer account is not enabled\./)
})

test('cloneGoogleAdsCampaign reads source campaign, applies replacements, and creates new campaign', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input)
    if (url.includes('googleAds:search')) {
      const body = JSON.parse(String(init?.body))
      if (body.query.includes('FROM campaign WHERE')) {
        return Response.json({
          results: [{
            campaign: { id: '100', name: 'Original Promo', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
            campaignBudget: { id: '900', amountMicros: '20000000' },
            metrics: { clicks: '10', impressions: '200', costMicros: '5000000', conversions: 1 },
          }],
        })
      }
      if (body.query.includes('FROM ad_group WHERE')) {
        return Response.json({ results: [{ adGroup: { id: '101', name: 'Original Ad Group', status: 'ENABLED' } }] })
      }
      if (body.query.includes('FROM ad_group_criterion WHERE')) {
        return Response.json({
          results: [
            { adGroupCriterion: { keyword: { text: 'island hopping', matchType: 'PHRASE' } } },
          ],
        })
      }
      if (body.query.includes('FROM ad_group_ad WHERE')) {
        return Response.json({
          results: [{
            adGroupAd: {
              ad: {
                responsiveSearchAd: {
                  headlines: [{ text: 'Island Tour' }, { text: 'Best Travel Guide' }, { text: 'Book Now' }],
                  descriptions: [{ text: 'Experience islands at great prices.' }, { text: 'Book your spot today.' }],
                },
                finalUrls: ['https://krabiclaw.com/blog/island-hopping'],
              },
            },
          }],
        })
      }
    }

    if (url.includes('googleAds:mutate')) {
      return Response.json({
        mutateOperationResponses: [
          { campaignBudgetResult: { resourceName: 'customers/3317427925/campaignBudgets/901' } },
          { campaignResult: { resourceName: 'customers/3317427925/campaigns/201' } },
          { adGroupResult: { resourceName: 'customers/3317427925/adGroups/301' } },
          { adGroupCriterionResult: { resourceName: 'customers/3317427925/adGroupCriteria/401' } },
          { adGroupAdResult: { resourceName: 'customers/3317427925/adGroupAds/501' } },
        ],
      })
    }

    return new Response('Not found', { status: 404 })
  })

  const cloned = await cloneGoogleAdsCampaign('test-token', 'dev-tok', '331-742-7925', {
    sourceCampaignId: '100',
    newCampaignName: 'New Destination Promo',
    targetUrl: 'https://krabiclaw.com/blog/new-destination',
    headlineReplacements: { Island: 'Beach' },
    status: 'PAUSED',
  })

  assert.equal(cloned.campaignId, '201')
  assert.equal(cloned.status, 'PAUSED')
})

test('updateGoogleAdsCampaignStatus and updateGoogleAdsCampaignBudget mutate campaign and budget', async (t) => {
  const mutated: string[] = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input)
    mutated.push(url)
    return Response.json({ results: [] })
  })

  const statusRes = await updateGoogleAdsCampaignStatus('test-token', 'dev-tok', '331-742-7925', '222', 'PAUSED')
  assert.equal(statusRes.campaignId, '222')
  assert.equal(statusRes.status, 'PAUSED')

  const budgetRes = await updateGoogleAdsCampaignBudget('test-token', 'dev-tok', '331-742-7925', '888', 20000000)
  assert.equal(budgetRes.budgetId, '888')
  assert.equal(budgetRes.amountMicros, 20000000)

  assert.equal(mutated.length, 2)
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

