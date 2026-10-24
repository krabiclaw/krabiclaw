import { expect, test, type BrowserContext } from '@playwright/test'
import { loginAs, authRequestHeaders } from './helpers/auth'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { tenantTestExtraHeaders } from './test-env'
import type { TodayFeedPayload } from '../../shared/dashboard-today'
import type { AgendaPayload } from '../../server/utils/dashboard-agenda'
import type { DashboardBookingDetails } from '../../server/utils/dashboard-booking-details'
import type { GuestThreadDetailViewModel, GuestThreadListPage } from '../../server/domain/guest-threads/types'

const ORG = '/dashboard/ember-slice-demo'

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
        ? await page.goto(`${ORG}?locationId=loc-demo&range=upcoming`)
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
      await expect(page.getByRole('heading', { name: 'Your upcoming schedule', exact: true })).toBeVisible()
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
  await expect(page).toHaveURL(url => url.searchParams.get('locationId') === 'loc-demo' && url.searchParams.get('range') === 'upcoming')
  await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await expect(page).toHaveURL(url => url.searchParams.get('locationId') === 'loc-demo' && url.searchParams.get('range') === 'upcoming')
  await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('tab', { name: 'Today', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('locationId') === 'loc-demo' && url.searchParams.get('range') !== 'upcoming')
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true')
})

