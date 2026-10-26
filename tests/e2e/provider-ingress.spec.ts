import { Buffer } from 'node:buffer'
import { createHmac, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { buildReplyToAddress } from '../../server/utils/submission-messages'
import { loginAs } from './helpers/auth'
import { devLoginHeaders } from './test-env'

test('signed Stripe ingress accepts a signed event and rejects invalid signatures', async ({ request }) => {
  const eventId = `evt_e2e_${randomUUID().replaceAll('-', '')}`
  const payload = JSON.stringify({
    id: eventId, object: 'event', type: 'customer.created',
    created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: { id: `cus_e2e_${randomUUID()}`, object: 'customer' } },
  })
  const signatureResponse = await request.post('/api/dev/stripe-signature', {
    headers: devLoginHeaders(), data: { payload },
  })
  expect(signatureResponse.status(), await signatureResponse.text()).toBe(200)
  const { signature } = await signatureResponse.json()
  // Stripe's own delivery retries are the retry mechanism, so a redelivery is
  // simply accepted again; there is no application-owned webhook queue to read.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request.post('/api/auth/stripe/webhook', {
      headers: { 'content-type': 'application/json', 'stripe-signature': signature }, data: payload,
    })
    expect(response.status(), await response.text()).toBe(200)
  }
  const invalid = await request.post('/api/auth/stripe/webhook', {
    headers: { 'content-type': 'application/json', 'stripe-signature': `${signature}0` }, data: payload,
  })
  expect(invalid.status()).toBe(400)
})

test('signed Resend ingress verifies the raw body and ignores mail that is not a guest-thread delivery', async ({ request }) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) throw new Error('RESEND_WEBHOOK_SECRET is set by playwright.config.ts for the local Worker')
  // Signed the way Resend (Svix) signs: HMAC-SHA256 over id.timestamp.body
  // with the base64 key after `whsec_`. The Worker verifies with the SDK, so
  // this is an independent check that the two agree on the exact bytes.
  const sign = (id: string, timestamp: string, body: string) =>
    `v1,${createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')}`
  const post = (body: string, headers: Record<string, string>) =>
    request.post('/api/resend/webhook', { headers: { 'content-type': 'application/json', ...headers }, data: body })
  const signedHeaders = (body: string) => {
    const id = `msg_${randomUUID()}`
    const timestamp = String(Math.floor(Date.now() / 1000))
    return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': sign(id, timestamp, body) }
  }

  // Spacing a JSON serialiser would not reproduce: accepted only if the
  // signature is checked against the bytes as sent.
  const delivered = `{ "type":  "email.delivered",  "created_at": "${new Date().toISOString()}",
    "data": { "email_id": "e2e-${randomUUID()}", "created_at": "${new Date().toISOString()}", "from": "hello@krabiclaw.com",
    "to": ["guest@example.test"], "subject": "E2E", "message_id": "<e2e@krabiclaw.com>" } }`
  const deliveredHeaders = signedHeaders(delivered)
  const accepted = await post(delivered, deliveredHeaders)
  expect(accepted.status(), await accepted.text()).toBe(200)
  // No guest-thread delivery carries this id, as with every Broadcast recipient.
  expect(await accepted.json()).toEqual({ received: 'email.delivered', outcome: 'no_delivery' })

  const reserialised = await post(JSON.stringify(JSON.parse(delivered)), deliveredHeaders)
  expect(reserialised.status()).toBe(400)
  const tampered = await post(delivered, { ...deliveredHeaders, 'svix-signature': sign(deliveredHeaders['svix-id'], deliveredHeaders['svix-timestamp'], `${delivered} `) })
  expect(tampered.status()).toBe(400)
  const unsigned = await post(delivered, {})
  expect(unsigned.status()).toBe(400)

  const opened = JSON.stringify({ type: 'email.opened', created_at: new Date().toISOString(), data: { email_id: `e2e-${randomUUID()}`, created_at: new Date().toISOString(), from: 'hello@krabiclaw.com', to: ['guest@example.test'], subject: 'E2E', message_id: '<e2e@krabiclaw.com>' } })
  const irrelevant = await post(opened, signedHeaders(opened))
  expect(irrelevant.status(), await irrelevant.text()).toBe(200)
  expect(await irrelevant.json()).toEqual({ received: 'email.opened', outcome: 'ignored' })
})

