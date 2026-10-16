import assert from 'node:assert/strict'
import test from 'node:test'
import { ChannexError } from '../../server/integrations/channex/client'
import {
  ChannexMessageDataError,
  getChannexThread,
  installChannexMessages,
  listChannexMessages,
  listChannexThreads,
  parseChannexMessage,
  parseChannexThread,
  providerTimestamp,
  sendChannexMessage,
} from '../../server/integrations/channex/messages'

const env = { CHANNEX_BASE_URL: 'https://staging.channex.io/api/v1', CHANNEX_API_KEY: 'test-provider-key' }
const thread = {
  id: 'thread', type: 'message_thread',
  attributes: {
    title: 'Provider conversation label', provider: 'AirBNB', is_closed: false, message_count: 1,
    inserted_at: '2023-11-30T07:01:49.669975', updated_at: '2023-11-30T07:17:51.536183',
  },
  relationships: { property: { data: { id: 'property', type: 'property' } } },
}
const message = {
  id: 'message', type: 'message',
  attributes: {
    message: 'inquiry', attachments: [], sender: 'system',
    inserted_at: '2023-11-30T07:01:49.492378', updated_at: '2023-11-30T07:01:49.775842',
  },
  relationships: { message_thread: { data: { id: 'thread', type: 'message_thread' } } },
}
const installation = {
  id: 'installation', type: 'application_installation',
  attributes: { id: 'installation', property_id: 'property', application_code: 'channex_messages' },
}

function invalidField(field: string, uncertain = false) {
  return (error: unknown) => {
    assert.ok(error instanceof ChannexMessageDataError)
    assert.equal(error.statusCode, 502)
    assert.equal(error.data.code, 'INVALID_PROVIDER_RESPONSE')
    assert.equal(error.data.field, field)
    assert.equal(error.uncertain, uncertain)
    assert.equal(error.data.uncertain, uncertain)
    return true
  }
}

test('an inquiry keeps the provider title without inventing booking, channel or guest identity', () => {
  assert.deepEqual(parseChannexThread(thread), {
    id: 'thread', propertyId: 'property', channelId: null, bookingId: null,
    title: 'Provider conversation label', provider: 'AirBNB', isClosed: false, messageCount: 1,
    insertedAt: '2023-11-30T07:01:49.669975', updatedAt: '2023-11-30T07:17:51.536183',
  })
  assert.equal(parseChannexThread({ ...thread, attributes: { ...thread.attributes, provider: 'Airbnb' } }).provider, 'Airbnb')
  assert.equal(parseChannexThread({ ...thread, attributes: { ...thread.attributes, message_count: 0 } }).messageCount, 0)
  assert.throws(() => parseChannexThread({ ...thread, attributes: { ...thread.attributes, provider: 'airbnb' } }), invalidField('provider'))
  assert.throws(() => parseChannexThread({ ...thread, attributes: { ...thread.attributes, is_closed: undefined } }), invalidField('is_closed'))
  assert.throws(() => parseChannexThread({ ...thread, attributes: { ...thread.attributes, title: '  ' } }), invalidField('title'))
  assert.throws(() => parseChannexThread({ ...thread, relationships: { property: { data: { id: 'property', type: 'user' } } } }), invalidField('relationships.property'))
  assert.throws(() => parseChannexThread({ ...thread, relationships: { ...thread.relationships, booking: {} } }), invalidField('relationships.booking'))
})

test('provider timestamps retain microseconds and explicit offsets while refusing impossible dates', () => {
  for (const timestamp of ['2024-02-29T23:59:59.123456', '2024-02-29T23:59:59.123456Z', '2024-02-29T23:59:59.123456+07:00']) {
    assert.equal(providerTimestamp(timestamp, 'message', 'inserted_at'), timestamp)
  }
  for (const timestamp of ['2023-02-29T00:00:00', '2024-04-31T00:00:00Z', '2024-01-01T24:00:00Z', '2024-01-01T00:00:00+07:60', '2024-01-01', null]) {
    assert.throws(() => providerTimestamp(timestamp, 'message', 'inserted_at'), invalidField('inserted_at'))
  }
})

test('inquiry system metadata distinguishes absence, null and actual structured data', () => {
  const plain = parseChannexMessage(message, env)
  assert.equal(plain.sender, 'system')
  assert.equal(Object.hasOwn(plain, 'meta'), false)
  assert.equal(parseChannexMessage({ ...message, attributes: { ...message.attributes, meta: null } }, env).meta, null)
  const meta = { booking_details: { guest_name: 'Actual inquiry guest', checkin_date: '2023-12-02' } }
  assert.deepEqual(parseChannexMessage({ ...message, attributes: { ...message.attributes, meta } }, env).meta, meta)
  assert.throws(() => parseChannexMessage({ ...message, attributes: { ...message.attributes, meta: [] } }, env), invalidField('meta'))
})

