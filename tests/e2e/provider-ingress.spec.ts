import { Buffer } from 'node:buffer'
import { createHmac, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { loginAs } from './helpers/auth'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { mcpData, mcpRequest } from './helpers/mcp'
import type { InboxRow, InboxStreamItem, InboxThread } from '../../server/domain/guest-threads/types'
import { seededTenant } from './seed/manifest'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { devLoginHeaders, seededSiteHeaders } from './test-env'

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

test('native email replies retain their RFC ancestry through repeated dashboard replies and reject changed addresses', async ({ request, baseURL }, testInfo) => {
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'native email injection requires disposable local data')
  test.slow()
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
  const organizationId = seededTenant('restaurant').organizationId
  // The restaurant's contact form is shared with specs that change its questions.
  const release = await acquireTenantMutationLock(testInfo, organizationId)
  try {
  const name = `E5 ${randomUUID().slice(0, 12)}`
  const guestEmail = 'guest@e2e.example.test'
  const submitted = await fetchPhase('create contact', '/api/public/contact', {
    method: 'POST',
    // The public routes resolve their tenant from the host, and this runs against
    // the platform's, so the tenant is named rather than inferred.
    headers: seededSiteHeaders('restaurant'),
    data: { name, email: guestEmail, message: 'Please confirm the continuity check.', subject: 'general' },
  })
  expect(submitted.status(), await submitted.text()).toBe(201)
  await test.step('authenticate owner and select organization', () => loginAs(request, baseURL!, 'user-e2e-demo-owner'), { timeout: 30_000 })
  // This asked for ?search=<name> and asserted the whole inbox held one thread.
  // The route never implemented search, so the filter was dropped and the
  // assertion held only while the tenant happened to contain exactly one thread.
  // The route refuses unknown parameters now, so asking for one is a 400.
  const rejected = await fetchPhase('reject unsupported filter', `/api/dashboard/organizations/${organizationId}/conversations`, { params: { search: name } })
  expect(rejected.status(), await rejected.text()).toBe(400)

  const listed = await fetchPhase('find contact thread', `/api/dashboard/organizations/${organizationId}/conversations`, {})
  expect(listed.status(), await listed.text()).toBe(200)
  const { threads } = await listed.json() as { threads: InboxRow[] }
  const own = threads.filter(thread => thread.guestName === name)
  expect(own, `no guest thread named ${name} in the restaurant's ${threads.length} threads`).toHaveLength(1)
  const detailUrl = `/api/dashboard/organizations/${organizationId}/guest-threads/${own[0]!.id}`
  const initialResponse = await fetchPhase('read initial entries', detailUrl, {})
  expect(initialResponse.status(), await initialResponse.text()).toBe(200)
  const { thread: initial } = await initialResponse.json() as { thread: InboxThread }
  // Day headers are the reader's calendar, not conversation items.
  const items = (thread: InboxThread) => thread.stream.filter((item): item is Exclude<InboxStreamItem, { type: 'day' }> => item.type !== 'day')
  // The ledger behind the view: each entry's channel and payload, which MCP reads out.
  const ledger = async () => {
    const response = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_conversation', args: { organization_id: organizationId, conversation_id: own[0]!.id } })
    expect(response.status(), await response.text()).toBe(200)
    return mcpData<{ guest: { messages: Array<{ id: string; author: string; channel: string | null; body: string | null; payload: Record<string, unknown> | null }> } }>(await response.json()).guest.messages
  }
  type EmailReceipt = {
    id: string; conversation_id: string; message_id: string; purpose: string; status: string;
    email_json: string | null; email_message_id: string | null; provider_message_id: string | null;
  }
  type FrozenEmail = {
    sender: string | null;
    message: {
      to: string; subject: string; html: string; text: string; emailPurpose: string;
      replyTo?: string; inReplyTo?: string; references?: string[];
    };
  }
  const readDeliveries = async (phase: string) => {
    const response = await fetchPhase(phase, '/api/dev/notifications', {
      headers: devLoginHeaders(), params: { organization_id: organizationId, limit: 500 },
    })
    expect(response.status(), await response.text()).toBe(200)
    const { deliveries } = await response.json() as { deliveries: EmailReceipt[] }
    return deliveries.filter(delivery => delivery.conversation_id === initial.id)
  }
  const acknowledgements = (await readDeliveries('read initial email receipt')).filter(delivery => delivery.purpose === 'guest_acknowledgement')
  expect(acknowledgements).toHaveLength(1)
  const acknowledgement = acknowledgements[0]!
  expect(acknowledgement.status).toBe('sent')
  expect(acknowledgement.email_message_id).toBeNull()
  expect(acknowledgement.email_json).toEqual(expect.any(String))
  const originalEmail = JSON.parse(acknowledgement.email_json!) as FrozenEmail
  expect(originalEmail.message.to).toBe(guestEmail)
  expect(originalEmail.message.subject).not.toMatch(/^Re:/i)
  expect(originalEmail.message.inReplyTo).toBeUndefined()
  expect(originalEmail.message.references).toBeUndefined()
  // Delivered through the local runtime's email event, so the Worker's own
  // email handler parses, verifies and records the reply, and its accept or
  // reject is what Email Routing would receive. The guest answers the address
  // the email actually carried.
  const guestReplyAddress = /^rg[0-9a-f]{56}@/
  const replyTo = originalEmail.message.replyTo
  expect(replyTo).toMatch(guestReplyAddress)
  const body = `Signed guest reply ${randomUUID()}`
  const subject = `Re: ${originalEmail.message.subject}`
  const emailDate = new Date().toUTCString()
  const deliver = (phase: string, to: string, messageId: string | null, parentId?: string) => fetchPhase(phase, '/cdn-cgi/local/email', {
    method: 'POST',
    params: { from: guestEmail, to },
    data: [
      `From: E2E Guest <${guestEmail}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      ...(messageId === null ? [] : [`Message-ID: ${messageId}`]),
      ...(parentId ? [`In-Reply-To: ${parentId}`, `References: ${parentId}`] : []),
      `Date: ${emailDate}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
      '',
    ].join('\r\n'),
  })
  // Log-only confirmations have no actual outbound RFC ID. The first real
  // MIME message supplies its own; the next reply can legitimately reference it.
  const messageId = `<${randomUUID()}@e2e.example.test>`
  for (const phase of ['receive signed reply', 'receive duplicate reply']) {
    const received = await deliver(phase, replyTo!, messageId)
    expect(received.status()).toBe(200)
    expect(await received.text()).toBe('Worker successfully processed email')
  }
  const secondMessageId = `<${randomUUID()}@e2e.example.test>`
  const secondReply = await deliver('receive follow-up with RFC ancestry', replyTo!, secondMessageId, messageId)
  expect(secondReply.status(), await secondReply.text()).toBe(200)
  expect(await secondReply.text()).toBe('Worker successfully processed email')
  const malformed = await deliver('reject malformed RFC Message-ID', replyTo!, 'invalid-message-id')
  expect(malformed.status(), await malformed.text()).toBe(400)
  expect(await malformed.text()).toBe('Worker rejected email with the following reason: This email has an invalid Message-ID.')
  // Wrangler's native MIME parser rejects a missing Message-ID before the
  // Worker handler receives the message, so no conversation entry is recorded.
  const missingId = await deliver('reject email without a Message-ID', replyTo!, null)
  expect(missingId.status(), await missingId.text()).toBe(400)
  expect(await missingId.text()).toBe('Email could not be parsed: invalid or no message id provided')
  const [localPart, domain] = replyTo!.split('@')
  for (const { phase, address, reason } of [
    { phase: 'reject altered signature', address: `${localPart!.slice(0, -1)}${localPart!.endsWith('0') ? '1' : '0'}@${domain}`, reason: 'This reply address is not valid.' },
    { phase: 'reject wrong domain', address: `${localPart}@invalid.example`, reason: 'This address does not accept email.' },
  ]) {
    const rejected = await deliver(phase, address, `<${randomUUID()}@e2e.example.test>`)
    expect(rejected.status()).toBe(400)
    expect(await rejected.text()).toBe(`Worker rejected email with the following reason: ${reason}`)
  }
  const finalResponse = await fetchPhase('verify final entries', detailUrl, {})
  expect(finalResponse.status(), await finalResponse.text()).toBe(200)
  const { thread: final } = await finalResponse.json() as { thread: InboxThread }
  // The two accepted emails are two guest messages; the refused ones left nothing.
  expect(items(final)).toHaveLength(items(initial).length + 2)
  expect(items(final).slice(-2)).toMatchObject([
    { type: 'message', side: 'guest', author: name, body },
    { type: 'message', side: 'guest', author: name, body },
  ])
  // Normal inbox presentation hides transport metadata. The frozen staff
  // requests below prove the received RFC IDs still drive the actual replies.
  const received = (await ledger()).filter(entry => items(final).slice(-2).some(item => item.id === entry.id))
  expect(received).toEqual([
    expect.objectContaining({ author: 'guest', channel: 'email', body, payload: {} }),
    expect.objectContaining({ author: 'guest', channel: 'email', body, payload: {} }),
  ])

  const replyUrl = `${detailUrl}/operations/reply`
  const operationKey = `mime-staff-${randomUUID()}`
  const staffBody = `Dashboard staff reply ${randomUUID()}`
  const sendReply = (phase: string, idempotencyKey: string, replyBody: string) => fetchPhase(phase, replyUrl, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: { body: replyBody },
  })
  const staffResponse = await sendReply('send first staff reply', operationKey, staffBody)
  expect(staffResponse.status(), await staffResponse.text()).toBe(200)
  const staffReceipts = (await readDeliveries('read first staff email receipt')).filter(delivery => delivery.purpose === 'member_reply')
  expect(staffReceipts).toHaveLength(1)
  const firstStaffReceipt = staffReceipts[0]!
  expect(firstStaffReceipt.status).toBe('sent')
  expect(firstStaffReceipt.email_message_id).toBeNull()
  expect(firstStaffReceipt.email_json).toEqual(expect.any(String))
  const firstStaffEmail = JSON.parse(firstStaffReceipt.email_json!) as FrozenEmail
  expect(firstStaffEmail.message).toMatchObject({
    to: guestEmail, subject, emailPurpose: 'transactional',
    inReplyTo: secondMessageId, references: [messageId, secondMessageId],
  })
  expect(firstStaffEmail.message.replyTo).toMatch(guestReplyAddress)
  expect(firstStaffEmail.message.html).toContain(staffBody)
  expect(firstStaffEmail.message.text).toContain(staffBody)
  expect(firstStaffEmail.message.html).toContain('You received this email because')
  expect(firstStaffEmail.message.text.replace(/\s+/g, ' ')).toContain('You received this email because')
  expect(firstStaffEmail.message.html).not.toMatch(/unsubscribe|\/signup/i)

  const replay = await sendReply('replay the first staff operation', operationKey, staffBody)
  expect(replay.status(), await replay.text()).toBe(200)
  expect((await readDeliveries('verify replay sends no additional email')).filter(delivery => delivery.purpose === 'member_reply')).toEqual(staffReceipts)

  const nextStaffBody = `Another dashboard reply ${randomUUID()}`
  const nextStaff = await sendReply('send another staff reply', `mime-staff-${randomUUID()}`, nextStaffBody)
  expect(nextStaff.status(), await nextStaff.text()).toBe(200)
  const repeatedStaffReceipts = (await readDeliveries('read repeated staff email receipts')).filter(delivery => delivery.purpose === 'member_reply')
  expect(repeatedStaffReceipts).toHaveLength(2)
  const nextReceipt = repeatedStaffReceipts.find(delivery => delivery.id !== firstStaffReceipt.id)!
  expect(nextReceipt.status).toBe('sent')
  expect(nextReceipt.email_message_id).toBeNull()
  const nextEmail = JSON.parse(nextReceipt.email_json!) as FrozenEmail
  expect(nextEmail.message).toMatchObject({
    to: guestEmail, subject, emailPurpose: 'transactional',
    inReplyTo: secondMessageId, references: [messageId, secondMessageId],
  })
  expect(nextEmail.message.replyTo).toMatch(guestReplyAddress)
  // Each email's address names its own conversation entry.
  expect(new Set([replyTo, firstStaffEmail.message.replyTo, nextEmail.message.replyTo]).size).toBe(3)
  expect(nextEmail.message.html).toContain(nextStaffBody)
  const repliedResponse = await fetchPhase('verify repeated staff entries', detailUrl, {})
  expect(repliedResponse.status(), await repliedResponse.text()).toBe(200)
  const { thread: replied } = await repliedResponse.json() as { thread: InboxThread }
  expect(replied.stream.filter(item => item.type === 'message' && item.body === staffBody)).toMatchObject([{ side: 'business', author: 'You' }])
  expect(replied.stream.filter(item => item.type === 'message' && item.body === nextStaffBody)).toMatchObject([{ side: 'business', author: 'You' }])

  // The owner was alerted to each guest email, in one conversation: one subject,
  // and on each a signed reply-to naming that message, which answers the guest as that owner.
  const alerts = (await readDeliveries('read owner alerts')).filter(delivery => delivery.purpose === 'owner_alert' && delivery.email_json !== null)
    .map(delivery => JSON.parse(delivery.email_json!) as FrozenEmail).filter(email => email.message.replyTo?.startsWith('rm'))
  // The signed-in owner replies, so the inbox labels the reply "You"; every other member alerted is someone else.
  const ownerAddress = findE2eAuthFixture('user-e2e-demo-owner').email
  const ownerAlerts = alerts.filter(email => email.message.to === ownerAddress)
  expect(ownerAlerts.length).toBeGreaterThanOrEqual(2)
  expect(new Set(ownerAlerts.map(email => email.message.subject)).size).toBe(1)
  expect(new Set(ownerAlerts.map(email => email.message.replyTo)).size).toBe(ownerAlerts.length)
  expect(ownerAlerts.some(email => email.message.text.includes(body))).toBe(true)
  expect(ownerAlerts.every(email => email.message.text.includes('Reply to this email or from the dashboard.'))).toBe(true)
  const memberReplyTo = ownerAlerts[0]!.message.replyTo!
  const ownerBody = `Owner email reply ${randomUUID()}`
  const ownerReply = (phase: string, from: string, messageId: string, headers: string[] = []) => fetchPhase(phase, '/cdn-cgi/local/email', {
    method: 'POST',
    params: { from, to: memberReplyTo },
    data: [
      `From: Owner <${from}>`, `To: ${memberReplyTo}`, `Subject: Re: ${ownerAlerts[0]!.message.subject}`, `Message-ID: ${messageId}`, ...headers,
      `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
      ownerBody, '', `On ${new Date().toUTCString()} KrabiClaw <hello@krabiclaw.com> wrote:`, `> ${body}`, '',
    ].join('\r\n'),
  })
  const ownerMessageId = `<${randomUUID()}@e2e.example.test>`
  for (const phase of ['receive owner reply to the alert', 'receive the same owner reply again']) {
    const accepted = await ownerReply(phase, ownerAddress, ownerMessageId)
    expect(accepted.status(), await accepted.text()).toBe(200)
    expect(await accepted.text()).toBe('Worker successfully processed email')
  }
  // An out-of-office is accepted and reaches nobody; the count of emails to the guest below proves it.
  const outOfOffice = await ownerReply('drop an automatic reply', ownerAddress, `<${randomUUID()}@e2e.example.test>`, ['Auto-Submitted: auto-replied'])
  expect(outOfOffice.status(), await outOfOffice.text()).toBe(200)
  const strangerReply = await ownerReply('reject a reply from another sender', 'someone-else@e2e.example.test', `<${randomUUID()}@e2e.example.test>`)
  expect(strangerReply.status()).toBe(400)
  expect(await strangerReply.text()).toBe('Worker rejected email with the following reason: This reply address is not valid for the address you replied from. Reply from the address the alert was sent to, or answer from the dashboard.')
  // The guest is emailed the owner's words, once, without the quoted alert.
  const toGuest = (await readDeliveries('read the emailed owner reply')).filter(delivery => delivery.purpose === 'member_reply')
    .map(delivery => JSON.parse(delivery.email_json!) as FrozenEmail).filter(email => email.message.text.includes(ownerBody))
  expect(toGuest).toHaveLength(1)
  expect(toGuest[0]!.message.to).toBe(guestEmail)
  expect(toGuest[0]!.message.text).not.toContain('wrote:')
  const answeredResponse = await fetchPhase('verify the owner reply in the conversation', detailUrl, {})
  const { thread: answered } = await answeredResponse.json() as { thread: InboxThread }
  expect(answered.stream.filter(item => item.type === 'message' && item.body === ownerBody)).toMatchObject([{ side: 'business', author: 'You' }])
  } finally {
    await release()
  }
})