test('compact signed email reply persists once and rejects a changed address', async ({ request, baseURL }) => {
  const fetchPhase = async (phase: string, path: string, options: Parameters<typeof request.fetch>[1]) => {
    const requestId = randomUUID()
    const startedAt = Date.now()
    const diagnostic = { phase, requestId, path }
    return test.step(phase, async () => {
      console.info('[e2e-provider-ingress]', JSON.stringify({ event: 'started', ...diagnostic, at: new Date(startedAt).toISOString() }))
      try {
        const response = await request.fetch(path, {
          ...options, timeout: 15_000, maxRetries: 0,
          headers: { ...options?.headers, 'x-request-id': requestId },
        })
        console.info('[e2e-provider-ingress]', JSON.stringify({
          event: 'finished', ...diagnostic, durationMs: Date.now() - startedAt,
          status: response.status(), rayId: response.headers()['cf-ray'] ?? null,
        }))
        return response
      } catch {
        console.error('[e2e-provider-ingress]', JSON.stringify({ event: 'transport_failed', ...diagnostic, durationMs: Date.now() - startedAt }))
        throw new Error(`Provider ingress request failed: ${phase}; requestId=${requestId}`)
      }
    })
  }
  const name = `E5 ${randomUUID().slice(0, 12)}`
  const submitted = await fetchPhase('create contact', '/api/public/contact', {
    method: 'POST',
    // The public routes resolve their tenant from the host, and this runs against
    // the platform's, so the tenant is named rather than inferred.
    headers: { 'x-preview-tenant': 'demo' },
    data: { name, email: 'paulchrisluke+provider-ingress@gmail.com', message: 'Please confirm the continuity check.', subject: 'general' },
  })
  expect(submitted.status(), await submitted.text()).toBe(201)
  await test.step('authenticate owner and select organization', () => loginAs(request, baseURL!, 'user-e2e-demo-owner'), { timeout: 30_000 })
  // This asked for ?search=<name> and asserted the whole inbox held one thread.
  // The route never implemented search, so the filter was dropped and the
  // assertion held only while org-demo happened to contain exactly one thread.
  // The route refuses unknown parameters now, so asking for one is a 400.
  const rejected = await fetchPhase('reject unsupported filter', '/api/dashboard/organizations/org-demo/guest-threads', { params: { search: name } })
  expect(rejected.status(), await rejected.text()).toBe(400)

  const listed = await fetchPhase('find contact thread', '/api/dashboard/organizations/org-demo/guest-threads', {})
  expect(listed.status(), await listed.text()).toBe(200)
  const { threads } = await listed.json() as { threads: Array<{ id: string; guestName: string }> }
  const own = threads.filter(thread => thread.guestName === name)
  expect(own, `no guest thread named ${name} in org-demo's ${threads.length} threads`).toHaveLength(1)
  const detailUrl = `/api/dashboard/organizations/org-demo/guest-threads/${own[0]!.id}`
  const initialResponse = await fetchPhase('read initial entries', detailUrl, {})
  expect(initialResponse.status(), await initialResponse.text()).toBe(200)
  const { thread: initial } = await initialResponse.json()
  // Delivered through the local runtime's email event, so the Worker's own
  // email handler parses, verifies and records the reply, and its accept or
  // reject is what Email Routing would receive.
  const replyTo = await buildReplyToAddress({
    EMAIL_REPLY_SECRET: process.env.EMAIL_REPLY_SECRET,
    NUXT_PUBLIC_PLATFORM_DOMAIN: baseURL,
  }, 'contact', initial.submissionId)
  expect(replyTo).toMatch(/^rc[0-9a-f]{56}@/)
  const body = `Signed guest reply ${randomUUID()}`
  const deliver = (phase: string, to: string, messageId: string) => fetchPhase(phase, '/cdn-cgi/local/email', {
    method: 'POST',
    params: { from: 'guest@e2e.example.test', to },
    data: [
      'From: E2E Guest <guest@e2e.example.test>',
      `To: ${to}`,
      'Subject: Re: continuity check',
      `Message-ID: <${messageId}@e2e.example.test>`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
      '',
    ].join('\r\n'),
  })
  const messageId = randomUUID()
  for (const phase of ['receive signed reply', 'receive duplicate reply']) {
    const received = await deliver(phase, replyTo!, messageId)
    expect(received.status()).toBe(200)
    expect(await received.text()).toBe('Worker successfully processed email')
  }
  const [localPart, domain] = replyTo!.split('@')
  for (const { phase, address, reason } of [
    { phase: 'reject altered signature', address: `${localPart!.slice(0, -1)}${localPart!.endsWith('0') ? '1' : '0'}@${domain}`, reason: 'This reply address is not valid.' },
    { phase: 'reject wrong domain', address: `${localPart}@invalid.example`, reason: 'This address does not accept email.' },
  ]) {
    const rejected = await deliver(phase, address, randomUUID())
    expect(rejected.status()).toBe(400)
    expect(await rejected.text()).toBe(`Worker rejected email with the following reason: ${reason}`)
  }
  const finalResponse = await fetchPhase('verify final entries', detailUrl, {})
  expect(finalResponse.status(), await finalResponse.text()).toBe(200)
  const { thread: final } = await finalResponse.json()
  expect(final.entries).toHaveLength(initial.entries.length + 1)
  expect(final.entries.at(-1)).toMatchObject({ body, channel: 'email', actorKind: 'guest' })
})
