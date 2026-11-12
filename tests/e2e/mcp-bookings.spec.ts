import { expect, test } from '@playwright/test'
import { createHmac } from 'node:crypto'
import type { ProductBookingConfig } from '../../server/types/products'
import type { InboxThread } from '../../server/domain/guest-threads/types'
import { loginAs } from './helpers/auth'
import { mcpOrganizationId, mcpData, mcpRequest } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import { devLoginHeaders, seededSiteHeaders, paymentsProviderConfigured } from './test-env'

type Created = { success: boolean; booking_id: string; conversation_id: string; status: string; replayed: boolean; code?: string }

const missingProviderConfiguration = paymentsProviderConfigured ? [] : ['payments.configuration']

test('MCP Product booking uses public capacity, durable replay, guest identity and canonical inbox transitions', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Writes and log-only delivery require isolated local D1')
  const request = page.request
  const clayhouse = seededTenant('experience')
  const org = clayhouse.organizationId
  const wheelClass = clayhouse.products['wheel-class']!
  const release = await acquireTenantMutationLock(testInfo, org)
  try {
    await loginAs(request, baseURL!, 'user-e2e-pottery-owner')
    const product = wheelClass.id
    const editor = `${baseURL}/api/editor/organizations/${org}/products/${product}`
    const beforeConfiguration = await request.get(editor)
    expect(beforeConfiguration.status(), await beforeConfiguration.text()).toBe(200)
    const priorBooking = (await beforeConfiguration.json()).product.booking as ProductBookingConfig | null
    expect(priorBooking).toMatchObject({ duration_minutes: 120, default_capacity: 8, confirmation_mode: 'instant', online_payment_required: false })
    const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const response = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: name, args: { organization_id: org, ...args } })
      expect(response.status()).toBe(200)
      return mcpData<T>(await response.json())
    }
    const discovery = await mcpRequest(request, baseURL!, { method: 'tools/list' })
    expect(discovery.status()).toBe(200)
    const tools = (await discovery.json()).result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean } }>
    expect(tools.find(t => t.name === 'create_product_booking')!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true })
    expect(tools.find(t => t.name === 'cancel_product_booking')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    const context = await call<{ context: { organization_slug: string } }>('get_organization', {})
    const orgSlug = context.context.organization_slug
    expect(orgSlug).toBeTruthy()
    const read = (id: string) => call<{ guest: { email: string; phone: string | null }; provenance: { source: string; external_reference: string; guest_acknowledgement: boolean }; record: { id: string; status: string; party_size: number }; version: number; updated_at: string }>('get_product_booking', { booking_id: id })
    const configure = async (confirmation_mode: 'review' | 'instant', online_payment_required = false) => {
      const res = await request.put(`${editor}/booking`, { data: { duration_minutes: 120, default_capacity: 8, confirmation_mode, online_payment_required } })
      expect(res.status(), await res.text()).toBe(200)
    }
    const ids: string[] = []
    try {
      // Book and move a projected class a year ahead through the real MCP boundary.
      const from = new Date(Date.now() + 365 * 86_400_000).toISOString()
      const to = new Date(Date.now() + 393 * 86_400_000).toISOString()
      const listed = await call<{ sessions: Array<{ id: string; starts_at: string; remaining: number | null; is_full: boolean }> }>('list_product_booking_sessions', { product_id: product, from, to })
      const available = listed.sessions.filter(s => !s.is_full && (s.remaining === null || s.remaining >= 2))
      expect(available.length).toBeGreaterThanOrEqual(3)
      const reviewedPolicy = await call<{ config: { duration_minutes: number; default_capacity: number; confirmation_mode: string } }>('set_product_booking_config', { product_id: product, confirmation_mode: 'review' })
      expect(reviewedPolicy.config).toMatchObject({ duration_minutes: 120, default_capacity: 8, confirmation_mode: 'review' })
      const policyReadback = await request.get(editor)
      expect(policyReadback.status()).toBe(200)
      expect((await policyReadback.json()).product.booking).toMatchObject({ duration_minutes: 120, default_capacity: 8, confirmation_mode: 'review' })
      const since = new Date().toISOString()
      const key = crypto.randomUUID()
      const args = { product_slug: wheelClass.slug, product_session_id: available[0]!.id, party_size: 1, guest_name: 'MCP Guest', guest_email: 'pottery-owner@playwright.example', idempotency_key: key, source: 'operator', external_reference: `external-${key}`, guest_acknowledgement: false }
      const fakeConfirmation = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'create_product_booking', args: { organization_id: org, ...args, confirm: true } })
      expect(fakeConfirmation.status()).toBe(200)
      expect((await fakeConfirmation.json()).result.isError).toBe(true)
      const concurrent = await Promise.all([call<Created>('create_product_booking', args), call<Created>('create_product_booking', args)])
      expect(concurrent.every(row => row.success)).toBe(true)
      expect(new Set(concurrent.map(row => row.booking_id)).size).toBe(1)
      const created = concurrent[0]!
      ids.push(created.booking_id)
      expect(created.status).toBe('pending')
      const replay = await call<Created>('create_product_booking', args)
      expect(replay.replayed).toBe(true)
      expect(replay.booking_id).toBe(created.booking_id)
      const conflictResponse = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'create_product_booking', args: { organization_id: org, ...args, guest_name: 'Different Guest' } })
      expect(conflictResponse.status()).toBe(200)
      const conflictResult = (await conflictResponse.json()).result
      expect(conflictResult.isError).toBe(true)
      expect(conflictResult.structuredContent).toBeUndefined()
      const conflicting = JSON.parse(conflictResult.content[0].text) as Created
      expect(conflicting.success).toBe(false)
      expect(conflicting.code).toBe('idempotency_conflict')
      const afterClaim = await call<{ sessions: Array<{ id: string; remaining: number | null }> }>('list_product_booking_sessions', { product_id: product, from, to })
      expect(available[0]!.remaining).not.toBeNull()
      expect(afterClaim.sessions.find(s => s.id === available[0]!.id)!.remaining).toBe(available[0]!.remaining! - 1)
      const stored = await read(created.booking_id)
      expect(stored).not.toHaveProperty('guest_user_id')
      expect(stored.guest.email).toBe(args.guest_email)
      expect(stored.guest.phone).toBeNull()
      expect(stored.provenance).toMatchObject({ source: 'operator', external_reference: args.external_reference, guest_acknowledgement: false })
      let cursor: string | undefined
      let listedBooking: Record<string, unknown> | undefined
      do {
        const page = await call<{ bookings: Array<Record<string, unknown>>; page_info: { next_cursor: string | null } }>('list_product_bookings', { limit: 100, ...(cursor ? { cursor } : {}) })
        listedBooking = page.bookings.find(row => row.booking_id === created.booking_id)
        cursor = page.page_info.next_cursor ?? undefined
      } while (!listedBooking && cursor)
      expect(listedBooking).toMatchObject({ booking_id: created.booking_id, conversation_id: created.conversation_id, guest: { name: args.guest_name }, provenance: stored.provenance })
      expect(listedBooking!.guest).toEqual({ name: args.guest_name })
      expect(listedBooking).not.toHaveProperty('user_id')
      expect(listedBooking).not.toHaveProperty('guest_json')
      expect(listedBooking).not.toHaveProperty('provenance_json')

      const dashboard = await request.get(`${baseURL}/api/dashboard/bookings/${created.booking_id}?org=${encodeURIComponent(orgSlug)}`)
      expect(dashboard.status(), await dashboard.text()).toBe(200)
      expect((await dashboard.json()).booking).toMatchObject({ status: 'pending', conversation_id: created.conversation_id, booking_id: created.booking_id })
      await page.goto(`${baseURL}/dashboard/${encodeURIComponent(orgSlug)}/bookings/${created.booking_id}`)
      await expect(page.getByText('MCP Guest', { exact: true }).first()).toBeVisible()
      const notifications = await request.get(`${baseURL}/api/dev/notifications?organization_id=${org}&since=${encodeURIComponent(since)}`, { headers: devLoginHeaders() })
      expect(notifications.status()).toBe(200)
      const state = await notifications.json()
      const deliveries = state.deliveries.filter((row: { conversation_id: string }) => row.conversation_id === created.conversation_id)
      expect(deliveries.some((row: { purpose: string; status: string }) => row.purpose === 'owner_alert' && row.status === 'sent')).toBe(true)
      expect(deliveries.filter((row: { purpose: string }) => row.purpose === 'guest_acknowledgement')).toHaveLength(0)
      const proposals = { booking_id: created.booking_id, product_session_id: available[1]!.id, party_size: 2, version: stored.version, idempotency_key: crypto.randomUUID() }
      const proposed = await call<{ change_status: string }>('request_product_booking_change', proposals)
      expect(proposed.change_status).toBe('awaiting_guest_acceptance')
      await call('request_product_booking_change', proposals)
      expect((await read(created.booking_id)).record.party_size).toBe(1)
      const detailResponse = await request.get(`${baseURL}/api/dashboard/organizations/${org}/guest-threads/${created.conversation_id}`)
      expect(detailResponse.status()).toBe(200)
      const detail = (await detailResponse.json() as { thread: InboxThread }).thread
      // Two calls under one key are one proposal in the conversation, waiting for the guest.
      const changeEntries = detail.stream.filter(item => item.type === 'change')
      expect(changeEntries).toMatchObject([{ change: { requested_by: 'business', status: 'pending', after: { party_size: 2 } } }])
      const changeId = changeEntries[0]!.id
      const token = createHmac('sha256', 'local-playwright-email-reply-secret').update(`booking-change:v1:${created.conversation_id}:${changeId}`).digest('hex')
      const accepted = await request.post(`${baseURL}/api/public/booking-changes/${created.conversation_id}/${changeId}`, { headers: { authorization: `Bearer ${token}` }, data: { decision: 'accept' } })
      expect(accepted.status(), await accepted.text()).toBe(200)
      const changed = await read(created.booking_id)
      expect(changed.record).toMatchObject({ id: created.booking_id, status: 'pending', party_size: 2 })
      const acceptedThread = await request.get(`${baseURL}/api/dashboard/organizations/${org}/guest-threads/${created.conversation_id}`)
      expect(acceptedThread.status()).toBe(200)
      const acceptedThreadState = (await acceptedThread.json()).thread
      const acceptedNotifications = await request.get(`${baseURL}/api/dev/notifications?organization_id=${org}&since=${encodeURIComponent(since)}`, { headers: devLoginHeaders() })
      expect(acceptedNotifications.status()).toBe(200)
      const acceptedDeliveries = (await acceptedNotifications.json()).deliveries.filter((row: { conversation_id: string }) => row.conversation_id === created.conversation_id)
      expect((await call<{ change_status: string }>('request_product_booking_change', proposals)).change_status).toBe('accepted')
      expect(await read(created.booking_id)).toEqual(changed)
      const acceptedReplayThread = await request.get(`${baseURL}/api/dashboard/organizations/${org}/guest-threads/${created.conversation_id}`)
      expect(acceptedReplayThread.status()).toBe(200)
      expect((await acceptedReplayThread.json()).thread).toEqual(acceptedThreadState)
      const acceptedReplayNotifications = await request.get(`${baseURL}/api/dev/notifications?organization_id=${org}&since=${encodeURIComponent(since)}`, { headers: devLoginHeaders() })
      expect(acceptedReplayNotifications.status()).toBe(200)
      expect((await acceptedReplayNotifications.json()).deliveries.filter((row: { conversation_id: string }) => row.conversation_id === created.conversation_id)).toEqual(acceptedDeliveries)

      const declineProposal = { ...proposals, product_session_id: available[2]!.id, version: changed.version, idempotency_key: crypto.randomUUID() }
      expect((await call<{ change_status: string }>('request_product_booking_change', declineProposal)).change_status).toBe('awaiting_guest_acceptance')
      const declineDetail = await request.get(`${baseURL}/api/dashboard/organizations/${org}/guest-threads/${created.conversation_id}`)
      expect(declineDetail.status()).toBe(200)
      const declineEntries = (await declineDetail.json() as { thread: InboxThread }).thread.stream.filter(item => item.type === 'change' && item.id !== changeId)
      expect(declineEntries).toMatchObject([{ change: { status: 'pending' } }])
      const declineId = declineEntries[0]!.id
      const declineToken = createHmac('sha256', 'local-playwright-email-reply-secret').update(`booking-change:v1:${created.conversation_id}:${declineId}`).digest('hex')
      const declined = await request.post(`${baseURL}/api/public/booking-changes/${created.conversation_id}/${declineId}`, { headers: { authorization: `Bearer ${declineToken}` }, data: { decision: 'decline' } })
      expect(declined.status(), await declined.text()).toBe(200)
      const declinedThread = await request.get(`${baseURL}/api/dashboard/organizations/${org}/guest-threads/${created.conversation_id}`)
      expect(declinedThread.status()).toBe(200)
      const declinedThreadState = (await declinedThread.json()).thread
      const declinedRecord = await read(created.booking_id)
      expect(declinedRecord.record).toEqual(changed.record)
      const declinedNotifications = await request.get(`${baseURL}/api/dev/notifications?organization_id=${org}&since=${encodeURIComponent(since)}`, { headers: devLoginHeaders() })
      expect(declinedNotifications.status()).toBe(200)
      const declinedDeliveries = (await declinedNotifications.json()).deliveries.filter((row: { conversation_id: string }) => row.conversation_id === created.conversation_id)
      expect((await call<{ change_status: string }>('request_product_booking_change', declineProposal)).change_status).toBe('declined')
      expect(await read(created.booking_id)).toEqual(declinedRecord)
      const declinedReplayThread = await request.get(`${baseURL}/api/dashboard/organizations/${org}/guest-threads/${created.conversation_id}`)
      expect(declinedReplayThread.status()).toBe(200)
      expect((await declinedReplayThread.json()).thread).toEqual(declinedThreadState)
      const declinedReplayNotifications = await request.get(`${baseURL}/api/dev/notifications?organization_id=${org}&since=${encodeURIComponent(since)}`, { headers: devLoginHeaders() })
      expect(declinedReplayNotifications.status()).toBe(200)
      expect((await declinedReplayNotifications.json()).deliveries.filter((row: { conversation_id: string }) => row.conversation_id === created.conversation_id)).toEqual(declinedDeliveries)

      const confirmation = { booking_id: created.booking_id, version: (await read(created.booking_id)).version, idempotency_key: crypto.randomUUID() }
      expect((await call<{ ok: boolean }>('confirm_product_booking', confirmation)).ok).toBe(true)
      expect((await call<{ ok: boolean }>('confirm_product_booking', confirmation)).ok).toBe(true)
      expect((await read(created.booking_id)).record.status).toBe('confirmed')
      const cancellation = { booking_id: created.booking_id, version: (await read(created.booking_id)).version, idempotency_key: crypto.randomUUID() }
      expect((await call<{ ok: boolean }>('cancel_product_booking', cancellation)).ok).toBe(true)
      expect((await call<{ ok: boolean }>('cancel_product_booking', cancellation)).ok).toBe(true)
      expect((await read(created.booking_id)).record.status).toBe('cancelled')
      const acknowledgedArgs = { ...args, idempotency_key: crypto.randomUUID(), guest_acknowledgement: true }
      const pending = await call<Created>('create_product_booking', acknowledgedArgs)
      expect((await call<Created>('create_product_booking', acknowledgedArgs)).booking_id).toBe(pending.booking_id)
      const acknowledgedDeliveries = await request.get(`${baseURL}/api/dev/notifications?organization_id=${org}&since=${encodeURIComponent(since)}`, { headers: devLoginHeaders() })
      expect(acknowledgedDeliveries.status()).toBe(200)
      expect((await acknowledgedDeliveries.json()).deliveries.filter((row: { conversation_id: string; purpose: string; status: string }) => row.conversation_id === pending.conversation_id && row.purpose === 'guest_acknowledgement' && row.status === 'sent')).toHaveLength(1)
      ids.push(pending.booking_id)
      expect(pending.status).toBe('pending')
      const rejection = { booking_id: pending.booking_id, version: (await read(pending.booking_id)).version, idempotency_key: crypto.randomUUID() }
      expect((await call<{ ok: boolean }>('reject_product_booking', rejection)).ok).toBe(true)
      expect((await call<{ ok: boolean }>('reject_product_booking', rejection)).ok).toBe(true)
      expect((await read(pending.booking_id)).record.status).toBe('cancelled')
      const pendingCancel = await call<Created>('create_product_booking', { ...args, idempotency_key: crypto.randomUUID() })
      ids.push(pendingCancel.booking_id)
      expect(pendingCancel.status).toBe('pending')
      expect((await call<{ ok: boolean }>('cancel_product_booking', { booking_id: pendingCancel.booking_id, version: (await read(pendingCancel.booking_id)).version, idempotency_key: crypto.randomUUID() })).ok).toBe(true)
      expect((await read(pendingCancel.booking_id)).record.status).toBe('cancelled')
      const beforePaymentPolicy = await request.get(editor)
      expect(beforePaymentPolicy.status()).toBe(200)
      const payLaterPolicy = (await beforePaymentPolicy.json()).product.booking as ProductBookingConfig
      const billing = await request.get(`${baseURL}/api/billing/status?organization_id=${org}`)
      expect(billing.status(), await billing.text()).toBe(200)
      expect((await billing.json()).billing).toMatchObject({ plan: 'growth', status: 'active' })
      const usage = await request.get(`${baseURL}/api/dashboard/payments/billing?org=${encodeURIComponent(orgSlug)}`)
      expect(usage.status(), await usage.text()).toBe(200)
      expect((await usage.json()).configured).toBe(false)
      expect((await call<{ configured: boolean }>('get_payment_payouts', {})).configured).toBe(false)
      const paymentPolicy = await request.put(`${editor}/booking`, { data: { duration_minutes: 120, default_capacity: 8, confirmation_mode: 'instant', online_payment_required: true } })
      expect(paymentPolicy.status(), await paymentPolicy.text()).toBe(paymentsProviderConfigured ? 403 : 503)
      const paymentError = await paymentPolicy.json()
      expect(paymentError.message).toBe('Complete the business’s Payments setup before accepting online payments')
      expect(paymentError.data).toEqual({ code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(orgSlug)}/payments`, missing: ['payments.entitlement', ...missingProviderConfiguration, 'payments.account'] })
      const rejectedPolicyReadback = await request.get(editor)
      expect(rejectedPolicyReadback.status()).toBe(200)
      expect((await rejectedPolicyReadback.json()).product.booking).toEqual(payLaterPolicy)
      await configure('instant', false)
      const instant = await call<Created>('create_product_booking', { ...args, product_session_id: available[2]!.id, guest_acknowledgement: true, idempotency_key: crypto.randomUUID() })
      ids.push(instant.booking_id)
      expect(instant.success).toBe(true)
      expect(instant.status).toBe('confirmed')
      const publicResponse = await request.post(`${baseURL}/api/public/products/${wheelClass.slug}/book`, { headers: seededSiteHeaders('experience'), data: { guest_name: 'Public Guest', guest_email: args.guest_email, product_session_id: available[2]!.id, party_size: 1, idempotency_key: crypto.randomUUID() } })
      expect(publicResponse.status(), await publicResponse.text()).toBe(201)
      const publicCreated = await publicResponse.json() as Created
      ids.push(publicCreated.booking_id)
      expect(publicCreated).toMatchObject({ success: true, status: instant.status, conversation_id: expect.any(String), booking_id: expect.any(String) })
      expect(publicCreated).not.toHaveProperty('operational_booking_id')
      expect(await read(publicCreated.booking_id)).not.toHaveProperty('guest_user_id')
      const experienceBeforeRequest = await read(publicCreated.booking_id)
      await page.goto(`${baseURL}/dashboard/account/activity/booking/${publicCreated.conversation_id}`)
      await page.getByRole('button', { name: 'Manage booking', exact: true }).click()
      await page.getByRole('link', { name: 'Send a change request', exact: true }).click()
      await expect(page).toHaveURL(`${baseURL}/dashboard/account/messages/${publicCreated.conversation_id}?intent=booking-change`)
      await page.getByRole('textbox', { name: 'Write a message…', exact: true }).fill('Could we attend the following week instead?')
      await page.getByRole('button', { name: 'Send a change request', exact: true }).click()
      await expect(page.getByText('Your change request was sent to the business. Your booking is unchanged while it is reviewed.', { exact: true })).toBeVisible()
      expect((await read(publicCreated.booking_id)).record).toEqual(experienceBeforeRequest.record)
      const experienceThreadResponse = await request.get(`${baseURL}/api/dashboard/organizations/${org}/guest-threads/${publicCreated.conversation_id}`)
      expect(experienceThreadResponse.status(), await experienceThreadResponse.text()).toBe(200)
      const experienceThread = (await experienceThreadResponse.json() as { thread: InboxThread }).thread
      // The guest's request is one message from them that the business now has to answer.
      expect(experienceThread.stream.filter(item => item.type === 'message' && item.side === 'guest' && item.body === 'Could we attend the following week instead?')).toHaveLength(1)
      expect((await call<{ guest: { needs_reply: boolean } }>('get_conversation', { conversation_id: publicCreated.conversation_id })).guest.needs_reply).toBe(true)
      // The unanswered request is the owner's open reply task on Today.
      const replyTasks = (await call<{ sections: Array<{ id: string; tasks: Array<{ kind: string; status: string; conversation_id: string | null }> }> }>('list_tasks', { range: 'today', kind: 'guest_reply' }))
        .sections.flatMap(section => section.tasks).filter(task => task.conversation_id === publicCreated.conversation_id)
      expect(replyTasks).toEqual([expect.objectContaining({ kind: 'guest_reply', status: 'open', conversation_id: publicCreated.conversation_id })])
      const foreign = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_product_booking', args: { organization_id: seededTenant('restaurant').organizationId, booking_id: instant.booking_id } })
      expect(foreign.status()).toBe(200)
      expect((await foreign.json()).result.isError).toBe(true)
    } finally {
      for (const id of ids) {
        const booking = await read(id)
        if (booking.record.status !== 'cancelled') await call('cancel_product_booking', { booking_id: id, version: booking.version, idempotency_key: crypto.randomUUID() })
      }
      // The questions are restated unchanged, so the restore carries no revision to guard.
      const { questions_revision: _revision, ...priorWritable } = priorBooking!
      const restored = await request.put(`${editor}/booking`, { data: priorWritable })
      expect(restored.status(), await restored.text()).toBe(200)
      const restoredReadback = await request.get(editor)
      expect(restoredReadback.status()).toBe(200)
      expect((await restoredReadback.json()).product.booking).toEqual(priorBooking)
    }
  } finally {
    await release()
  }
})

test('MCP online collection returns the real Payments setup handoff without changing the offering or creating a payment', async ({ request, baseURL }, testInfo) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Write verification requires isolated local D1')
  const organizationId = mcpOrganizationId()
  const release = await acquireTenantMutationLock(testInfo, organizationId)
  let productId: string | null = null
  try {
    await loginAs(request, baseURL!, 'user-e2e-demo-owner')
    const call = async <T>(toolName: string, args: Record<string, unknown> = {}) => {
      const response = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName, args: { organization_id: organizationId, ...args } })
      expect(response.status(), await response.text()).toBe(200)
      return mcpData<T>(await response.json())
    }
    const context = await call<{ context: { organization_slug: string } }>('get_organization')
    const billing = await request.get(`${baseURL}/api/billing/status?organization_id=${organizationId}`)
    expect(billing.status(), await billing.text()).toBe(200)
    expect((await billing.json()).billing).toMatchObject({ plan: 'business', status: 'active' })
    const usage = await request.get(`${baseURL}/api/dashboard/payments/billing?org=${encodeURIComponent(context.context.organization_slug)}`)
    expect(usage.status(), await usage.text()).toBe(200)
    // Business's subscription carries the fee prices, read from Stripe; what is missing is the business's own Stripe account.
    expect(await usage.json()).toMatchObject({ configured: true, source: 'Stripe', pricing: { captured_volume_rate_percent: '1.4', ad_spend_rate_percent: '10', livemode: false } })
    expect((await call<{ configured: boolean }>('get_payment_payouts')).configured).toBe(false)
    const created = await call<{ product: { id: string } }>('create_product', {
      kind: 'service', name: `Paid appointment ${crypto.randomUUID()}`, idempotency_key: crypto.randomUUID(),
      variants: [{ name: 'Appointment', prices: [{ unit_amount: 10000, currency: 'USD' }] }],
    })
    productId = created.product.id
    const editor = `${baseURL}/api/editor/organizations/${organizationId}/products/${productId}`
    const beforeResponse = await request.get(editor)
    expect(beforeResponse.status()).toBe(200)
    const before = (await beforeResponse.json()).product
    const period = { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 8 * 86400000).toISOString() }
    const payments = await call('list_payments', period)
    const dashboardUrl = `${baseURL}/dashboard/${encodeURIComponent(context.context.organization_slug)}/payments`
    for (let retry = 0; retry < 2; retry++) {
      const response = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'set_product_booking_config',
        args: { organization_id: organizationId, product_id: productId, duration_minutes: 60, default_capacity: 2, online_payment_required: true },
      })
      expect(response.status(), await response.text()).toBe(200)
      const result = (await response.json()).result
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
      expect(JSON.parse(result.content[0].text)).toMatchObject({ status: paymentsProviderConfigured ? 409 : 503, success: false, operation_completed: false, action_required: true, code: 'financial_action_required', dashboard_url: dashboardUrl, missing: [...missingProviderConfiguration, 'payments.account'] })
      expect(result.content[0].text).toContain(dashboardUrl)
    }
    const stored = await request.get(editor)
    expect(stored.status()).toBe(200)
    expect((await stored.json()).product).toEqual(before)
    expect(await call('list_payments', period)).toEqual(payments)
    const sessionsResponse = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'list_product_booking_sessions',
      args: { organization_id: organizationId, product_id: productId, ...period },
    })
    expect(sessionsResponse.status(), await sessionsResponse.text()).toBe(200)
    const sessionsResult = (await sessionsResponse.json()).result
    expect(sessionsResult.isError).toBe(true)
    expect(sessionsResult.structuredContent).toBeUndefined()
    expect(JSON.parse(sessionsResult.content[0].text)).toEqual({ status: 404, message: 'This product does not take bookings' })
    const bookings = await call<{ bookings: Array<{ product_id: string }> }>('list_product_bookings', { product_id: productId })
    expect(bookings.bookings).toEqual([])
  } finally {
    try {
      if (productId) {
        const removed = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'delete_product', args: { organization_id: organizationId, product_id: productId } })
        expect(removed.status(), await removed.text()).toBe(200)
        expect(mcpData<{ deleted: boolean }>(await removed.json()).deleted).toBe(true)
      }
    } finally {
      await release()
    }
  }
})
