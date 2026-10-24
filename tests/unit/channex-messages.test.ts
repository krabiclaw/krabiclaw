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
  // An Airbnb agent's message, as a live Airbnb thread carries it (2026-10-23): read, not refused; any other sender is.
  assert.equal(parseChannexMessage({ ...message, attributes: { ...message.attributes, sender: 'agent', meta: { name: 'Airbnb', role: 'AGENT' } } }, env).sender, 'agent')
  assert.throws(() => parseChannexMessage({ ...message, attributes: { ...message.attributes, sender: 'robot' } }, env), invalidField('sender'))
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

test('photo replies upload base64 once and send only the singular attachment identity to the same inquiry thread', async (t) => {
  const photo = { filename: 'entry.jpeg', contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff]) }
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    paths.push(input)
    assert.equal(init.method, 'POST')
    const body = JSON.parse(String(init.body))
    if (input.endsWith('/attachments')) {
      assert.deepEqual(body, { attachment: { file: '/9j/', file_name: 'entry.jpeg', file_type: 'image/jpeg' } })
      // Unlike message resources, the documented upload response has no attributes.
      return Response.json({ data: { id: 'uploaded-photo', type: 'attachment' } })
    }
    assert.equal(input, 'https://staging.channex.io/api/v1/message_threads/thread/messages')
    assert.deepEqual(body, { message: { attachment_id: 'uploaded-photo' } })
    return Response.json({ data: { ...message, attributes: { ...message.attributes, sender: 'property', message: null, attachments: ['attachments/uploaded-photo'] } } })
  })
  const sent = await sendChannexMessage(env, 'thread', '', photo)
  assert.equal(sent.id, 'message')
  assert.equal(sent.text, null)
  assert.deepEqual(sent.attachments, ['https://staging.channex.io/api/v1/attachments/uploaded-photo'])
  assert.equal(paths.length, 2)
  await assert.rejects(sendChannexMessage(env, 'thread', 'Caption would silently discard the photo', photo), { providerStatus: 400, uncertain: false })
  assert.equal(paths.length, 2, 'invalid mixed content performs no provider writes')
})

test('an invalid attachment upload never sends a message, and a discarded accepted photo remains uncertain', async (t) => {
  const photo = { filename: 'photo.png', contentType: 'image/png', bytes: new Uint8Array([1]) }
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1
    return Response.json({ data: { id: 'uploaded', type: 'message' } })
  })
  await assert.rejects(sendChannexMessage(env, 'thread', '', photo), { providerStatus: 502, uncertain: false, writeRefused: true, data: { code: 'INVALID_PROVIDER_RESPONSE', field: 'photos', resource: 'attachment', uncertain: false, provider_status: 502 } })
  assert.equal(requests, 1)
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    requests += 1
    return input.endsWith('/attachments')
      ? Response.json({ data: { id: 'uploaded', type: 'attachment' } })
      : Response.json({ data: { ...message, attributes: { ...message.attributes, sender: 'property', message: 'Attachment was omitted', attachments: [] } } })
  })
  await assert.rejects(sendChannexMessage(env, 'thread', '', photo), invalidField('attachments', true))
  assert.equal(requests, 3)
})

test('Airbnb server failure behind Channex 422 is uncertain only when a guest message write was attempted', async (t) => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    requests.push(`${init.method} ${input}`)
    return Response.json({ errors: { error_code: 500, error_message: 'Airbnb could not complete the request' } }, { status: 422 })
  })
  await assert.rejects(getChannexThread(env, 'thread'), { providerStatus: 422, uncertain: false, writeRefused: false, data: { code: 'AIRBNB_UNAVAILABLE', field: 'provider_response', uncertain: false, provider_status: 422 } })
  await assert.rejects(sendChannexMessage(env, 'thread', 'Hello guest'), { providerStatus: 422, uncertain: true, writeRefused: false, data: { code: 'AIRBNB_UNAVAILABLE', field: 'provider_response', uncertain: true, provider_status: 422 } })
  await assert.rejects(sendChannexMessage(env, 'thread', '', { filename: 'photo.png', contentType: 'image/png', bytes: new Uint8Array([1]) }),
    { providerStatus: 422, uncertain: false, writeRefused: true, data: { code: 'AIRBNB_UNAVAILABLE', field: 'photos', resource: 'attachment', uncertain: false, provider_status: 422 } })
  assert.deepEqual(requests, ['GET https://staging.channex.io/api/v1/message_threads/thread', 'POST https://staging.channex.io/api/v1/message_threads/thread/messages', 'POST https://staging.channex.io/api/v1/attachments'])
  t.mock.restoreAll()

  for (const answer of ['unread', 'oversized', 'non-JSON', 'missing errors', 'invalid upstream code']) {
    t.mock.method(globalThis, 'fetch', async () => {
      if (answer === 'unread') return new Response(new ReadableStream({ start(controller) { controller.error(new Error('The response body was interrupted')) } }), { status: 422 })
      if (answer === 'oversized') return Response.json({ errors: { error_code: 500 } }, { status: 422, headers: { 'content-length': '10000001' } })
      if (answer === 'missing errors') return Response.json({}, { status: 422 })
      if (answer === 'invalid upstream code') return Response.json({ errors: { error_code: '500' } }, { status: 422 })
      return new Response('<html>Unclassified 422 response</html>', { status: 422 })
    })
    await assert.rejects(getChannexThread(env, 'thread'), { uncertain: false, writeRefused: false }, `${answer} read has no write outcome`)
    await assert.rejects(sendChannexMessage(env, 'thread', 'Hello guest'), { uncertain: true, writeRefused: false }, `${answer} 422 cannot establish that Airbnb refused the write`)
    await assert.rejects(sendChannexMessage(env, 'thread', '', { filename: 'photo.png', contentType: 'image/png', bytes: new Uint8Array([1]) }),
      { uncertain: false, writeRefused: true }, `${answer} attachment preparation did not call the guest-message endpoint`)
    t.mock.restoreAll()
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ errors: { code: 'not_supported', title: 'Message refused' } }, { status: 422 }))
  await assert.rejects(sendChannexMessage(env, 'thread', 'Hello guest'), { providerStatus: 422, uncertain: false, writeRefused: true }, 'a documented ordinary refusal remains a proven non-delivery')
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
