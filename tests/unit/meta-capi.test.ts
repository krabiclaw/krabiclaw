import assert from 'node:assert/strict'
import test from 'node:test'
import { deliverMetaCapiForEvent } from '../../server/utils/meta-capi-delivery'

test('deliverMetaCapiForEvent reports not_configured when no integration exists', async () => {
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
        raw: async () => [],
      }),
    }),
  } as never

  const result = await deliverMetaCapiForEvent({} as never, db, {
    eventId: '11111111-1111-4111-8111-111111111111',
    organizationId: 'org-test',
    origin: null,
    input: {
      organizationId: 'org-test',
      eventName: 'booking_submit',
      stage: 'submission',
      surface: 'website',
      value: { basis: 'quoted', amount_minor: 5000, currency: 'USD' },
    },
  })

  assert.equal(result.status, 'not_configured')
  assert.equal(result.detail, 'no_integration')
})

test('deliverMetaCapiForEvent dispatches hashed user data and maps events to Meta standard names', async () => {
  const originalFetch = globalThis.fetch
  let dispatchedPayload: Record<string, unknown> | null = null
  let dispatchedUrl: string | null = null
  let dispatchedAuthHeader: string | null = null
  const recordedUpdates: Array<{ query: string; args: unknown[] }> = []

  globalThis.fetch = async (input, init) => {
    dispatchedUrl = String(input)
    dispatchedAuthHeader = (init?.headers as Record<string, string>)?.authorization ?? null
    dispatchedPayload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({ events_received: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const integrationRow = {
    organization_id: 'org-test',
    provider: 'meta_ads',
    account_id: 'acc-1',
    target_id: 'act_101',
    target_name: 'Main Account',
    measurement_id: '987654321', // cached pixel ID
    verified: null,
    verification_token: null,
    status: null,
    last_error: null,
    revision: '1',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  }

  const db = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (query.includes('FROM organization_integrations')) return integrationRow
          return null
        },
        all: async () => {
          if (query.includes('FROM organization_integrations')) return { results: [integrationRow] }
          return { results: [] }
        },
        run: async () => {
          recordedUpdates.push({ query, args })
          return { success: true }
        },
        raw: async () => {
          if (query.includes('FROM organization_integrations')) return [integrationRow]
          return []
        },
      }),
    }),
  } as never

  const env = {
    DB: db,
    BETTER_AUTH_SECRET: 'test-secret',
  } as never

  const headers = new Headers({
    'cf-connecting-ip': '203.0.113.195',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    'referer': 'https://example.com/reservation',
    cookie: '_fbp=fb.1.1558571054389.1098115397; _fbc=fb.1.1554763741205.AbCdEfGhIjKlMnOpQrStUvWxYz',
  })

  try {
    const result = await deliverMetaCapiForEvent(env, db, {
      eventId: '22222222-2222-4222-8222-222222222222',
      organizationId: 'org-test',
      origin: { headers },
      input: {
        organizationId: 'org-test',
        eventName: 'reservation_submit',
        stage: 'submission',
        surface: 'website',
        metadata: {
          email: 'Guest@Example.Com',
          phone: '+1 (555) 234-5678',
        },
      },
    }, async () => ({ accessToken: 'test-meta-token', accessTokenExpiresAt: undefined }))

    assert.equal(result.status, 'sent')
    assert.equal(result.pixelId, '987654321')
    assert.match(dispatchedUrl ?? '', /\/987654321\/events$/)
    assert.equal(dispatchedAuthHeader, 'Bearer test-meta-token')
    assert.ok(dispatchedPayload)

    const event = (dispatchedPayload as { data: Array<Record<string, unknown>> }).data[0]!
    assert.equal(event.event_name, 'Schedule')
    assert.equal(event.event_id, '22222222-2222-4222-8222-222222222222')
    assert.equal(event.action_source, 'website')
    assert.equal(event.event_source_url, 'https://example.com/reservation')

    const userData = event.user_data as Record<string, unknown>
    assert.equal(userData.client_ip_address, '203.0.113.195')
    assert.equal(userData.client_user_agent, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    assert.equal(userData.fbp, 'fb.1.1558571054389.1098115397')
    assert.equal(userData.fbc, 'fb.1.1554763741205.AbCdEfGhIjKlMnOpQrStUvWxYz')

    // Verify SHA-256 hash of normalized 'guest@example.com'
    assert.ok(Array.isArray(userData.em))
    assert.equal((userData.em as string[])[0], '513935c4d2db2d2d984dff1d68397f6e2ac8c4e5c48c92bd98e02bdc90b7aefe')

    // Verify phone was normalized to digits only before hashing ('15552345678')
    assert.ok(Array.isArray(userData.ph))
    assert.equal((userData.ph as string[])[0], 'abc401b817ceaf586487ca22baf3191843248bf7ed8f622c33fb487a24a6fef9')

    // Verify update was persisted to database
    assert.equal(recordedUpdates.length, 1)
    const storedDelivery = JSON.parse(String(recordedUpdates[0]!.args[0]))
    assert.equal(storedDelivery.status, 'sent')
    assert.equal(storedDelivery.pixelId, '987654321')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('deliverMetaCapiForEvent records failed outcome when Graph API returns error', async () => {
  const originalFetch = globalThis.fetch
  const recordedUpdates: Array<{ query: string; args: unknown[] }> = []

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ error: { message: 'Invalid OAuth 2.0 Access Token' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const integrationRow = {
    organization_id: 'org-test',
    provider: 'meta_ads',
    account_id: 'acc-1',
    target_id: 'act_101',
    measurement_id: '987654321',
  }

  const db = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => integrationRow,
        all: async () => ({ results: [integrationRow] }),
        run: async () => {
          recordedUpdates.push({ query, args })
          return { success: true }
        },
        raw: async () => [integrationRow],
      }),
    }),
  } as never

  const env = { DB: db } as never

  try {
    const result = await deliverMetaCapiForEvent(env, db, {
      eventId: '33333333-3333-4333-8333-333333333333',
      organizationId: 'org-test',
      origin: null,
      input: {
        organizationId: 'org-test',
        eventName: 'lead_submit',
        stage: 'submission',
        surface: 'website',
      },
    }, async () => ({ accessToken: 'expired-token', accessTokenExpiresAt: undefined }))

    assert.equal(result.status, 'failed')
    assert.equal(recordedUpdates.length, 1)
    const storedDelivery = JSON.parse(String(recordedUpdates[0]!.args[0]))
    assert.equal(storedDelivery.status, 'failed')
    assert.match(storedDelivery.error, /Invalid OAuth/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('deliverMetaCapiForEvent discovers pixel when measurement_id is missing and caches it', async () => {
  const originalFetch = globalThis.fetch
  let adspixelsQueried = false
  let eventsDispatched = false
  const recordedUpdates: Array<{ query: string; args: unknown[] }> = []

  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/act_101/adspixels')) {
      adspixelsQueried = true
      return new Response(JSON.stringify({ data: [{ id: 'pixel_from_graph', name: 'Discovered Pixel' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/pixel_from_graph/events')) {
      eventsDispatched = true
      return new Response(JSON.stringify({ events_received: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch to ${url}`)
  }

  const integrationRow = {
    organization_id: 'org-test',
    provider: 'meta_ads',
    account_id: 'acc-1',
    target_id: 'act_101',
    target_name: 'Main Account',
    measurement_id: null,
  }

  const db = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => integrationRow,
        all: async () => ({ results: [integrationRow] }),
        run: async () => {
          recordedUpdates.push({ query, args })
          return { success: true }
        },
        raw: async () => [integrationRow],
      }),
    }),
  } as never

  const env = { DB: db } as never

  try {
    const result = await deliverMetaCapiForEvent(env, db, {
      eventId: '44444444-4444-4444-8444-444444444444',
      organizationId: 'org-test',
      origin: null,
      input: {
        organizationId: 'org-test',
        eventName: 'contact_submit',
        stage: 'submission',
        surface: 'website',
      },
    }, async () => ({ accessToken: 'valid-token', accessTokenExpiresAt: undefined }))

    assert.equal(result.status, 'sent')
    assert.equal(result.pixelId, 'pixel_from_graph')
    assert.equal(adspixelsQueried, true)
    assert.equal(eventsDispatched, true)

    // Check that pixel was cached to organization_integrations
    const cacheUpdate = recordedUpdates.find(u => u.query.includes('UPDATE organization_integrations SET measurement_id'))
    assert.ok(cacheUpdate)
    assert.equal(cacheUpdate.args[0], 'pixel_from_graph')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('deliverMetaCapiForEvent skips unmapped analytics events without dispatching or writing to database', async () => {
  const db = {
    prepare: () => ({
      bind: () => ({
        run: async () => {
          throw new Error('Should not write to DB for unmapped events')
        },
      }),
    }),
  } as never

  const result = await deliverMetaCapiForEvent({} as never, db, {
    eventId: '55555555-5555-4555-8555-555555555555',
    organizationId: 'org-test',
    origin: null,
    input: {
      organizationId: 'org-test',
      eventName: 'checkout_start',
      stage: 'submission',
      surface: 'website',
    },
  })

  assert.equal(result.status, 'skipped')
  assert.equal(result.detail, 'unmapped_event_type')
})
