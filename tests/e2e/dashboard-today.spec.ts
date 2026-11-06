import { expect, test, type BrowserContext, type WebSocket } from '@playwright/test'
import { loginAs, authRequestHeaders } from './helpers/auth'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededSiteHeaders } from './test-env'
import { seededTenant } from './seed/manifest'
import type { TodayFeedPayload } from '../../shared/dashboard-today'
import type { AgendaPayload } from '../../server/utils/dashboard-agenda'
import type { DashboardBookingDetails } from '../../server/utils/dashboard-booking-details'
import type { InboxListPage, InboxThread } from '../../server/domain/guest-threads/types'
import { isDashboardInvalidation } from '../../shared/dashboard-invalidations'
import { formatTimestamp, localDateAt, localNow } from '../../utils/timezone'

const ORG = '/dashboard/ember-slice-demo'

test('automation remains in Inbox while Today keeps the unanswered inquiry', async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Scheduled replies use disposable local data only')
  const organizationId = seededTenant('restaurant').organizationId
  const release = await acquireTenantMutationLock(testInfo, organizationId)
  const marker = `ScheduledReply${Date.now()}`
  let messageId: string | null = null
  let futureMessageId: string | null = null
  let cancelled = false
  try {
    await loginAs(page.request, baseURL!)
    await dismissPreviewToolbar(page)
    const submitted = await request.post('/api/public/contact', { headers: seededSiteHeaders('restaurant'), data: {
      name: marker, email: `${marker.toLowerCase()}@playwright.example`, subject: 'general', consent: true,
      message: 'Can you accommodate a group for dinner next week?',
    } })
    expect(submitted.status(), await submitted.text()).toBe(201)
    const inbox = await page.request.get(`/api/dashboard/organizations/${organizationId}/guest-threads`, { params: { type: 'contact' } })
    expect(inbox.status(), await inbox.text()).toBe(200)
    const threads = (await inbox.json() as { threads: Array<{ id: string; guestName: string }> }).threads.filter(thread => thread.guestName === marker)
    expect(threads).toHaveLength(1)
    const threadId = threads[0]!.id
    const sendAt = new Date(Date.now() + 2 * 86_400_000).toISOString()
    const scheduled = await page.request.post(`/api/dashboard/organizations/${organizationId}/guest-threads/${threadId}/send-later`, {
      data: { body: `We can discuss your group dinner, ${marker}.`, sendAt },
    })
    expect(scheduled.status(), await scheduled.text()).toBe(201)
    messageId = (await scheduled.json() as { message: { id: string } }).message.id
    const futureSendAt = new Date(Date.now() + 40 * 86_400_000).toISOString()
    const futureScheduled = await page.request.post(`/api/dashboard/organizations/${organizationId}/guest-threads/${threadId}/send-later`, {
      data: { body: `Later follow-up for ${marker}.`, sendAt: futureSendAt },
    })
    expect(futureScheduled.status(), await futureScheduled.text()).toBe(201)
    futureMessageId = (await futureScheduled.json() as { message: { id: string } }).message.id

    expect((await page.goto(`${ORG}?range=upcoming`))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const upcoming = await page.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo', range: 'upcoming',
      from: new Date(Date.parse(sendAt) - 86_400_000).toISOString().slice(0, 10), to: new Date(Date.parse(sendAt) + 86_400_000).toISOString().slice(0, 10) } })
    expect(upcoming.status(), await upcoming.text()).toBe(200)
    const scheduledCard = (await upcoming.json() as TodayFeedPayload).cards.filter(card => card.actionAt === sendAt && card.to.includes(threadId))
    expect(scheduledCard).toHaveLength(0)
    const card = page.locator(`[data-card-id="send-later:${messageId}"]`)
    const futureCard = page.locator(`[data-card-id="send-later:${futureMessageId}"]`)
    await expect(card).toHaveCount(0)
    await expect(futureCard).toHaveCount(0)
    const pending = await page.request.get(`/api/dashboard/organizations/${organizationId}/send-later`, { params: { threadId } })
    expect(pending.status(), await pending.text()).toBe(200)
    expect((await pending.json() as { messages: Array<{ id: string; status: string }> }).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, status: 'pending' })]))
    // Cancellation is verified in Inbox's persisted schedule. Healthy sends no
    // longer have a feed card or a feed invalidation to assert against here.
    const response = await page.request.post(`/api/dashboard/organizations/${organizationId}/send-later/${messageId}/cancel`)
    expect(response.status(), await response.text()).toBe(200)
    expect(await response.json()).toMatchObject({ message: { id: messageId, status: 'cancelled' } })
    cancelled = true
    const persisted = await page.request.get(`/api/dashboard/organizations/${organizationId}/send-later`, { params: { threadId } })
    expect(persisted.status(), await persisted.text()).toBe(200)
    // This reader deliberately lists work still scheduled or recently failed;
    // cancelled work leaves it, as it must leave Upcoming independently below.
    expect((await persisted.json() as { messages: Array<{ id: string }> }).messages.filter(message => message.id === messageId)).toEqual([])
    await expect(card).toHaveCount(0)
    // Other healthy background work also stays outside the quest feed.
    await expect(futureCard).toHaveCount(0)
    await page.getByRole('tab', { name: 'Today', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('today-list').locator(`[data-card-id="attention:${threadId}"]`)).toBeVisible()
    await expect(card).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('today-work-list.png'), fullPage: true, animations: 'disabled' })
  } finally {
    try {
      if (messageId && !cancelled) {
        const response = await page.request.post(`/api/dashboard/organizations/${organizationId}/send-later/${messageId}/cancel`)
        expect(response.status(), await response.text()).toBe(200)
      }
      if (futureMessageId) {
        const response = await page.request.post(`/api/dashboard/organizations/${organizationId}/send-later/${futureMessageId}/cancel`)
        expect(response.status(), await response.text()).toBe(200)
      }
    } finally { await release() }
  }
})

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('region', { name: 'Analytics notice', exact: true }), async notice => {
    await notice.getByRole('button', { name: 'Reject', exact: true }).click()
  })
})

