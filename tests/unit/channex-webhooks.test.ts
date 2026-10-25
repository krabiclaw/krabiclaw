import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureChannexWebhook } from '../../server/integrations/channex/webhooks'

const env = { CHANNEX_BASE_URL: 'https://staging.channex.io/api/v1', CHANNEX_API_KEY: 'test-provider-key' }
const target = { origin: 'https://staging.krabiclaw.com', secret: 'webhook-secret', propertyId: 'property-1' }
const callback = 'https://staging.krabiclaw.com/api/integrations/channex/webhook'

// The property webhook Channex staging listed on 2026-10-24, made by hand: it subscribes events the handler
// ignores and leaves out inquiry. Its secret is replaced; the global webhook beside it goes to production.
function listed(): Array<Record<string, unknown>> {
  return [
    { id: 'global-1', type: 'webhook', attributes: { id: 'global-1', callback_url: 'https://krabiclaw.com/api/integrations/channex/webhook', event_mask: 'booking;ari;message;message_thread_booking_assigned;sync_error;sync_warning',
      headers: { 'x-channex-webhook-secret': 'production-secret' }, request_params: {}, is_active: true, send_data: true, is_global: true, protected: false, is_signed: false, signing_key_id: null },
    relationships: { organization: { data: { id: 'org', type: 'organization' } } } },
    { id: 'hook-1', type: 'webhook', attributes: { id: 'hook-1', callback_url: callback, event_mask: 'booking;ari;message;message_thread_booking_assigned;sync_error;sync_warning',
      headers: { 'x-channex-webhook-secret': 'webhook-secret' }, request_params: null, is_active: true, send_data: true, is_global: false, protected: false, is_signed: false, signing_key_id: null },
    relationships: { property: { data: { id: 'property-1', type: 'property' } }, organization: { data: { id: 'org', type: 'organization' } } } },
  ]
}

function fakeChannex(webhooks: Array<Record<string, unknown>>) {
  const writes: Array<{ method: string; path: string; body: { webhook: Record<string, unknown> } }> = []
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/api/v1', '')
    assert.equal(new Headers(init.headers).get('user-api-key'), 'test-provider-key')
    if ((init.method ?? 'GET') === 'GET' && path === '/webhooks') return Response.json({ data: webhooks, meta: { total: webhooks.length, page: 1, limit: 100 } })
    const body = JSON.parse(String(init.body)) as { webhook: Record<string, unknown> }
    writes.push({ method: init.method!, path, body })
    const { property_id: propertyId, ...attributes } = body.webhook
    const row = { id: path === '/webhooks' ? 'hook-new' : path.split('/').pop(), type: 'webhook', attributes,
      relationships: propertyId ? { property: { data: { id: propertyId, type: 'property' } } } : {} }
    if (init.method === 'POST') webhooks.push(row)
    else webhooks.splice(webhooks.findIndex(webhook => webhook.id === row.id), 1, row)
    return Response.json({ data: row }, { status: init.method === 'POST' ? 201 : 200 })
  }
  return { writes, fetch }
}

async function withFetch<T>(fake: { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = fake.fetch as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = real
  }
}

test('a hand-made webhook is reported, brought into line once, and then left alone', async () => {
  const channex = fakeChannex(listed())
  await withFetch(channex, async () => {
    assert.deepEqual(await ensureChannexWebhook(env, target, false), { action: 'would_update', id: 'hook-1',
      differences: ['event_mask is "booking;ari;message;message_thread_booking_assigned;sync_error;sync_warning", needs "booking;message;message_thread_booking_assigned;inquiry"'] })
    assert.deepEqual(channex.writes, [])
    assert.equal((await ensureChannexWebhook(env, target, true)).action, 'updated')
    assert.deepEqual(channex.writes, [{ method: 'PUT', path: '/webhooks/hook-1', body: { webhook: {
      callback_url: callback, event_mask: 'booking;message;message_thread_booking_assigned;inquiry', property_id: 'property-1', is_global: false,
      headers: { 'x-channex-webhook-secret': 'webhook-secret' }, request_params: {}, is_active: true, send_data: true,
    } } }])
    assert.deepEqual(await ensureChannexWebhook(env, target, true), { action: 'unchanged', id: 'hook-1', differences: [] })
    assert.equal(channex.writes.length, 1)
  })
})

test('a wrong secret is named without echoing it, and a missing global webhook is created', async () => {
  const channex = fakeChannex(listed())
  await withFetch(channex, async () => {
    const report = await ensureChannexWebhook(env, { ...target, secret: 'rotated-secret' }, false)
    assert.deepEqual(report.differences.slice(-1), ['x-channex-webhook-secret does not match CHANNEX_WEBHOOK_SECRET'])
    assert.doesNotMatch(JSON.stringify(report), /rotated-secret|webhook-secret"/)

    const global = { origin: 'https://staging.krabiclaw.com/', secret: 'webhook-secret', propertyId: null }
    assert.deepEqual(await ensureChannexWebhook(env, global, false), { action: 'would_create', id: null, differences: ['no webhook'] })
    assert.deepEqual(await ensureChannexWebhook(env, global, true), { action: 'created', id: 'hook-new', differences: ['no webhook'] })
    assert.partialDeepStrictEqual(channex.writes, [{ method: 'POST', path: '/webhooks', body: { webhook: { callback_url: callback, property_id: null, is_global: true } } }])
    assert.equal((await ensureChannexWebhook(env, global, false)).action, 'unchanged')
  })
})

test('two webhooks for one callback and scope are refused', async () => {
  const webhooks = listed()
  webhooks.push({ ...webhooks[1]!, id: 'hook-2' })
  await withFetch(fakeChannex(webhooks), async () => {
    await assert.rejects(ensureChannexWebhook(env, target, true), /2 webhooks for .* \(property-1\): hook-1, hook-2/)
  })
})
