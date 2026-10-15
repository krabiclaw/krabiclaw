import { expect, test, type APIResponse } from '@playwright/test'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { blawbyTestExtraHeaders } from './test-env'
import type { Product } from '../../server/types/products'
import type { TodayFeedPayload } from '../../shared/dashboard-today'

const ORGANIZATION = 'org-ncls-blawby'
const SLUG = 'north-carolina-legal-services'
const DASHBOARD = `/dashboard/${SLUG}`
const EDITOR = `/api/editor/organizations/${ORGANIZATION}`
const ACTOR = 'user-e2e-ncls-consultation-owner'

async function body<T>(response: APIResponse, status: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return response.json() as Promise<T>
}

test('an assigned staff member can review a future online consultation from Today and find it in Upcoming', async ({ page, browser, request, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Provider hours and roles use disposable local data only')
  const release = await acquireTenantMutationLock(testInfo, ORGANIZATION)
  const memberContext = await browser.newContext()
  let product: Product | null = null
  let requestId: string | null = null
  let scheduleWritten = false
  let roleChanged = false
  const failures: unknown[] = []
  try {
  await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
  await loginAs(memberContext.request, baseURL!, ACTOR)
  const members = await body<{ members: Array<{ id: string; userId: string; role: string }> }>(
    await page.request.get('/api/dashboard/members', { params: { org: SLUG } }), 200)
  const actor = members.members.find(member => member.userId === ACTOR)
  expect(actor, 'The canonical actor fixture already belongs to NCLS').toBeTruthy()
  if (!actor) throw new Error('The assigned-staff actor fixture is missing')
  const schedulePath = `/api/organizations/${ORGANIZATION}/members/${actor.id}/scheduling`
  type Schedule = { timezone: string; weekly: Array<{ weekday: number; start: string; end: string }>; time_off: Array<{ start: string; end: string }>; updated_at: string }
  const previousSchedule = (await body<{ scheduling: Schedule | null }>(await page.request.get(schedulePath), 200)).scheduling
  const previousMode = await body<{ mode: string; external_url: string | null }>(await page.request.get(`${EDITOR}/consultation`), 200)
  const dayDate = new Date(Date.now() + 2 * 86_400_000)
  const day = dayDate.toISOString().slice(0, 10)
  const guestName = `Maya${Date.now()} Chen`
  const guestFirstName = guestName.split(' ')[0]!
  try {
    await body(await page.request.put(schedulePath, { data: { timezone: 'UTC', weekly: [{ weekday: dayDate.getUTCDay(), start: '14:00', end: '14:45' }], time_off: [], expected_updated_at: previousSchedule?.updated_at ?? null } }), 200)
    scheduleWritten = true
    product = (await body<{ product: Product }>(await page.request.post(`${EDITOR}/products`, { data: {
      kind: 'service', active: true, name: `Today assigned consultation ${Date.now()}`, description: 'A local appointment that verifies the assigned staff dashboard.',
      details: { preparation: 'Bring your consultation questions.', cancellation_policy: 'Contact us before the appointment to cancel.' },
      variants: [{ name: 'Online', prices: [{ unit_amount: 0, currency: 'USD' }] }],
    } }), 201)).product
    await body(await page.request.put(`${EDITOR}/products/${product.id}/booking`, { data: { duration_minutes: 45, default_capacity: 1,
      confirmation_mode: 'review', online_payment_required: false, scheduling_mode: 'provider', assigned_member_id: actor.id, held_online: true } }), 200)
    await body(await page.request.put(`${EDITOR}/products/${product.id}/publication`, { data: { published: true } }), 200)
    await body(await page.request.put(`${EDITOR}/consultation`, { data: { mode: 'native' } }), 200)
    const headers = blawbyTestExtraHeaders()
    const availability = await body<{ sessions: Array<{ id: string; starts_at: string; ends_at: string; timezone: string }> }>(
      await request.get(`/api/public/products/${product.slug}/sessions`, { headers, params: { location_id: 'online', from: day, to: day } }), 200)
    const session = availability.sessions.find(slot => slot.starts_at === `${day}T14:00:00.000Z`)
    expect(session, 'The saved provider hours expose an actual bookable future consultation').toBeTruthy()
    if (!session) throw new Error('The provider appointment is not bookable')
    const booked = await body<{ request_id: string; status: string }>(await request.post(`/api/public/products/${product.slug}/book`, { headers, data: {
      session_id: session.id, variant_id: product.variants[0]!.id, party_size: 1, guest_name: guestName,
      guest_email: `today-assigned-${Date.now()}@playwright.example`, idempotency_key: crypto.randomUUID(),
    } }), 201)
    requestId = booked.request_id
    expect(booked.status).toBe('pending')
    const bookingPath = `${DASHBOARD}/bookings/booking/${requestId}`
    const read = await body<{ booking: { status: string; assignedMemberId: string; locationTitle: string } }>(
      await page.request.get(`/api/dashboard/bookings/booking/${requestId}`, { params: { org: SLUG } }), 200)
    expect(read.booking).toMatchObject({ status: 'pending', assignedMemberId: actor.id, locationTitle: 'Online' })
    await body(await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId: ORGANIZATION, memberId: actor.id, role: 'member' },
    }), 200)
    roleChanged = true

    const today = await body<TodayFeedPayload>(await memberContext.request.get('/api/dashboard/today', { params: { org: SLUG } }), 200)
    expect(today.cards.find(card => card.id === `attention:${requestId}`)).toMatchObject({ priority: 'attention', to: bookingPath, assignedMemberId: actor.id, occurrenceAt: session.starts_at, bookingKind: 'booking' })
    expect(today.cards.every(card => card.assignedMemberId === actor.id && card.bookingKind === 'booking' && (card.priority === 'attention' || card.priority === 'schedule'))).toBe(true)
    const upcoming = await body<TodayFeedPayload>(await memberContext.request.get('/api/dashboard/today', { params: { org: SLUG, range: 'upcoming', from: day, to: day } }), 200)
    expect(upcoming.cards.find(card => card.id === `booking:${requestId}`)).toMatchObject({ priority: 'schedule', to: bookingPath, assignedMemberId: actor.id,
      headline: `Consultation with ${guestFirstName} in 2 days`, description: `${product.name} · Online`, occurrenceAt: session.starts_at, timeZone: 'UTC' })
    expect(upcoming.cards.every(card => card.assignedMemberId === actor.id && card.priority === 'schedule')).toBe(true)

    const memberPage = await memberContext.newPage()
    await dismissPreviewToolbar(memberPage)
    await memberPage.setViewportSize({ width: 390, height: 844 })
    expect((await memberPage.goto(new URL(`${DASHBOARD}?range=upcoming`, baseURL!).toString()))?.status()).toBe(200)
    await waitForNuxtHydration(memberPage)
    const appointment = memberPage.locator(`[data-card-id="booking:${requestId}"]`)
    await expect(appointment).toHaveAttribute('href', `${bookingPath}?range=upcoming`)
    await expect(appointment).toContainText(`Consultation with ${guestFirstName} in 2 days`)
    await expect(appointment.getByText(`${product.name} · Online`, { exact: true })).toBeVisible()
    await memberPage.screenshot({ path: testInfo.outputPath('assigned-upcoming-mobile.png'), fullPage: true })
    await memberPage.getByRole('tab', { name: 'Today', exact: true }).click()
    const attention = memberPage.locator(`[data-card-id="attention:${requestId}"]`)
    await expect(attention).toHaveAttribute('href', bookingPath)
    await attention.click()
    await expect(memberPage).toHaveURL(new URL(bookingPath, baseURL!).toString())
    const confirmed = memberPage.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/guest-threads/${requestId}/operations/confirm`))
    await memberPage.getByRole('button', { name: 'Confirm consultation', exact: true }).click()
    expect((await confirmed).status()).toBe(200)
    const persisted = await body<{ booking: { status: string; assignedMemberId: string } }>(
      await page.request.get(`/api/dashboard/bookings/booking/${requestId}`, { params: { org: SLUG } }), 200)
    expect(persisted.booking).toMatchObject({ status: 'confirmed', assignedMemberId: actor.id })
    const completed = await body<TodayFeedPayload>(await memberContext.request.get('/api/dashboard/today', { params: { org: SLUG } }), 200)
    expect(completed.cards.some(card => card.id === `attention:${requestId}`)).toBe(false)
  } finally {
    try {
      if (requestId) {
        await body(await page.request.post(`/api/dashboard/organizations/${ORGANIZATION}/guest-threads/${requestId}/operations/cancel`, { data: { idempotencyKey: crypto.randomUUID() } }), 200)
        const cancelled = await body<{ booking: { status: string } }>(await page.request.get(`/api/dashboard/bookings/booking/${requestId}`, { params: { org: SLUG } }), 200)
        expect(cancelled.booking.status).toBe('cancelled')
      }
      if (product) {
        await body(await page.request.put(`${EDITOR}/products/${product.id}/publication`, { data: { published: false } }), 200)
        if (requestId) {
          // Booked history is retained by the canonical Product lifecycle.
          await body(await page.request.put(`${EDITOR}/products/${product.id}/booking`, { data: { held_online: false, scheduling_mode: 'legacy', assigned_member_id: null } }), 200)
          await body(await page.request.patch(`${EDITOR}/products/${product.id}`, { data: { active: false } }), 200)
          const archived = await body<{ product: Product }>(await page.request.get(`${EDITOR}/products/${product.id}`), 200)
          expect(archived.product).toMatchObject({ active: false, booking: { held_online: false, assigned_member_id: null } })
          expect(archived.product.publications).toContainEqual({ organization_id: ORGANIZATION, published: false })
        } else await body(await page.request.delete(`${EDITOR}/products/${product.id}`), 200)
      }
    } catch (error) { failures.push(error) }
    try {
      await body(await page.request.put(`${EDITOR}/consultation`, { data: { mode: previousMode.mode, ...(previousMode.external_url ? { external_url: previousMode.external_url } : {}) } }), 200)
      const restored = await body<{ mode: string }>(await page.request.get(`${EDITOR}/consultation`), 200)
      expect(restored.mode).toBe(previousMode.mode)
    } catch (error) { failures.push(error) }
    try {
      if (scheduleWritten && previousSchedule) {
        const current = await body<{ scheduling: Schedule }>(await page.request.get(schedulePath), 200)
        await body(await page.request.put(schedulePath, { data: { timezone: previousSchedule.timezone, weekly: previousSchedule.weekly, time_off: previousSchedule.time_off, expected_updated_at: current.scheduling.updated_at } }), 200)
        const restored = await body<{ members: Array<{ id: string; scheduling: Schedule | null }> }>(await page.request.get(`/api/organizations/${ORGANIZATION}/members/scheduling`), 200)
        expect(restored.members.find(member => member.id === actor.id)?.scheduling).toMatchObject({ timezone: previousSchedule.timezone, weekly: previousSchedule.weekly, time_off: previousSchedule.time_off })
      } else if (scheduleWritten) {
        // An absent schedule is restored through Better Auth's existing removal
        // and invitation lifecycle, rather than direct authentication-row writes.
        const invitation = await body<{ token: string }>(await page.request.post(`/api/organizations/${ORGANIZATION}/invite-links`, { data: { role: 'member' } }), 201)
        await body(await page.request.post('/api/auth/organization/remove-member', { headers: authRequestHeaders(baseURL!), data: { organizationId: ORGANIZATION, memberIdOrEmail: actor.id } }), 200)
        const joined = await body<{ memberId: string }>(await memberContext.request.post(`/api/invite-links/${encodeURIComponent(invitation.token)}/accept`, { data: {} }), 200)
        await body(await page.request.post('/api/auth/organization/update-member-role', { headers: authRequestHeaders(baseURL!), data: { organizationId: ORGANIZATION, memberId: joined.memberId, role: actor.role } }), 200)
        roleChanged = false
        const restored = await body<{ scheduling: Schedule | null }>(await page.request.get(`/api/organizations/${ORGANIZATION}/members/${joined.memberId}/scheduling`), 200)
        expect(restored.scheduling).toBeNull()
      }
      if (roleChanged) await body(await page.request.post('/api/auth/organization/update-member-role', { headers: authRequestHeaders(baseURL!), data: { organizationId: ORGANIZATION, memberId: actor.id, role: actor.role } }), 200)
      const restoredMembers = await body<{ members: Array<{ userId: string; role: string }> }>(await page.request.get('/api/dashboard/members', { params: { org: SLUG } }), 200)
      expect(restoredMembers.members.find(member => member.userId === ACTOR)?.role).toBe(actor.role)
    } catch (error) { failures.push(error) }
  }
  } catch (error) {
    failures.unshift(error)
  } finally {
    await memberContext.close()
    await release()
  }
  if (failures.length) throw new AggregateError(failures, 'Assigned appointment workflow or cleanup did not complete')
})
