import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { expect, test, type APIResponse } from '@playwright/test'
import { acceptOrganizationInvitation, authRequestHeaders, loginAs, sendOrganizationInvitation } from './helpers/auth'
import { dismissPreviewToolbar, openTenantPage, waitForNuxtHydration } from './helpers'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededSiteHeaders } from './test-env'
import { seededTenant } from './seed/manifest'
import type { Product } from '../../server/types/products'
import type { BusinessToday } from '../../shared/dashboard-today'
import type { TaskSection, TaskView } from '../../server/domain/tasks'
import type { ConversationPage } from '../../shared/messages-contract'
import type { DashboardBookingDetails } from '../../server/utils/dashboard-booking-details'

const SLUG = 'harbor-legal-aid'
const DASHBOARD = `/dashboard/${SLUG}`
const ACTOR = 'user-e2e-ncls-consultation-owner'

async function body<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return response.json() as Promise<T>
}

test('an assigned staff member reviews a consultation from Calendar while Today holds only their own work', async ({ page, browser, request, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Provider hours and roles use disposable local data only')
  const ORGANIZATION = seededTenant('legal').organizationId
  const EDITOR = `/api/editor/organizations/${ORGANIZATION}`
  const release = await acquireTenantMutationLock(testInfo, ORGANIZATION)
  const memberContext = await browser.newContext()
  // The client reads the practice's hours in UTC, the attorney's own zone here.
  const clientContext = await browser.newContext({ timezoneId: 'UTC', viewport: { width: 1280, height: 900 } })
  let product: Product | null = null
  let requestId: string | null = null
  let bookingId: string | null = null
  let scheduleWritten = false
  let roleChanged = false
  const failures: unknown[] = []
  try {
  const ownerId = 'user-e2e-ncls-owner'
  const signedIn = await loginAs(page.request, baseURL!, ownerId)
  const token = signedIn.headers()['set-auth-token']
  expect(token, 'Better Auth issues the bearer token used by native Today').toBeTruthy()
  await loginAs(memberContext.request, baseURL!, ACTOR)
  const members = await body<{ members: Array<{ id: string; userId: string; role: string }> }>(
    await page.request.get('/api/dashboard/members', { params: { org: SLUG } }), 200)
  const actor = members.members.find(member => member.userId === ACTOR)
  expect(actor, 'The canonical actor fixture already belongs to Harbor Legal Aid').toBeTruthy()
  if (!actor) throw new Error('The assigned-staff actor fixture is missing')
  const owner = members.members.find(member => member.userId === ownerId)
  if (!owner) throw new Error('The owner attorney fixture is missing')
  let responsibleMemberId = actor.id
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
    await body(await page.request.put(schedulePath, { data: { timezone: 'UTC', weekly: [{ weekday: dayDate.getUTCDay(), start: '14:00', end: '14:45' }], time_off: [], updated_at: previousSchedule?.updated_at ?? null, public_name: 'Assigned attorney', public_approved: true } }), 200)
    scheduleWritten = true
    product = (await body<{ product: Product }>(await page.request.post(`${EDITOR}/products`, { data: {
      kind: 'service', active: true, name: `Today assigned consultation ${Date.now()}`, description: 'A local appointment that verifies the assigned staff dashboard.',
      details: { preparation: 'Bring your consultation questions.' },
      variants: [{ name: 'Online', prices: [{ unit_amount: 0, currency: 'USD' }] }],
    } }), 201)).product
    expect(product.image, 'The authored consultation has no Product photo').toBeNull()
    await body(await page.request.put(`${EDITOR}/products/${product.id}/booking`, { data: { duration_minutes: 45, default_capacity: 1,
      confirmation_mode: 'review', online_payment_required: false, scheduling_mode: 'provider', assigned_member_id: actor.id, held_online: true } }), 200)
    await body(await page.request.put(`${EDITOR}/products/${product.id}/publication`, { data: { published: true } }), 200)
    await body(await page.request.put(`${EDITOR}/consultation`, { data: { mode: 'native' } }), 200)
    const headers = seededSiteHeaders('legal')
    const availability = await body<{ sessions: Array<{ id: string; starts_at: string; ends_at: string; timezone: string }> }>(
      await request.get(`/api/public/products/${product.slug}/availability`, { headers, params: { location_id: 'online', from: day, to: new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10) } }), 200)
    const session = availability.sessions.find(slot => slot.starts_at === `${day}T14:00:00.000Z`)
    expect(session, 'The saved provider hours expose an actual bookable future consultation').toBeTruthy()
    if (!session) throw new Error('The provider appointment is not bookable')
    // The client requests the consultation on the practice area's own public page.
    expect(product.page, 'the consultation has its bound public page').toBeTruthy()
    const client = await clientContext.newPage()
    await openTenantPage(client, new URL(product.page!.path, baseURL!).href, headers)
    await expect(client.getByRole('heading', { name: product.name, exact: true, level: 1 })).toBeVisible()
    await client.getByRole('button', { name: 'Request appointment', exact: true }).click()
    const requestDialog = client.getByRole('dialog', { name: product.name, exact: true })
    await requestDialog.getByRole('button', { name: '2:00 PM Available', exact: true }).first().click()
    await requestDialog.getByRole('button', { name: 'Continue', exact: true }).click()
    await requestDialog.getByLabel('Full name', { exact: true }).fill(guestName)
    await requestDialog.getByLabel('Email address', { exact: true }).fill(`today-assigned-${Date.now()}@playwright.example`)
    const submitted = client.waitForResponse(response => new URL(response.url()).pathname === `/api/public/products/${product!.slug}/book` && response.request().method() === 'POST')
    await requestDialog.getByRole('button', { name: 'Request appointment', exact: true }).click()
    const submission = await submitted
    expect(submission.request().postDataJSON()).toMatchObject({ product_session_id: session.id, guest_name: guestName })
    const booked = await body<{ conversation_id: string; booking_id: string; status: string }>(submission, 201)
    await expect(client).toHaveURL(/\/bookings\/confirmed/)
    await expect(client.getByRole('heading', { name: `Thank you, ${guestName}!`, exact: true, level: 1 })).toBeVisible()
    await expect(client.getByText('Request received', { exact: true })).toBeVisible()
    requestId = booked.conversation_id
    bookingId = booked.booking_id
    expect(booked.status).toBe('pending')
    const bookingPath = `${DASHBOARD}/bookings/${bookingId}`
    const conversationPath = `${DASHBOARD}/messages/${requestId}`
    const reservationPath = `${conversationPath}/reservation/${bookingId}`
    const read = await body<{ booking: DashboardBookingDetails }>(
      await page.request.get(`/api/dashboard/bookings/${bookingId}`, { params: { org: SLUG } }), 200)
    expect(read.booking).toMatchObject({ status: 'pending', assigned_member_id: actor.id, location_title: 'Online' })
    await body(await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId: ORGANIZATION, memberId: actor.id, role: 'member' },
    }), 200)
    roleChanged = true
    // Organization-wide surfaces conceal what a member's role cannot reach with 404.
    const deniedAnalytics = await memberContext.request.get('/api/dashboard/analytics', { params: { org: SLUG } })
    expect(deniedAnalytics.status(), await deniedAnalytics.text()).toBe(404)
    const assignedRead = await body<{ booking: DashboardBookingDetails }>(
      await memberContext.request.get(`/api/dashboard/bookings/${bookingId}`, { params: { org: SLUG } }), 200)
    expect(assignedRead.booking).toMatchObject({ conversation_id: requestId, assigned_member_id: actor.id })

    // A member's Today is their own work: the request waiting for their decision, with no money. The attorney sits in
    // the client's conversation, so the card opens it.
    const when = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', { timeZone: session.timezone, ...options }).format(new Date(session.starts_at))
    const today = await body<BusinessToday>(await memberContext.request.get('/api/dashboard/today', { params: { org: SLUG } }), 200)
    expect([today.title, today.cards]).toEqual(['You have 1 request', [{
      id: `booking:${bookingId}`, when: `${when({ weekday: 'short', month: 'short', day: 'numeric' })} · ${when({ hour: 'numeric', minute: '2-digit' })}`, image_url: null, icon: 'i-lucide-scale', done: null,
      headline: `${guestFirstName} wants to book`, line: `${product.name} · Online`, action: { title: 'Review the request', detail: 'Accept or decline' }, to: conversationPath, draft: null,
    }]])
    // The consultation is the Calendar's: it is on its day there.
    const agenda = await body<{ items: Array<{ id: string; conversation_id: string; booking_id: string; starts_at: string; to: string }> }>(await memberContext.request.get('/api/dashboard/agenda', { params: { org: SLUG, from: day, to: new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10) } }), 200)
    expect(agenda.items.find(item => item.conversation_id === requestId)).toMatchObject({ id: `booking:${requestId}`, booking_id: read.booking.booking_id, starts_at: session.starts_at, to: conversationPath })

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
    expect(await forbiddenPreview.json()).not.toHaveProperty('context.preview_token')
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
    const dayReads: string[] = []
    const watchDayRead = (request: import('@playwright/test').Request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/dashboard/agenda') dayReads.push(url.pathname)
    }
    memberPage.on('request', watchDayRead)
    const calendarDocument = await memberPage.goto(`${DASHBOARD}/calendar/${day}`)
    expect(calendarDocument?.status()).toBe(200)
    expect(calendarDocument?.headers()['cache-control']).toContain('no-store')
    const calendarHtml = await calendarDocument?.text()
    const dayPanel = 'id="dashboard-panel-calendar-day"'
    expect(calendarHtml).toContain(dayPanel)
    expect(calendarHtml?.slice(calendarHtml.indexOf(dayPanel))).toContain(`href="${conversationPath}"`)
    await waitForNuxtHydration(memberPage)
    expect(dayReads).toEqual([])
    memberPage.off('request', watchDayRead)
    await memberPage.locator(`#dashboard-panel-calendar-day a[href="${conversationPath}"]`).click()
    await expect(memberPage).toHaveURL(new URL(reservationPath, baseURL!).toString())
    const thread = memberPage.locator('#dashboard-panel-organization-messages-thread')
    const detail = memberPage.locator('#dashboard-panel-booking-details')
    await expect(thread).toBeVisible()
    await expect(detail.getByRole('heading', { name: 'Reservation', level: 1, exact: true })).toBeVisible()
    const threadBounds = await thread.boundingBox()
    const detailBounds = await detail.boundingBox()
    expect(threadBounds).not.toBeNull()
    expect(detailBounds).not.toBeNull()
    expect(threadBounds!.x + threadBounds!.width).toBeLessThanOrEqual(detailBounds!.x + 1)

    await memberPage.setViewportSize({ width: 390, height: 844 })
    await expect(thread).toBeHidden()
    await expect(detail).toBeVisible()
    await expect(detail.getByText('Awaiting review', { exact: true })).toBeVisible()
    await expect(detail.getByRole('heading', { name: product.name, level: 2, exact: true })).toBeVisible()
    await expect(detail.getByRole('link', { name: '1 client', exact: true })).toBeVisible()
    await expect(detail.locator('[data-slot="fallback"]').filter({ hasText: /^M$/u })).toBeVisible()
    await expect(detail.getByRole('heading', { name: 'Who’s coming', exact: true })).toBeVisible()
    await expect(detail.getByRole('heading', { name: 'Hosted by Assigned attorney', exact: true })).toBeVisible()
    await expect(detail.getByRole('link', { name: 'Hosted by Assigned attorney', exact: true })).toHaveCount(0)
    await dismissPreviewToolbar(page)
    await page.setViewportSize({ width: 390, height: 844 })
    const initialReservationReads: string[] = []
    const watchInitialRead = (request: import('@playwright/test').Request) => {
      const path = new URL(request.url()).pathname
      if (path === '/api/dashboard/context' || path === `/api/dashboard/bookings/${bookingId}`) initialReservationReads.push(path)
    }
    page.on('request', watchInitialRead)
    const documentResponse = await page.goto(new URL(bookingPath, baseURL!).toString())
    expect(documentResponse?.status()).toBe(200)
    expect(documentResponse?.headers()['cache-control']).toContain('no-store')
    expect(await documentResponse?.text()).toContain('id="dashboard-panel-booking-details"')
    await expect(page).toHaveURL(new URL(bookingPath, baseURL!).toString())
    // The attorney is the practice area's: the owner reads who handles it and changes it on the practice area.
    const ownerDetail = page.locator('#dashboard-panel-booking-details')
    await expect(ownerDetail.getByRole('heading', { name: 'Hosted by Assigned attorney', exact: true })).toBeVisible()
    await expect(ownerDetail.getByRole('link', { name: 'Hosted by Assigned attorney', exact: true })).toHaveCount(0)
    expect(initialReservationReads).toEqual([])
    page.off('request', watchInitialRead)
    await detail.getByRole('link', { name: 'Change consultation', exact: true }).click()
    const change = memberPage.locator('#dashboard-panel-booking-change')
    await expect(change.getByRole('heading', { name: 'Consultation details', exact: true })).toBeVisible()
    await expect(change.getByRole('spinbutton', { name: 'Clients', exact: true })).toHaveValue('1')
    await expect(change.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled()
    await change.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(memberPage).toHaveURL(new URL(reservationPath, baseURL!).toString())
    const confirmed = memberPage.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/bookings/${bookingId}/confirm`))
    await detail.getByRole('button', { name: 'Confirm consultation', exact: true }).click()
    expect((await confirmed).status()).toBe(200)
    const persisted = await body<{ booking: { status: string; assigned_member_id: string } }>(
      await page.request.get(`/api/dashboard/bookings/${bookingId}`, { params: { org: SLUG } }), 200)
    expect(persisted.booking).toMatchObject({ status: 'confirmed', assigned_member_id: actor.id })

    await page.reload()
    await waitForNuxtHydration(page)
    const privateNote = 'Share the consultation checklist with the attorney'
    const privateNoteLink = ownerDetail.getByRole('link', { name: /Private note/ })
    await privateNoteLink.click()
    const noteEditor = page.locator('#dashboard-panel-booking-private-note')
    await noteEditor.getByRole('textbox', { name: 'Private note' }).fill(privateNote)
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/dashboard/bookings/${bookingId}`)
    await noteEditor.getByRole('button', { name: 'Save', exact: true }).click()
    const noteResponse = await saved
    expect(noteResponse.status()).toBe(200)
    expect(await noteResponse.json()).toEqual({ booking: { booking_id: bookingId, private_notes: privateNote, version: expect.any(Number) } })
    await expect(privateNoteLink.getByText(privateNote, { exact: true })).toBeVisible()
    expect(await body(await page.request.get(`/api/dashboard/bookings/${bookingId}`, { params: { org: SLUG } }), 200)).toMatchObject({
      booking: { booking_id: bookingId, private_notes: privateNote, status: 'confirmed' },
    })
    // Confirming the consultation answers the request: nothing is left on Today, and the consultation is the member's Upcoming.
    const after = await body<BusinessToday>(await memberContext.request.get('/api/dashboard/today', { params: { org: SLUG } }), 200)
    expect([after.title, after.cards]).toEqual(['Nothing needs you today', []])
    const upcoming = await body<BusinessToday>(await memberContext.request.get('/api/dashboard/today', { params: { org: SLUG, range: 'upcoming' } }), 200)
    expect([upcoming.title, upcoming.cards.map(card => [card.id, card.headline, card.action.title, card.to])]).toEqual(['You have 1 upcoming consultation',
      [[`booking:${bookingId}`, `${guestFirstName}’s consultation`, 'Say hello to your client', conversationPath]]])
    await memberPage.setViewportSize({ width: 1440, height: 900 })
    const todayReads: string[] = []
    const watchTodayRead = (request: import('@playwright/test').Request) => {
      const path = new URL(request.url()).pathname
      if (path === '/api/dashboard/context' || path === '/api/dashboard/today') todayReads.push(path)
    }
    memberPage.on('request', watchTodayRead)
    const todayDocument = await memberPage.goto(DASHBOARD)
    expect(todayDocument?.status()).toBe(200)
    expect(todayDocument?.headers()['cache-control']).toContain('no-store')
    expect(await todayDocument?.text()).toContain('Nothing needs you today')
    await waitForNuxtHydration(memberPage)
    await expect(memberPage.getByTestId('today-title')).toHaveText('Nothing needs you today')
    expect(todayReads).toEqual([])
    memberPage.off('request', watchTodayRead)
    await memberPage.goto(bookingPath)
    await waitForNuxtHydration(memberPage)
    await memberPage.clock.setFixedTime(new Date(`${day}T13:00:00.000Z`))
    await memberPage.reload()
    await expect(detail.getByText(when({ weekday: 'short', month: 'short', day: 'numeric' }), { exact: true })).toBeVisible()
    const missingId = crypto.randomUUID()
    const missingRead = await memberContext.request.get(`/api/dashboard/bookings/${missingId}`, { params: { org: SLUG } })
    expect(await body(missingRead, 404)).not.toHaveProperty('booking')
    await memberPage.goto(`${DASHBOARD}/bookings/${missingId}/change`)
    await expect(memberPage.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
    await expect(change).toHaveCount(0)

    // Upcoming in Today shows the same open follow-up under the responsible attorney.
    const followUps = async (assignee: string) => (await body<{ tasks: TaskSection[] }>(
      await request.get('/api/dashboard/today', {
        headers: { Authorization: `Bearer ${token}` },
        params: { org: SLUG, range: 'upcoming', kind: 'consultation_follow_up', assignee },
      }), 200)).tasks.flatMap(section => section.tasks).filter(task => task.booking_id === bookingId)
    await expect.poll(async () => (await followUps(actor.id)).map(task => task.assignee?.id)).toEqual([actor.id])
    const [followUp] = await followUps(actor.id)
    await body(await page.request.put(`${EDITOR}/products/${product.id}/booking`, { data: { assigned_member_id: owner.id } }), 200)
    responsibleMemberId = owner.id
    const reassigned = await body<{ booking: DashboardBookingDetails }>(
      await page.request.get(`/api/dashboard/bookings/${bookingId}`, { params: { org: SLUG } }), 200)
    expect(reassigned.booking.assigned_member_id).toBe(owner.id)
    expect(await followUps(actor.id), 'The previous attorney’s filter no longer includes the follow-up').toEqual([])
    expect(await followUps(owner.id)).toMatchObject([{
      id: followUp!.id, status: 'open', version: followUp!.version + 1, due_at: followUp!.due_at, assignee: { id: owner.id },
    }])

    // A client writes to the office that its door sticks. The owner makes a maintenance job of that message, prefilled with the office,
    // for this member, who now does maintenance; their Today has the job, and Done with a note closes it in the job's conversation.
    // A booking's opening, which Blawby writes for the client, offers no such job.
    await body(await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId: ORGANIZATION, memberId: actor.id, role: 'maintenance' },
    }), 200)
    const office = seededTenant('legal').locations.raleigh!
    const repairTitle = `Lobby door sticks ${Date.now()}`
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(new URL(conversationPath, baseURL!).toString())
    await waitForNuxtHydration(page)
    await expect(page.locator('[data-message]').first()).toBeVisible()
    await expect(page.getByTestId('conversation-create-maintenance')).toHaveCount(0)
    const report = await body<{ conversation_id: string }>(await clientContext.request.post('/api/public/contact', {
      headers: seededSiteHeaders('legal'),
      data: { name: guestName, email: `today-repair-${Date.now()}@playwright.example`, subject: 'general', message: 'The lobby door at your office sticks and is hard to open.', location_id: office.id },
    }), 201)
    await page.goto(new URL(`${DASHBOARD}/messages/${report.conversation_id}`, baseURL!).toString())
    await waitForNuxtHydration(page)
    await page.getByTestId('conversation-create-maintenance').first().click()
    const sheet = page.getByRole('dialog', { name: 'New maintenance job', exact: true })
    await sheet.getByLabel(/^What needs fixing/).fill(repairTitle)
    await expect(sheet.getByRole('combobox', { name: /^Where/ })).toContainText(office.title)
    const eligible = await body<{ assignees: Array<{ id: string; name: string }> }>(await page.request.get(`/api/organizations/${ORGANIZATION}/tasks/maintenance-options`), 200)
    const fixer = eligible.assignees.find(person => person.id === actor.id)
    if (!fixer) throw new Error('The maintenance member is not offered for repair work')
    await sheet.getByRole('combobox', { name: /^Assigned/ }).click()
    await page.getByRole('option', { name: fixer.name, exact: true }).click()
    const creating = page.waitForResponse(response => new URL(response.url()).pathname === `/api/organizations/${ORGANIZATION}/tasks` && response.request().method() === 'POST')
    await sheet.getByRole('button', { name: 'Create', exact: true }).click()
    const { task: repair } = await body<{ task: TaskView }>(await creating, 201)
    expect(repair).toMatchObject({ kind: 'maintenance', status: 'open', title: repairTitle, place: office.title, assignee: { id: actor.id } })
    await expect(sheet).toBeHidden()
    // The job is posted in the office's conversation; the member's Today card opens it and closes from its strip.
    const repairCard = async () => (await body<BusinessToday>(await memberContext.request.get('/api/dashboard/today', { params: { org: SLUG } }), 200)).cards.find(card => card.id === `task:${repair.id}`)
    await expect.poll(async () => (await repairCard())?.to ?? null).toMatch(new RegExp(`^${DASHBOARD}/messages/`))
    const card = (await repairCard())!
    expect(card).toMatchObject({ when: 'Maintenance', headline: repairTitle, line: office.title, done: { path: `/api/organizations/${ORGANIZATION}/tasks/${repair.id}/complete` } })
    await memberPage.setViewportSize({ width: 1280, height: 900 })
    await memberPage.goto(new URL(card.to!, baseURL!).toString())
    await waitForNuxtHydration(memberPage)
    const jobCard = memberPage.getByTestId('conversation-job-card').filter({ hasText: repairTitle })
    await expect(jobCard).toBeVisible()
    await expect(jobCard.getByTestId('conversation-job-done')).toBeVisible()
    const note = 'Planed the door; it closes now.'
    const fixed = await body<{ task: TaskView }>(await memberContext.request.post(card.done!.path, { data: { note } }), 200)
    expect(fixed.task).toMatchObject({ status: 'done', outcome: { note } })
    // The owner reads the note in the job's conversation.
    const repairThread = card.to!.split('/').pop()!
    const ownerRead = await body<ConversationPage>(await page.request.get(`/api/messages/${repairThread}`), 200)
    expect(ownerRead.entries.some(entry => entry.type === 'message' && entry.body === note && entry.author_user_id === ACTOR)).toBe(true)
  } finally {
    try {
      if (requestId) {
        const { booking } = await body<{ booking: DashboardBookingDetails }>(await page.request.get(`/api/dashboard/bookings/${bookingId}`, { params: { org: SLUG } }), 200)
        await body(await page.request.post(`/api/dashboard/bookings/${bookingId}/cancel`, { params: { org: SLUG }, data: { version: booking.version, idempotency_key: crypto.randomUUID() } }), 200)
        const cancelled = await body<{ booking: { status: string } }>(await page.request.get(`/api/dashboard/bookings/${bookingId}`, { params: { org: SLUG } }), 200)
        expect(cancelled.booking.status).toBe('cancelled')
      }
      if (product) {
        await body(await page.request.put(`${EDITOR}/products/${product.id}/publication`, { data: { published: false } }), 200)
        if (requestId) {
          // Archive the authored consultation with its attorney configuration and booked history.
          await body(await page.request.patch(`${EDITOR}/products/${product.id}`, { data: { active: false } }), 200)
          const archived = await body<{ product: Product }>(await page.request.get(`${EDITOR}/products/${product.id}`), 200)
          expect(archived.product).toMatchObject({ active: false, booking: { held_online: true, scheduling_mode: 'provider', assigned_member_id: responsibleMemberId } })
          expect(archived.product.publications).toContainEqual({ organization_id: ORGANIZATION, published: false })
          const history = await body<{ booking: DashboardBookingDetails }>(await page.request.get(`/api/dashboard/bookings/${bookingId}`, { params: { org: SLUG } }), 200)
          expect(history.booking).toMatchObject({ conversation_id: requestId, status: 'cancelled', assigned_member_id: responsibleMemberId })
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
        await body(await page.request.put(schedulePath, { data: { timezone: previousSchedule.timezone, weekly: previousSchedule.weekly, time_off: previousSchedule.time_off, updated_at: current.scheduling.updated_at, ...profile, public_approved: Boolean(previousSchedule.public_approved) } }), 200)
        const restored = await body<{ members: Array<{ id: string; scheduling: Schedule | null }> }>(await page.request.get(`/api/organizations/${ORGANIZATION}/members/scheduling`), 200)
        expect(restored.members.find(member => member.id === actor.id)?.scheduling).toMatchObject({ timezone: previousSchedule.timezone, weekly: previousSchedule.weekly, time_off: previousSchedule.time_off, ...profile, public_approved: previousSchedule.public_approved })
      } else if (scheduleWritten) {
        // An absent schedule is restored through Better Auth's existing removal
        // and invitation lifecycle, rather than direct authentication-row writes.
        await body(await page.request.post('/api/auth/organization/remove-member', { headers: authRequestHeaders(baseURL!), data: { organizationId: ORGANIZATION, memberIdOrEmail: actor.id } }), 200)
        const invitationId = await sendOrganizationInvitation(page.request, baseURL!, ORGANIZATION, findE2eAuthFixture(ACTOR).email, 'member')
        const joined = await acceptOrganizationInvitation(memberContext.request, baseURL!, invitationId)
        await body(await page.request.post('/api/auth/organization/update-member-role', { headers: authRequestHeaders(baseURL!), data: { organizationId: ORGANIZATION, memberId: joined.id, role: actor.role } }), 200)
        roleChanged = false
        const restored = await body<{ scheduling: Schedule | null }>(await page.request.get(`/api/organizations/${ORGANIZATION}/members/${joined.id}/scheduling`), 200)
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
    await clientContext.close()
    await memberContext.close()
    await release()
  }
  if (failures.length) throw new AggregateError(failures, 'Assigned appointment workflow or cleanup did not complete')
})
