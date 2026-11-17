import assert from 'node:assert/strict'
import test from 'node:test'
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

function invalidField(field: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ChannexMessageDataError)
    assert.equal(error.statusCode, 502)
    assert.equal(error.data.code, 'INVALID_PROVIDER_RESPONSE')
    assert.equal(error.data.field, field)
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

const pick = (parsed: { sender: string; text: string | null; attachments: string[] }) => ({ sender: parsed.sender, text: parsed.text, attachments: parsed.attachments })

test('attachment-only messages preserve absent text and resolve links against the configured API', () => {
  const parsed = parseChannexMessage({ ...message, attributes: {
    ...message.attributes, message: null,
    attachments: ['attachments/photo', 'https://media.example/photo.jpg'],
  } }, env)
  assert.equal(parsed.text, null)
  assert.deepEqual(parsed.attachments, ['https://staging.channex.io/api/v1/attachments/photo', 'https://media.example/photo.jpg'])
  // Channex message c2f68d4e (read 2026-11-05): a host action with neither words nor a file is a message, not an invalid one.
  assert.deepEqual(pick(parseChannexMessage({ ...message, attributes: { ...message.attributes, sender: 'property', message: null, attachments: [] } }, env)), { sender: 'property', text: null, attachments: [] })
  assert.throws(() => parseChannexMessage({ ...message, attributes: { ...message.attributes, message: undefined, attachments: ['attachments/photo'] } }, env), invalidField('message'))
  assert.throws(() => parseChannexMessage({ ...message, attributes: { ...message.attributes, attachments: null } }, env), invalidField('attachments'))
  for (const url of ['http://media.example/photo', 'https://user:password@media.example/photo']) {
    assert.throws(() => parseChannexMessage({ ...message, attributes: { ...message.attributes, attachments: [url] } }, env), invalidField('attachments[0]'))
  }
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
  await assert.rejects(sendChannexMessage(env, 'thread', 'Caption would silently discard the photo', photo), { providerStatus: 400 })
  assert.equal(paths.length, 2, 'invalid mixed content performs no provider writes')
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

