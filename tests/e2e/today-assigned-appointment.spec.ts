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
  type Schedule = { timezone: string; weekly: Array<{ weekday: number; start: string; end: string }>; time_off: Array<{ start: string; end: string }>; public_name: string | null; public_photo_url: string | null; public_bio: string | null; public_approved: number; updated_at: string }
  const previousSchedule = (await body<{ scheduling: Schedule | null }>(await page.request.get(schedulePath), 200)).scheduling
  const previousMode = await body<{ mode: string; external_url: string | null }>(await page.request.get(`${EDITOR}/consultation`), 200)
  const dayDate = new Date(Date.now() + 2 * 86_400_000)
  const day = dayDate.toISOString().slice(0, 10)
  const guestName = `Maya${Date.now()} Chen`
  const guestFirstName = guestName.split(' ')[0]!
  try {
    // The consultation's host is this attorney, and publishing it needs their published profile.
    await body(await page.request.put(schedulePath, { data: { timezone: 'UTC', weekly: [{ weekday: dayDate.getUTCDay(), start: '14:00', end: '14:45' }], time_off: [], expected_updated_at: previousSchedule?.updated_at ?? null, public_name: 'Assigned attorney', public_approved: true } }), 200)
    scheduleWritten = true
    product = (await body<{ product: Product }>(await page.request.post(`${EDITOR}/products`, { data: {
      kind: 'service', active: true, name: `Today assigned consultation ${Date.now()}`, description: 'A local appointment that verifies the assigned staff dashboard.',
      details: { preparation: 'Bring your consultation questions.', cancellation_policy: 'Contact us before the appointment to cancel.' },
      variants: [{ name: 'Online', prices: [{ unit_amount: 0, currency: 'USD' }] }],
    } }), 201)).product
    expect(product.image, 'The authored consultation has no Product photo').toBeNull()
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
    await memberPage.setViewportSize({ width: 1440, height: 900 })
    const productPath = `${DASHBOARD}/products/${product.id}`
    expect((await memberPage.goto(new URL(`${productPath}/description`, baseURL!).toString()))?.status()).toBe(200)
    await waitForNuxtHydration(memberPage)
    const legalCards = memberPage.getByTestId('legal-editor-cards')
    await expect(legalCards).toBeVisible()
    await expect(legalCards.getByTestId('editor-card-name')).toContainText(product.name)
    await expect(memberPage.getByRole('link', { name: 'View', exact: true })).toHaveCount(0)
    await expect(memberPage.getByRole('link', { name: 'Translations', exact: true })).toHaveCount(0)
    await expect(legalCards.getByTestId('editor-card-page')).not.toHaveAttribute('href')
    const description = `${product.description} Bring your questions about this legal consultation.`
    const descriptionLeaf = memberPage.locator('#dashboard-panel-product-description')
    await descriptionLeaf.getByRole('textbox', { name: 'Short description', exact: true }).fill(description)
    const savedDescription = memberPage.waitForResponse(response => new URL(response.url()).pathname === `${EDITOR}/products/${product!.id}` && response.request().method() === 'PATCH')
    await descriptionLeaf.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await savedDescription).status()).toBe(200)
    const descriptionReadback = await body<{ product: Product }>(await page.request.get(`${EDITOR}/products/${product.id}`), 200)
    expect(descriptionReadback.product).toMatchObject({ id: product.id, name: product.name, description, booking: { assigned_member_id: actor.id, held_online: true } })
    expect(descriptionReadback.product.image, 'The independently read Product still has no authored photo').toBeNull()
    await expect(legalCards.getByTestId('editor-card-description')).toContainText(description)
    const forbiddenPreview = await memberContext.request.get(new URL(`${EDITOR}/context`, baseURL!).toString())
    expect(forbiddenPreview.status(), await forbiddenPreview.text()).toBe(404)
    expect(await forbiddenPreview.json()).not.toHaveProperty('context.previewToken')
    expect(product.page, 'the assigned Product has a real bound Page').toBeTruthy()
    const ownerPage = await body<{ page: { product_id: string } }>(await page.request.get(`${EDITOR}/pages/${product.page!.id}`), 200)
    expect(ownerPage.page.product_id).toBe(product.id)
    const forbiddenPage = await memberContext.request.get(new URL(`${EDITOR}/pages/${product.page!.id}`, baseURL!).toString())
    expect(forbiddenPage.status(), await forbiddenPage.text()).toBe(404)
    // Dashboard documents serve the client-only shell; the real boundary is
    // the protected API and the hydrated screen, rather than that shell's 200.
    expect((await memberPage.goto(new URL(`${productPath}/page`, baseURL!).toString()))?.status()).toBe(200)
    await expect(memberPage.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
    await expect(memberPage.getByRole('link', { name: 'Edit page content', exact: true })).toHaveCount(0)
    expect((await memberPage.goto(new URL(`${productPath}/description?editMode=preview&previewViewport=desktop`, baseURL!).toString()))?.status()).toBe(200)
    await expect(memberPage.getByRole('dialog', { name: 'Legal Services preview', exact: true }).getByText('Your role does not have access to website previews.', { exact: true })).toBeVisible()
    await expect(memberPage.getByTestId('content-preview-frame')).toHaveCount(0)
    await memberPage.setViewportSize({ width: 390, height: 844 })
    expect((await memberPage.goto(new URL(`${DASHBOARD}?range=upcoming`, baseURL!).toString()))?.status()).toBe(200)
    await waitForNuxtHydration(memberPage)
    const appointment = memberPage.locator(`[data-card-id="booking:${requestId}"]`)
    await expect(appointment).toHaveAttribute('href', `${bookingPath}?range=upcoming`)
    await expect(appointment).toContainText(`Consultation with ${guestFirstName} in 2 days`)
    await expect(appointment.getByText(`${product.name} · Online`, { exact: true })).toBeVisible()
    await memberPage.getByRole('tab', { name: 'Today', exact: true }).click()
    const attention = memberPage.locator(`[data-card-id="attention:${requestId}"]`)
    await expect(attention).toHaveAttribute('href', bookingPath)
    await attention.click()
    await expect(memberPage).toHaveURL(new URL(bookingPath, baseURL!).toString())
    const detail = memberPage.locator('#dashboard-panel-booking-details')
    const todayPanel = memberPage.locator('#dashboard-panel-org-today')
    await expect(detail.getByRole('heading', { name: 'Awaiting review', exact: true })).toBeVisible()
    const identity = detail.getByRole('heading', { name: guestFirstName, level: 2, exact: true })
    await expect(identity).toBeVisible()
    await expect(identity.locator('..').locator(':scope > div > [data-slot="root"]')).toHaveText(guestFirstName.slice(0, 1))
    await expect(detail.getByRole('heading', { name: 'Clients', exact: true })).toBeVisible()
    await expect(todayPanel).toBeHidden()
    await memberPage.setViewportSize({ width: 1440, height: 900 })
    await expect(todayPanel).toBeVisible()
    await expect(attention).toBeVisible()
    await expect(detail).toBeVisible()
    const todayBounds = await todayPanel.boundingBox()
    const detailBounds = await detail.boundingBox()
    expect(todayBounds).not.toBeNull()
    expect(detailBounds).not.toBeNull()
    expect(todayBounds!.x + todayBounds!.width).toBeLessThanOrEqual(detailBounds!.x + 1)
    await expect(identity).toBeVisible()
    await memberPage.setViewportSize({ width: 390, height: 844 })
    await expect(todayPanel).toBeHidden()
    await expect(detail).toBeVisible()
    await detail.getByRole('link').filter({ hasText: 'Attorney or legal team' }).click()
    const assignment = memberPage.locator('#dashboard-panel-booking-team-member')
    await expect(assignment.getByRole('heading', { name: 'Attorney or legal team', exact: true })).toBeVisible()
    await expect(assignment).toContainText('Your client and both attorneys are told.')
    await expect(assignment.getByRole('radio', { checked: true })).toHaveAccessibleName('Assigned attorney')
    await assignment.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(memberPage).toHaveURL(new URL(bookingPath, baseURL!).toString())
    await detail.getByRole('button', { name: 'Manage consultation', exact: true }).click()
    await memberPage.getByRole('dialog', { name: 'Manage consultation', exact: true }).getByRole('link', { name: 'Change consultation', exact: true }).click()
    const change = memberPage.locator('#dashboard-panel-booking-change')
    await expect(change.getByRole('link', { name: 'Change clients', exact: true })).toContainText('1 client')
    await change.getByRole('link', { name: 'Change clients', exact: true }).click()
    const clients = memberPage.locator('#dashboard-panel-booking-change-field')
    await expect(clients.getByRole('heading', { name: 'Change clients', exact: true })).toBeVisible()
    await expect(clients).toContainText('Your client sees every change at once when you send the request.')
    await expect(clients.getByRole('spinbutton', { name: 'Clients', exact: true })).toHaveValue('1')
    await clients.getByRole('button', { name: 'Cancel', exact: true }).click()
    await change.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(memberPage).toHaveURL(new URL(bookingPath, baseURL!).toString())
    const confirmed = memberPage.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/guest-threads/${requestId}/operations/confirm`))
    await detail.getByRole('button', { name: 'Manage consultation', exact: true }).click()
    await memberPage.getByRole('dialog', { name: 'Manage consultation', exact: true }).getByRole('button', { name: 'Confirm consultation', exact: true }).click()
    expect((await confirmed).status()).toBe(200)
    const persisted = await body<{ booking: { status: string; assignedMemberId: string } }>(
      await page.request.get(`/api/dashboard/bookings/booking/${requestId}`, { params: { org: SLUG } }), 200)
    expect(persisted.booking).toMatchObject({ status: 'confirmed', assignedMemberId: actor.id })
    const completed = await body<TodayFeedPayload>(await memberContext.request.get('/api/dashboard/today', { params: { org: SLUG } }), 200)
    expect(completed.cards.some(card => card.id === `attention:${requestId}`)).toBe(false)
    await memberPage.clock.setFixedTime(new Date(`${day}T13:00:00.000Z`))
    await memberPage.reload()
    await expect(detail.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
    const missingId = crypto.randomUUID()
    const missingRead = memberPage.waitForResponse(response => new URL(response.url()).pathname === `/api/dashboard/bookings/booking/${missingId}`)
    await memberPage.goto(`${DASHBOARD}/bookings/booking/${missingId}/change/guests`)
    await body(await missingRead, 404)
    await expect(memberPage.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
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
        const profile = { public_name: previousSchedule.public_name, public_photo_url: previousSchedule.public_photo_url, public_bio: previousSchedule.public_bio }
        await body(await page.request.put(schedulePath, { data: { timezone: previousSchedule.timezone, weekly: previousSchedule.weekly, time_off: previousSchedule.time_off, expected_updated_at: current.scheduling.updated_at, ...profile, public_approved: Boolean(previousSchedule.public_approved) } }), 200)
        const restored = await body<{ members: Array<{ id: string; scheduling: Schedule | null }> }>(await page.request.get(`/api/organizations/${ORGANIZATION}/members/scheduling`), 200)
        expect(restored.members.find(member => member.id === actor.id)?.scheduling).toMatchObject({ timezone: previousSchedule.timezone, weekly: previousSchedule.weekly, time_off: previousSchedule.time_off, ...profile, public_approved: previousSchedule.public_approved })
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
