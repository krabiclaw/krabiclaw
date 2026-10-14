import assert from 'node:assert/strict'
import test from 'node:test'
import { formatGoogleAdsCustomerId, listGoogleAdsAccounts } from '../../server/utils/google-ads.ts'
import { INTEGRATION_PROVIDERS, INTEGRATION_SCOPES } from '../../shared/organization-settings.ts'

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
        resourceNames: ['customers/3317427925', 'customers/1234567890'],
      })
    }

    if (url.includes('/customers/3317427925/googleAds:search')) {
      return Response.json({
        results: [
          {
            customer: {
              id: '3317427925',
              descriptiveName: 'Krabiclaw',
              currencyCode: 'USD',
              timeZone: 'America/New_York',
              manager: false,
            },
          },
        ],
      })
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
  assert.equal(accounts.length, 2)
  assert.deepEqual(accounts[0], {
    customerId: '3317427925',
    formattedCustomerId: '331-742-7925',
    descriptiveName: 'Krabiclaw',
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
  assert.equal(requests.length, 3)
})

test('Google Ads integration is registered with canonical scopes and provider list', () => {
  assert.ok(INTEGRATION_PROVIDERS.includes('google_ads'))
  assert.deepEqual(INTEGRATION_SCOPES['google-ads'], ['https://www.googleapis.com/auth/adwords'])
})