test('an assigned member receives no owner work or unassigned restaurant work', async ({ page, browser, baseURL }, testInfo) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Role changes use disposable local actors only')
  const release = await acquireTenantMutationLock(testInfo, 'org-demo')
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
      headers: authRequestHeaders(baseURL!), data: { organizationId: 'org-demo', memberId: actor!.id, role: 'member' },
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
    await expect(memberPage.getByText('Nothing needs your attention today', { exact: true })).toBeVisible()
    await expect(memberPage.getByTestId('today-card')).toHaveCount(0)
  } finally {
    try {
      const restored = await page.request.post('/api/auth/organization/update-member-role', {
        headers: authRequestHeaders(baseURL!), data: { organizationId: 'org-demo', memberId: actor!.id, role: actor!.role },
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
  const release = await acquireTenantMutationLock(testInfo, 'org-demo')
  const org = 'ember-slice-demo'
  const organizationId = 'org-demo'
  const locationId = 'loc-demo'
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
    expect(original).toMatchObject({ assigned_member_id: null, assigned_team_id: null })
    const members = await page.request.get('/api/dashboard/members', { params: { org } })
    expect(members.status(), await members.text()).toBe(200)
    actor = (await members.json() as { members: Member[] }).members.find(member => member.userId === 'user-e2e-demo-role-owner')
    expect(actor, 'The canonical role actor already belongs to the demo tenant').toBeDefined()
    if (!actor) throw new Error('The canonical demo role actor is missing')
    const teams = await page.request.get('/api/auth/organization/list-teams', { params: { organizationId } })
    expect(teams.status(), await teams.text()).toBe(200)
    originalTeamIds = (await teams.json() as Array<{ id: string }>).map(team => team.id).sort()

    const availability = await request.get('/api/public/reservations/availability', {
      headers: tenantTestExtraHeaders(), params: { location_id: locationId, date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), days: 7 },
    })
    expect(availability.status(), await availability.text()).toBe(200)
    const calendar = await availability.json() as { timezone: string; dates: Array<{ date: string; slots: Array<{ time_slot: string; starts_at: string; is_closed: boolean; is_full: boolean; remaining: number | null }> }> }
    const day = calendar.dates.find(day => day.slots.some(slot => !slot.is_closed && !slot.is_full && (slot.remaining === null || slot.remaining >= 2)))
    const slot = day?.slots.find(slot => !slot.is_closed && !slot.is_full && (slot.remaining === null || slot.remaining >= 2))
    expect(slot, 'The existing demo reservation policy and hours expose a future table for two').toBeDefined()
    if (!day || !slot) throw new Error('The existing demo location has no future table for two')
    const guestName = `Branch${Date.now()} Guest`
    const booked = await request.post('/api/public/reservations', { headers: tenantTestExtraHeaders(), data: {
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
    expect((await ownerThread.json() as { thread: GuestThreadDetailViewModel }).thread).toMatchObject({ id: reservationId, guestName, submissionType: 'reservation', source: { operationalStatus: 'confirmed', fields: { startsAt: slot.starts_at, partySize: 2 } } })

    const changed = await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId, memberId: actor.id, role: 'member' },
    })
    expect(changed.status(), await changed.text()).toBe(200)
    await loginAs(memberRequest, baseURL!, actor.userId)
    const memberPage = await memberContext.newPage()
    await dismissPreviewToolbar(memberPage)
    const verifyAccess = async (assigned: boolean) => {
      for (const range of ['today', 'upcoming'] as const) {
        const response = await memberRequest.get('/api/dashboard/today', { params: { org, range, ...(range === 'upcoming' ? { from: day.date, to: day.date } : {}) } })
        expect(response.status(), await response.text()).toBe(200)
        const feed = await response.json() as TodayFeedPayload
        const id = `${range === 'today' ? 'attention' : 'reservation'}:${reservationId}`
        if (assigned) {
          expect(feed.cards.find(card => card.id === id)).toMatchObject({ id, to: destination, priority: range === 'today' ? 'attention' : 'schedule', locationId, bookingKind: 'reservation', occurrenceAt: slot.starts_at, timeZone: calendar.timezone })
          expect(feed.locations.map(location => location.id)).toContain(locationId)
        } else expect(feed.cards.some(card => card.id === id)).toBe(false)
      }
      const agendaResponse = await memberRequest.get('/api/dashboard/agenda', { params: { org, from: day.date, to: day.date } })
      expect(agendaResponse.status(), await agendaResponse.text()).toBe(200)
      const agenda = await agendaResponse.json() as AgendaPayload
      if (assigned) expect(agenda.items.find(item => item.requestId === reservationId)).toMatchObject({ id: `reservation:${reservationId}`, kind: 'reservation', requestId: reservationId, locationId, title: guestName, status: 'confirmed', startsAt: slot.starts_at, to: destination })
      else expect(agenda.items.some(item => item.requestId === reservationId)).toBe(false)
      for (const path of [inboxPath, '/api/dashboard/guest-threads']) {
        const response = await memberRequest.get(path, { params: { org, location_id: locationId, type: 'reservation' } })
        expect(response.status(), await response.text()).toBe(200)
        const { threads } = await response.json() as GuestThreadListPage
        if (assigned) expect(threads.find(thread => thread.id === reservationId)).toMatchObject({ id: reservationId, guestName, locationId, submissionType: 'reservation', operationalStatus: 'confirmed', occurrenceAt: slot.starts_at })
        else expect(threads.some(thread => thread.id === reservationId)).toBe(false)
      }
      const detail = await memberRequest.get(`${inboxPath}/${reservationId}`)
      expect(detail.status(), await detail.text()).toBe(assigned ? 200 : 404)
      const record = await memberRequest.get(bookingPath, { params: { org } })
      expect(record.status(), await record.text()).toBe(assigned ? 200 : 404)
      if (assigned) {
        expect((await detail.json() as { thread: GuestThreadDetailViewModel }).thread).toMatchObject({ id: reservationId, guestName, source: { operationalStatus: 'confirmed' } })
        expect((await record.json() as { booking: DashboardBookingDetails }).booking).toMatchObject({ id: reservationId, threadId: reservationId, guestName, locationId, status: 'confirmed' })
        expect((await memberPage.goto(`${ORG}?range=upcoming`))?.status()).toBe(200)
        await waitForNuxtHydration(memberPage)
        await expect(memberPage.locator(`[data-card-id="reservation:${reservationId}"]`)).toHaveAttribute('href', `${destination}?range=upcoming`)
        await memberPage.getByRole('tab', { name: 'Today', exact: true }).click()
        await expect(memberPage.locator(`[data-card-id="attention:${reservationId}"]`)).toHaveAttribute('href', destination)
        expect((await memberPage.goto(`${ORG}/messages/${reservationId}`))?.status()).toBe(200)
        await expect(memberPage.locator(`[data-thread-row="${reservationId}"]`)).toContainText(guestName)
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
    const cleared = await page.request.patch(locationPath, { params: { org }, data: { assigned_member_id: null, assigned_team_id: null } })
    expect(cleared.status(), await cleared.text()).toBe(200)
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