test('Upcoming keeps its navigation and loading visible while its real first page is pending', async ({ page, baseURL }) => {
  await loginAs(page.request, baseURL!)
  await dismissPreviewToolbar(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const isUpcoming = (url: URL) => url.pathname === '/api/dashboard/today' && url.searchParams.get('range') === 'upcoming'
  const panel = page.locator('#dashboard-panel-org-today')
  const loading = panel.locator('[aria-live="polite"] .animate-spin')

  for (const phase of ['open', 'reload'] as const) {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let held = false
    await page.route(isUpcoming, async route => {
      if (!held) {
        held = true
        await pending
      }
      await route.continue()
    })
    const requested = page.waitForRequest(request => isUpcoming(new URL(request.url())))
    try {
      const response = phase === 'open'
        ? await page.goto(`${ORG}?locationId=${seededTenant('restaurant').locations.brooklyn.id}&range=upcoming`)
        : await page.reload()
      expect(response?.status()).toBe(200)
      await requested
      await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('tab', { name: 'Today', exact: true })).toBeVisible()
      await expect(loading).toBeVisible()
      const completed = page.waitForResponse(response => isUpcoming(new URL(response.url())))
      release()
      expect((await completed).status()).toBe(200)
      await expect(loading).toBeHidden()
      await expect(panel.getByText('Upcoming could not be loaded', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toHaveAttribute('aria-selected', 'true')
    } finally {
      release()
      await page.unrouteAll({ behavior: 'wait' })
    }
  }
})

test('Today keeps its location across range changes', async ({ page, baseURL }) => {
  await loginAs(page.request, baseURL!)
  await dismissPreviewToolbar(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(ORG)
  await waitForNuxtHydration(page)
  await page.getByRole('button', { name: 'Filter activity', exact: true }).click()
  await page.getByRole('combobox', { name: 'Location', exact: true }).click()
  await page.getByRole('option', { name: 'Ember & Slice Brooklyn', exact: true }).click()
  await page.getByRole('button', { name: 'Filter activity', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Filter activity', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('tab', { name: 'Upcoming', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('locationId') === seededTenant('restaurant').locations.brooklyn.id && url.searchParams.get('range') === 'upcoming')
  await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await expect(page).toHaveURL(url => url.searchParams.get('locationId') === seededTenant('restaurant').locations.brooklyn.id && url.searchParams.get('range') === 'upcoming')
  await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('tab', { name: 'Today', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('locationId') === seededTenant('restaurant').locations.brooklyn.id && url.searchParams.get('range') !== 'upcoming')
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true')
})

test('an assigned member receives no owner work or unassigned restaurant work', async ({ page, browser, baseURL }, testInfo) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Role changes use disposable local actors only')
  const release = await acquireTenantMutationLock(testInfo, seededTenant('restaurant').organizationId)
  await loginAs(page.request, baseURL!)
  const response = await page.request.get('/api/dashboard/members', { params: { org: 'ember-slice-demo' } })
  expect(response.status(), await response.text()).toBe(200)
  const { members } = await response.json() as { members: Array<{ id: string; userId: string; role: string }> }
  const actor = members.find(member => member.userId === 'user-e2e-demo-role-owner')
  expect(actor).toBeTruthy()
  const memberContext = await browser.newContext()
  try {
    const ownerResponse = await page.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo' } })
    expect(ownerResponse.status(), await ownerResponse.text()).toBe(200)
    const ownerFeed = await ownerResponse.json() as TodayFeedPayload
    expect(ownerFeed.cards.length, 'The owner sees organization-wide work the member must not').toBeGreaterThan(0)
    const changed = await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId: seededTenant('restaurant').organizationId, memberId: actor!.id, role: 'member' },
    })
    expect(changed.status(), await changed.text()).toBe(200)
    await loginAs(memberContext.request, baseURL!, actor!.userId)
    const memberFeed = await memberContext.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo' } })
    expect(memberFeed.status(), await memberFeed.text()).toBe(200)
    expect((await memberFeed.json() as TodayFeedPayload).cards).toEqual([])
    const denied = await memberContext.request.get('/api/dashboard/analytics', { params: { org: 'ember-slice-demo' } })
    // Organization-wide surfaces deliberately conceal denied scope with 404.
    expect(denied.status()).toBe(404)
    const memberPage = await memberContext.newPage()
    expect((await memberPage.goto(new URL(ORG, baseURL!).toString()))?.status()).toBe(200)
    await expect(memberPage.getByText('Nothing for today', { exact: true })).toBeVisible()
    await expect(memberPage.getByTestId('today-card')).toHaveCount(0)
  } finally {
    try {
      const restored = await page.request.post('/api/auth/organization/update-member-role', {
        headers: authRequestHeaders(baseURL!), data: { organizationId: seededTenant('restaurant').organizationId, memberId: actor!.id, role: actor!.role },
      })
      expect(restored.status(), await restored.text()).toBe(200)
      const read = await page.request.get('/api/dashboard/members', { params: { org: 'ember-slice-demo' } })
      expect(read.status()).toBe(200)
      expect((await read.json() as { members: Array<{ id: string; role: string }> }).members.find(member => member.id === actor!.id)?.role).toBe(actor!.role)
    } finally {
      await memberContext.close()
      await release()
    }
  }
})

test('branch assignments grant and revoke a member’s reservation agenda and inbox through native team membership', async ({ page, browser, request, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Reservations and role changes use disposable local data only')
  const release = await acquireTenantMutationLock(testInfo, seededTenant('restaurant').organizationId)
  const org = 'ember-slice-demo'
  const organizationId = seededTenant('restaurant').organizationId
  const locationId = seededTenant('restaurant').locations.brooklyn.id
  const locationPath = `/api/dashboard/locations/${locationId}`
  const inboxPath = `/api/dashboard/organizations/${organizationId}/guest-threads`
  type Assignment = { assigned_member_id: string | null; assigned_team_id: string | null }
  type Member = { id: string; userId: string; role: string }
  let original: Assignment | null = null
  let actor: Member | undefined
  let originalTeamIds: string[] | null = null
  let teamId: string | null = null
  let reservationId: string | null = null
  let memberContext: BrowserContext | null = null
  const failures: unknown[] = []
  const readAssignment = async () => {
    const response = await page.request.get(`/api/organizations/${organizationId}/locations/${locationId}`)
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { location: Assignment }).location
  }
  try {
    memberContext = await browser.newContext({ baseURL })
    const memberRequest = memberContext.request
    await loginAs(page.request, baseURL!)
    original = await readAssignment()
    const members = await page.request.get('/api/dashboard/members', { params: { org } })
    expect(members.status(), await members.text()).toBe(200)
    actor = (await members.json() as { members: Member[] }).members.find(member => member.userId === 'user-e2e-demo-role-owner')
    expect(actor, 'The canonical role actor already belongs to the demo tenant').toBeDefined()
    if (!actor) throw new Error('The canonical demo role actor is missing')
    // The branch keeps the tenant's own responsibility; the actor holds none of it.
    expect(original.assigned_member_id).not.toBe(actor.id)
    expect(original.assigned_team_id).toBeNull()
    const teams = await page.request.get('/api/auth/organization/list-teams', { params: { organizationId } })
    expect(teams.status(), await teams.text()).toBe(200)
    originalTeamIds = (await teams.json() as Array<{ id: string }>).map(team => team.id).sort()

    const availability = await request.get('/api/public/reservations/availability', {
      headers: seededSiteHeaders('restaurant'), params: { location_id: locationId, date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), days: 7 },
    })
    expect(availability.status(), await availability.text()).toBe(200)
    const calendar = await availability.json() as { timezone: string; dates: Array<{ date: string; slots: Array<{ time_slot: string; starts_at: string; is_closed: boolean; is_full: boolean; remaining: number | null }> }> }
    const day = calendar.dates.find(day => day.slots.some(slot => !slot.is_closed && !slot.is_full && (slot.remaining === null || slot.remaining >= 2)))
    const slot = day?.slots.find(slot => !slot.is_closed && !slot.is_full && (slot.remaining === null || slot.remaining >= 2))
    expect(slot, 'The existing demo reservation policy and hours expose a future table for two').toBeDefined()
    if (!day || !slot) throw new Error('The existing demo location has no future table for two')
    const guestName = `Branch${Date.now()} Guest`
    const booked = await request.post('/api/public/reservations', { headers: seededSiteHeaders('restaurant'), data: {
      name: guestName, email: `branch-assignment-${Date.now()}@playwright.example`, phone: '+61491570007',
      date: day.date, time: slot.time_slot, guests: '2', location_id: locationId, idempotency_key: crypto.randomUUID(),
    } })
    expect(booked.status(), await booked.text()).toBe(201)
    reservationId = (await booked.json() as { id: string }).id
    expect(reservationId).toEqual(expect.any(String))
    const bookingPath = `/api/dashboard/bookings/reservation/${reservationId}`
    const destination = `${ORG}/bookings/reservation/${reservationId}`
    const ownerBooking = await page.request.get(bookingPath, { params: { org } })
    expect(ownerBooking.status(), await ownerBooking.text()).toBe(200)
    const { booking } = await ownerBooking.json() as { booking: DashboardBookingDetails }
    expect(booking).toMatchObject({ id: reservationId, threadId: reservationId, organizationId, locationId, guestName, status: 'confirmed', bookingDate: day.date, bookingTime: slot.time_slot, timeZone: calendar.timezone, partySize: 2 })
    const ownerThread = await page.request.get(`${inboxPath}/${reservationId}`)
    expect(ownerThread.status(), await ownerThread.text()).toBe(200)
    // The conversation is about this reservation at this branch; the record above holds its time, party and status.
    const ownerConversation = (await ownerThread.json() as { thread: InboxThread }).thread
    expect(ownerConversation).toMatchObject({ id: reservationId, kind: 'guest', guestName, channel: 'direct', home: booking.locationTitle, recordId: reservationId, recordKind: 'reservation' })
    expect(ownerConversation.when).toEqual(expect.any(String))
    // The thread header's second line: the branch and the reservation's time, as the server wrote them.
    const headerFacts = `${booking.locationTitle} · ${ownerConversation.when}`

    const changed = await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId, memberId: actor.id, role: 'member' },
    })
    expect(changed.status(), await changed.text()).toBe(200)
    await loginAs(memberRequest, baseURL!, actor.userId)
    const memberPage = await memberContext.newPage()
    const sockets: WebSocket[] = []
    memberPage.on('websocket', socket => sockets.push(socket))
    await dismissPreviewToolbar(memberPage)
    const verifyAccess = async (assigned: boolean) => {
      // A confirmed reservation days away is on Upcoming; it is not work due today.
      const todayResponse = await memberRequest.get('/api/dashboard/today', { params: { org } })
      expect(todayResponse.status(), await todayResponse.text()).toBe(200)
      const todayCards = (await todayResponse.json() as TodayFeedPayload).cards.filter(card => card.id.endsWith(`:${reservationId}`))
      // Its future occurrence belongs on Upcoming, with the same access as
      // the canonical record. A received booking creates no action for today.
      expect(todayCards).toEqual([])
      const upcomingResponse = await memberRequest.get('/api/dashboard/today', { params: { org, range: 'upcoming', from: day.date, to: day.date } })
      expect(upcomingResponse.status(), await upcomingResponse.text()).toBe(200)
      const feed = await upcomingResponse.json() as TodayFeedPayload
      const id = `reservation:${reservationId}`
      expect(feed.cards.some(card => card.id === id)).toBe(false)
      if (assigned) expect(feed.locations.map(location => location.id)).toContain(locationId)
      const agendaResponse = await memberRequest.get('/api/dashboard/agenda', { params: { org, from: day.date, to: day.date } })
      expect(agendaResponse.status(), await agendaResponse.text()).toBe(200)
      const agenda = await agendaResponse.json() as AgendaPayload
      if (assigned) expect(agenda.items.find(item => item.requestId === reservationId)).toMatchObject({ id: `reservation:${reservationId}`, kind: 'reservation', requestId: reservationId, locationId, title: guestName, status: 'confirmed', startsAt: slot.starts_at, to: destination })
      else expect(agenda.items.some(item => item.requestId === reservationId)).toBe(false)
      for (const path of [inboxPath, '/api/dashboard/guest-threads']) {
        const response = await memberRequest.get(path, { params: { org, location_id: locationId, type: 'reservation' } })
        expect(response.status(), await response.text()).toBe(200)
        const { threads } = await response.json() as InboxListPage
        if (assigned) expect(threads.find(thread => thread.id === reservationId)).toMatchObject({ id: reservationId, kind: 'guest', guestName, home: booking.locationTitle, when: ownerConversation.when })
        else expect(threads.some(thread => thread.id === reservationId)).toBe(false)
      }
      const detail = await memberRequest.get(`${inboxPath}/${reservationId}`)
      expect(detail.status(), await detail.text()).toBe(assigned ? 200 : 404)
      const record = await memberRequest.get(bookingPath, { params: { org } })
      expect(record.status(), await record.text()).toBe(assigned ? 200 : 404)
      if (assigned) {
        expect((await detail.json() as { thread: InboxThread }).thread).toMatchObject({ id: reservationId, guestName, home: booking.locationTitle, when: ownerConversation.when, recordId: reservationId, recordKind: 'reservation' })
        expect((await record.json() as { booking: DashboardBookingDetails }).booking).toMatchObject({ id: reservationId, threadId: reservationId, guestName, locationId, status: 'confirmed' })
        expect((await memberPage.goto(`${ORG}?range=upcoming`))?.status()).toBe(200)
        await waitForNuxtHydration(memberPage)
        await expect(memberPage.locator(`[data-card-id="reservation:${reservationId}"]`)).toHaveCount(0)
        await memberPage.getByRole('tab', { name: 'Today', exact: true }).click()
        await expect(memberPage.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true')
        await expect(memberPage.locator(`[data-card-id="reservation:${reservationId}"]`)).toHaveCount(0)
        const openedThread = memberPage.waitForResponse(response => response.request().method() === 'GET'
          && new URL(response.url()).pathname === `${inboxPath}/${reservationId}`)
        expect((await memberPage.goto(`${ORG}/messages/${reservationId}`))?.status()).toBe(200)
        await expect(memberPage.locator(`[data-thread-row="${reservationId}"]`)).toContainText(guestName)
        // The first-open reconciliation read happens after the real socket upgrade.
        expect((await openedThread).status()).toBe(200)
        await expect(memberPage.getByText(headerFacts, { exact: true })).toBeVisible()
        await expect(memberPage.getByRole('textbox', { name: 'Write a message…', exact: true })).toBeVisible()
      }
    }
    await verifyAccess(false)
    const assignedMember = { assigned_member_id: actor.id, assigned_team_id: null }
    const memberSaved = await page.request.patch(locationPath, { params: { org }, data: assignedMember })
    expect(memberSaved.status(), await memberSaved.text()).toBe(200)
    expect(await readAssignment()).toMatchObject(assignedMember)
    await verifyAccess(true)

    const created = await page.request.post('/api/auth/organization/create-team', { headers: authRequestHeaders(baseURL!), data: { organizationId, name: `E2E Branch Inbox ${Date.now()}` } })
    expect(created.status(), await created.text()).toBe(200)
    teamId = (await created.json() as { id: string }).id
    const included = await page.request.post('/api/auth/organization/add-team-member', { headers: authRequestHeaders(baseURL!), data: { organizationId, teamId, userId: actor.userId } })
    expect(included.status(), await included.text()).toBe(200)
    const membership = await memberRequest.get('/api/auth/organization/list-team-members', { params: { teamId } })
    expect(membership.status(), await membership.text()).toBe(200)
    expect((await membership.json() as Array<{ userId: string }>).map(member => member.userId)).toContain(actor.userId)
    const assignedTeam = { assigned_member_id: null, assigned_team_id: teamId }
    const teamSaved = await page.request.patch(locationPath, { params: { org }, data: assignedTeam })
    expect(teamSaved.status(), await teamSaved.text()).toBe(200)
    expect(await readAssignment()).toMatchObject(assignedTeam)
    await verifyAccess(true)
    const socket = sockets.findLast(socket => !socket.isClosed() && new URL(socket.url()).pathname === '/api/dashboard/guest-inbox/socket')
    expect(socket, 'The open guest conversation has a live dashboard socket').toBeDefined()
    if (!socket) throw new Error('The assigned member has no live dashboard socket')
    const accessChanged = socket.waitForEvent('framereceived', { predicate: frame => {
      if (frame.payload === 'pong') return false
      const event: unknown = JSON.parse(String(frame.payload))
      return isDashboardInvalidation(event) && event.type === 'access.changed' && event.organizationId === organizationId
    } })
    const cleared = await page.request.patch(locationPath, { params: { org }, data: { assigned_member_id: null, assigned_team_id: null } })
    expect(cleared.status(), await cleared.text()).toBe(200)
    await accessChanged
    // Revocation clears the conversation already on screen before any fresh navigation or member reads.
    await expect(memberPage.getByText(guestName, { exact: true })).toHaveCount(0)
    await expect(memberPage.getByText(headerFacts, { exact: true })).toHaveCount(0)
    await expect(memberPage.getByRole('textbox', { name: 'Write a message…', exact: true })).toHaveCount(0)
    await expect(memberPage.locator(`[data-thread-row="${reservationId}"]`)).toHaveCount(0)
    await expect(memberPage.getByText('This conversation is no longer available', { exact: true })).toBeVisible()
    expect(await readAssignment()).toMatchObject({ assigned_member_id: null, assigned_team_id: null })
    await verifyAccess(false)
  } catch (error) {
    failures.push(error)
  } finally {
    try {
      if (reservationId) {
        const cancelled = await page.request.post(`${inboxPath}/${reservationId}/operations/cancel`, { data: { idempotencyKey: crypto.randomUUID() } })
        expect(cancelled.status(), await cancelled.text()).toBe(200)
        const read = await page.request.get(`/api/dashboard/bookings/reservation/${reservationId}`, { params: { org } })
        expect(read.status(), await read.text()).toBe(200)
        expect((await read.json() as { booking: DashboardBookingDetails }).booking).toMatchObject({ id: reservationId, status: 'cancelled' })
      }
    } catch (error) { failures.push(error) }
    try {
      if (original) {
        const restored = await page.request.patch(locationPath, { params: { org }, data: { assigned_member_id: original.assigned_member_id, assigned_team_id: original.assigned_team_id } })
        expect(restored.status(), await restored.text()).toBe(200)
        expect(await readAssignment()).toMatchObject({ assigned_member_id: original.assigned_member_id, assigned_team_id: original.assigned_team_id })
      }
    } catch (error) { failures.push(error) }
    try {
      if (teamId) {
        const removed = await page.request.post('/api/auth/organization/remove-team', { headers: authRequestHeaders(baseURL!), data: { organizationId, teamId } })
        expect(removed.status(), await removed.text()).toBe(200)
        const teams = await page.request.get('/api/auth/organization/list-teams', { params: { organizationId } })
        expect(teams.status(), await teams.text()).toBe(200)
        expect((await teams.json() as Array<{ id: string }>).map(team => team.id).sort()).toEqual(originalTeamIds)
      }
    } catch (error) { failures.push(error) }
    try {
      if (actor) {
        const restored = await page.request.post('/api/auth/organization/update-member-role', { headers: authRequestHeaders(baseURL!), data: { organizationId, memberId: actor.id, role: actor.role } })
        expect(restored.status(), await restored.text()).toBe(200)
        const members = await page.request.get('/api/dashboard/members', { params: { org } })
        expect(members.status(), await members.text()).toBe(200)
        expect((await members.json() as { members: Member[] }).members.find(member => member.id === actor!.id)?.role).toBe(actor.role)
      }
    } catch (error) { failures.push(error) }
    try { await memberContext?.close() } catch (error) { failures.push(error) }
    try { await release() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Branch reservation access workflow or restoration failed')
})

test('continuous recommendations follow explicit strategy, feedback and actual publication without a reload', async ({ page, baseURL }, testInfo) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Priorities, drafts and decisions use disposable local data only')
  test.setTimeout(180_000)
  const organizationId = seededTenant('restaurant').organizationId
  const release = await acquireTenantMutationLock(testInfo, organizationId)
  const marker = `Lanternfish${Date.now()}`
  const editor = `/api/editor/organizations/${organizationId}/blog`
  let goal: { id: string; revision: string } | null = null
  let postId: string | null = null
  let categoryId: string | null = null
  const readToday = async () => {
    const response = await page.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo' } })
    expect(response.status(), await response.text()).toBe(200)
    return response.json() as Promise<TodayFeedPayload>
  }
  const businessChange = (socket: WebSocket) => socket.waitForEvent('framereceived', { predicate: frame => {
    if (typeof frame.payload !== 'string' || frame.payload === 'pong') return false
    const event: unknown = JSON.parse(frame.payload)
    return isDashboardInvalidation(event) && event.type === 'business.changed' && event.organizationId === organizationId
  } })
  try {
    await loginAs(page.request, baseURL!)
    await dismissPreviewToolbar(page)
    const category = await page.request.post(`${editor}/categories`, { data: { name: marker, collection: 'blog' } })
    expect(category.status(), await category.text()).toBe(201)
    categoryId = (await category.json() as { category: { id: string } }).category.id
    const created = await page.request.post(`${editor}/posts`, { data: { idempotency_key: crypto.randomUUID(), title: `${marker} supper club announcement`, category_id: categoryId,
      excerpt: 'Our monthly supper club returns.', content_blocks: [{ type: 'markdown', data: { markdown: 'Our monthly supper club returns.', editor_mode: 'rich' } }] } })
    expect(created.status(), await created.text()).toBe(200)
    const article = (await created.json() as { post: { id: string; updated_at: string } }).post
    postId = article.id
    const beforeGoal = await readToday()
    const suggestion = beforeGoal.cards.find(card => card.decision?.operation === 'article.publish' && card.decision.subjectId === postId)
    expect(suggestion, 'A real draft is useful marketing before the owner saves a matching-text priority').toBeDefined()
    expect(suggestion!.presentation.type).toBe('compact')
    const card = page.locator(`[data-card-id="${suggestion!.id}"]`)
    const socketOpened = page.waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname === '/api/dashboard/guest-inbox/socket' })
    expect((await page.goto(ORG))?.status()).toBe(200)
    await socketOpened
    await waitForNuxtHydration(page)
    await expect(card).toBeVisible()
    // The actual rendered list remains one column at desktop and mobile sizes.
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      const cards = page.getByTestId('today-list').getByTestId('today-card')
      const count = await cards.count()
      expect(count).toBeGreaterThan(1)
      const boxes = await Promise.all(Array.from({ length: count }, (_, index) => cards.nth(index).boundingBox()))
      for (let index = 1; index < boxes.length; index++) {
        expect(boxes[index]!.x).toBeCloseTo(boxes[0]!.x, 0)
        expect(boxes[index]!.width).toBeCloseTo(boxes[0]!.width, 0)
        expect(boxes[index]!.y).toBeGreaterThanOrEqual(boxes[index - 1]!.y + boxes[index - 1]!.height)
      }
      await page.screenshot({ path: testInfo.outputPath(`single-column-${viewport.width}.png`), fullPage: true, animations: 'disabled' })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    const [cardTelemetry] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard/telemetry' && response.request().postDataJSON()?.action === 'today_card_click'),
      card.click(),
    ])
    expect(cardTelemetry.status(), await cardTelemetry.text()).toBe(200)
    expect(new URL(cardTelemetry.url()).searchParams.get('org')).toBe('ember-slice-demo')
    await expect(page).toHaveURL(`${ORG}/website/blog/${postId}`)
    expect((await page.goto(ORG))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const priorities = page.getByTestId('today-priorities')
    await expect(priorities).toBeVisible()
    await priorities.getByText('Business goals', { exact: true }).click()

    // The owner chooses channels explicitly; unrelated intent wording is not a relevance algorithm.
    // Lose the acknowledgement after the actual goal and invalidation commit.
    await page.route(`**/api/organizations/${organizationId}/goals`, async route => {
      const committed = await route.fetch()
      expect(committed.status(), await committed.text()).toBe(201)
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'The goal was saved but its acknowledgement was lost', data: { committed: true } }) })
    }, { times: 1 })
    const goalSaved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/organizations/${organizationId}/goals`)

    const intent = `Help prospective guests choose us ${marker}`
    await priorities.getByRole('textbox', { name: 'New priority', exact: true }).fill(intent)
    await priorities.getByText('Choose related work (optional)', { exact: true }).click()
    await priorities.getByRole('checkbox', { name: 'Blog articles', exact: true }).check()
    await priorities.getByRole('checkbox', { name: 'Social posts', exact: true }).check()
    await priorities.getByRole('button', { name: 'Add', exact: true }).click()
    const lost = await goalSaved
    expect(lost.status()).toBe(503)
    await expect(priorities.getByRole('textbox', { name: 'New priority', exact: true })).toHaveValue(intent)
    const committedGoals = (await readToday()).priorities!.filter(value => value.intent === intent)
    expect(committedGoals).toHaveLength(1)
    goal = committedGoals[0]!
    const retried = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/organizations/${organizationId}/goals`)
    await priorities.getByRole('button', { name: 'Add', exact: true }).click()
    const saved = await retried
    expect(saved.status(), await saved.text()).toBe(201)
    expect(saved.request().postDataJSON().idempotencyKey).toBe(lost.request().postDataJSON().idempotencyKey)
    expect((await readToday()).priorities!.filter(value => value.intent === intent)).toHaveLength(1)

    goal = (await saved.json() as { goal: { id: string; revision: string } }).goal
    expect(goal.id).toBe(committedGoals[0]!.id)
    const savedFeed = await readToday()
    expect(savedFeed.priorities?.find(value => value.id === goal!.id)?.strategy).toMatchObject({ channels: ['blog', 'social'] })
    await expect(priorities.getByTestId('today-priority')).toContainText([intent])
    await expect(card).toHaveAttribute('href', `${ORG}/website/blog/${postId}`)
    const item = card.locator('xpath=..')
    await expect(card).toHaveAttribute('data-card-presentation', 'detailed')
    await expect(card.locator('.quest-card__art .iconify')).toBeVisible()
    expect(await card.locator('.quest-card__art .iconify').evaluate(element => getComputedStyle(element).maskImage)).not.toBe('none')
    await item.getByRole('button', { name: `Options for ${suggestion!.headline}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Why this recommendation', exact: true }).click()
    await expect(page.getByTestId('today-card-reason')).toContainText(intent)
    await page.getByRole('dialog', { name: 'About this recommendation', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()

    await item.getByRole('button', { name: `Options for ${suggestion!.headline}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Later', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Come back to this later', exact: true })
    await expect(dialog).toBeVisible()
    const future = localNow(Intl.DateTimeFormat().resolvedOptions().timeZone, new Date(Date.now() + 2 * 86_400_000))
    const deferUntil = new Date(`${future.date}T${future.time}`).toISOString()
    await dialog.locator('input[type="datetime-local"]').fill(`${future.date}T${future.time}`)
    const deferred = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/recommendation-feedback'))
    await dialog.getByRole('button', { name: 'Set aside', exact: true }).click()
    expect((await deferred).status()).toBe(200)
    await expect(card).toHaveCount(0)
    await page.reload()
    await waitForNuxtHydration(page)
    await expect(card).toHaveCount(0)
    await page.getByRole('tab', { name: 'Upcoming', exact: true }).click()
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-card-priority', 'schedule')
    await expect(card.getByText(formatTimestamp(deferUntil, 'en', seededTenant('restaurant').timezone, { dateStyle: 'medium', timeStyle: 'short' }), { exact: true })).toBeVisible()
    const plannedFeed = await page.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo', range: 'upcoming',
      from: localDateAt(new Date(Date.parse(deferUntil) - 86_400_000), seededTenant('restaurant').timezone),
      to: localDateAt(new Date(Date.parse(deferUntil) + 86_400_000), seededTenant('restaurant').timezone) } })
    expect(plannedFeed.status(), await plannedFeed.text()).toBe(200)
    expect((await plannedFeed.json() as TodayFeedPayload).cards.find(value => value.id === suggestion!.id)).toMatchObject({ priority: 'schedule', actionAt: deferUntil })
    const dismissed = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/recommendation-feedback'))
    await item.getByRole('button', { name: `Options for ${suggestion!.headline}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Dismiss', exact: true }).click()
    expect((await dismissed).status()).toBe(200)
    await expect(card).toHaveCount(0)
    await page.getByRole('tab', { name: 'Today', exact: true }).click()
    await expect(card).toHaveCount(0)
    const unchanged = await page.request.get(`${editor}/${postId}`)
    expect(unchanged.status(), await unchanged.text()).toBe(200)
    expect((await unchanged.json() as { post: { status: string; updated_at: string } }).post).toMatchObject({ status: 'draft', updated_at: article.updated_at })

    // A separate writer changes canonical evidence; the still-open dashboard receives its real invalidation.
    const activeSocket = page.waitForEvent('websocket', { predicate: candidate => new URL(candidate.url()).pathname === '/api/dashboard/guest-inbox/socket' })
    // Reload above created a replacement socket; opening a fresh page read also reconciles its initial gap.
    await page.reload()
    const currentSocket = await activeSocket
    await waitForNuxtHydration(page)
    await currentSocket.waitForEvent('framereceived', { predicate: frame => frame.payload === 'pong', timeout: 30_000 })
    const editedEvent = businessChange(currentSocket)
    const edited = await page.request.patch(`${editor}/${postId}`, { data: { expected_updated_at: article.updated_at, excerpt: 'Our supper club returns with a seasonal dinner menu.' } })
    expect(edited.status(), await edited.text()).toBe(200)
    const editedArticle = (await edited.json() as { post: { updated_at: string } }).post
    await editedEvent
    await expect(card).toBeVisible()
    await item.getByRole('button', { name: `Options for ${suggestion!.headline}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Why this recommendation', exact: true }).click()
    await expect(page.getByTestId('today-card-reason')).toContainText('dismissed')
    await page.getByRole('dialog', { name: 'About this recommendation', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('continuous-growth-before-publication.png'), fullPage: true, animations: 'disabled' })

    // Complete it from another surface while its deferred card is open in Upcoming.
    await item.getByRole('button', { name: `Options for ${suggestion!.headline}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Later', exact: true }).click()
    await dialog.locator('input[type="datetime-local"]').fill(`${future.date}T${future.time}`)
    const plannedAgain = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/recommendation-feedback'))
    await dialog.getByRole('button', { name: 'Set aside', exact: true }).click()
    expect((await plannedAgain).status()).toBe(200)
    await expect(card).toHaveCount(0)
    await page.getByRole('tab', { name: 'Upcoming', exact: true }).click()
    await expect(card).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('upcoming-before-publication.png'), fullPage: true, animations: 'disabled' })

    const publishedEvent = businessChange(currentSocket)
    const published = await page.request.post(`${editor}/${postId}/publish`, { data: { expected_updated_at: editedArticle.updated_at } })
    expect(published.status(), await published.text()).toBe(200)
    const readBack = await page.request.get(`${editor}/${postId}`)
    expect(readBack.status(), await readBack.text()).toBe(200)
    expect((await readBack.json() as { post: { status: string } }).post.status).toBe('published')
    await publishedEvent
    await expect(card).toHaveCount(0)
    const after = await readToday()
    expect(after.cards.some(value => value.decision?.operation === 'article.publish' && value.decision.subjectId === postId)).toBe(false)
    const next = after.cards.find(value => value.decision && ['article.create', 'article.distribute', 'post.create', 'social.connect'].includes(value.decision.operation))
    expect(next, 'Publication makes the next useful growth action available in the same session').toBeDefined()
    await page.getByRole('tab', { name: 'Today', exact: true }).click()
    const nextCard = page.locator(`[data-card-id="${next!.id}"]`)
    await expect(nextCard).toBeVisible()
    await expect(nextCard).toHaveAttribute('data-card-presentation', 'opportunity')
    await nextCard.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('continuous-growth-after-publication.png'), fullPage: true, animations: 'disabled' })
  } finally {
    try {
      if (goal) {
        const current = (await readToday()).priorities?.find(priority => priority.id === goal!.id)
        if (current) expect((await page.request.patch(`/api/organizations/${organizationId}/goals/${goal.id}`, { data: { revision: current.revision, status: 'archived' } })).status()).toBe(200)
      }
      if (postId) expect((await page.request.delete(`${editor}/${postId}`)).status()).toBe(200)
      if (categoryId) expect((await page.request.delete(`${editor}/categories/${categoryId}`)).status()).toBe(200)
    } finally { await release() }
  }
})