test('attachment-only messages preserve absent text and resolve links against the configured API', () => {
  const parsed = parseChannexMessage({ ...message, attributes: {
    ...message.attributes, message: null,
    attachments: ['attachments/photo', 'https://media.example/photo.jpg'],
  } }, env)
  assert.equal(parsed.text, null)
  assert.deepEqual(parsed.attachments, ['https://staging.channex.io/api/v1/attachments/photo', 'https://media.example/photo.jpg'])
  assert.throws(() => parseChannexMessage({ ...message, attributes: { ...message.attributes, message: null } }, env), invalidField('message'))
  assert.throws(() => parseChannexMessage({ ...message, attributes: { ...message.attributes, message: undefined, attachments: ['attachments/photo'] } }, env), invalidField('message'))
  assert.throws(() => parseChannexMessage({ ...message, attributes: { ...message.attributes, attachments: null } }, env), invalidField('attachments'))
  for (const url of ['http://media.example/photo', 'https://user:password@media.example/photo']) {
    assert.throws(() => parseChannexMessage({ ...message, attributes: { ...message.attributes, attachments: [url] } }, env), invalidField('attachments[0]'))
  }
})

test('provider collections accept a valid empty inbox and explicitly scope and order every page', async (t) => {
  const requests: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    requests.push(url)
    if (url.pathname.endsWith('/message_threads/thread/messages')) return Response.json({ data: [], meta: { total: 0 } })
    const page = url.searchParams.get('pagination[page]')
    const id = page === '1' ? 'thread' : 'thread-2'
    return Response.json({ data: [{ ...thread, id }], meta: { total: 2 } })
  })
  assert.deepEqual((await listChannexThreads(env, 'property')).map(row => row.id), ['thread', 'thread-2'])
  assert.deepEqual(await listChannexMessages(env, 'thread'), [])
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.slice(0, 2).map(url => url.searchParams.get('pagination[page]')), ['1', '2'])
  assert.ok(requests.slice(0, 2).every(url => url.searchParams.get('filter[property_id]') === 'property'))
  assert.ok(requests.every(url => url.searchParams.get('order[inserted_at]') === 'asc'))
})

test('thread reads cannot silently accept another resource or tenant', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: thread }))
  await assert.rejects(getChannexThread(env, 'another-thread'), invalidField('id'))
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [thread], meta: { total: 1 } }))
  await assert.rejects(listChannexThreads(env, 'another-property'), invalidField('relationships.property'))
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [message], meta: { total: 1 } }))
  await assert.rejects(listChannexMessages(env, 'another-thread'), invalidField('relationships.message_thread'))
})

test('a malformed accepted reply is uncertain and does not trigger a second provider send', async (t) => {
  let sends = 0
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    sends += 1
    assert.equal(input, 'https://staging.channex.io/api/v1/message_threads/thread/messages')
    assert.equal(init.method, 'POST')
    assert.deepEqual(JSON.parse(String(init.body)), { message: { message: 'Hello guest' } })
    return Response.json({ data: { ...message, attributes: { ...message.attributes, message: 'Hello guest', sender: 'guest' } } })
  })
  await assert.rejects(sendChannexMessage(env, 'thread', 'Hello guest'), invalidField('sender', true))
  assert.equal(sends, 1)
})

test('an already installed Messages application requires no is_active field and performs no write', async (t) => {
  const methods: string[] = []
  t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
    methods.push(String(init.method))
    return Response.json({ data: [installation] })
  })
  assert.deepEqual(await installChannexMessages(env, 'property'), { id: 'installation', propertyId: 'property', applicationCode: 'channex_messages' })
  assert.deepEqual(methods, ['GET'])
})

test('installation validates the accepted resource and confirms its ID through an independent list read', async (t) => {
  const methods: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    methods.push(String(init.method))
    if (init.method === 'POST') {
      assert.equal(input, 'https://staging.channex.io/api/v1/applications/install')
      assert.deepEqual(JSON.parse(String(init.body)), { application_installation: { property_id: 'property', application_code: 'channex_messages' } })
      return Response.json({ data: installation })
    }
    return Response.json({ data: methods.length === 1 ? [] : [installation] })
  })
  assert.deepEqual(await installChannexMessages(env, 'property'), { id: 'installation', propertyId: 'property', applicationCode: 'channex_messages' })
  assert.deepEqual(methods, ['GET', 'POST', 'GET'])
})

test('installation that cannot be confirmed remains uncertain', async (t) => {
  const methods: string[] = []
  t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
    methods.push(String(init.method))
    return Response.json({ data: init.method === 'POST' ? installation : [] })
  })
  await assert.rejects(installChannexMessages(env, 'property'), invalidField('id', true))
  assert.deepEqual(methods, ['GET', 'POST', 'GET'])
})

test('a failed read after accepted installation cannot classify the write as refused', async (t) => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
    requests += 1
    if (requests === 3) return new Response('Read unavailable', { status: 503 })
    return Response.json({ data: init.method === 'POST' ? installation : [] })
  })
  await assert.rejects(installChannexMessages(env, 'property'), (error: unknown) => {
    assert.ok(error instanceof ChannexError)
    assert.equal(error.status, 502)
    assert.equal(error.uncertain, true)
    return true
  })
  assert.equal(requests, 3)
})
