import { expect, test, type BrowserContext, type WebSocket } from '@playwright/test'
import { loginAs, authRequestHeaders } from './helpers/auth'
import { dismissPreviewToolbar } from './helpers'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededSiteHeaders } from './test-env'
import { seededTenant } from './seed/manifest'
import type { TaskPerson, TaskSection, TaskView } from '../../server/domain/tasks'
import type { OpportunityView } from '../../server/domain/opportunities'
import type { BusinessGoal } from '../../shared/business-progress'
import type { AgendaPayload } from '../../server/utils/dashboard-agenda'
import type { DashboardBookingDetails } from '../../server/utils/dashboard-booking-details'
import type { InboxListPage, InboxThread } from '../../server/domain/guest-threads/types'
import { isDashboardInvalidation } from '../../shared/dashboard-invalidations'

const ORG = '/dashboard/ember-slice-demo'

/** GET /api/dashboard/today: the business's stored tasks and, for a manager, its opportunities. */
type BusinessToday = { tasks: TaskSection[]; opportunities: OpportunityView[]; opportunityIssues: string[]; assignees: TaskPerson[]; resolvedAt: string }

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

    // The unanswered inquiry is one open reply task on Today; the scheduled sends are Inbox automation, not tasks.
    const replyTasks = async (range: 'today' | 'upcoming') => {
      const read = await page.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo', range } })
      expect(read.status(), await read.text()).toBe(200)
      return (await read.json() as BusinessToday).tasks.map(section => ({ section: section.id, tasks: section.tasks.filter(task => task.requestId === threadId) })).filter(section => section.tasks.length)
    }
    const todayReplies = await replyTasks('today')
    expect((await page.goto(ORG))?.status()).toBe(200)
    const replyCard = page.getByTestId('today-task').filter({ hasText: marker })
    const replyLink = replyCard.getByRole('link', { name: marker, exact: true })
    await expect(replyLink).toHaveAttribute('href', `${ORG}/messages/${threadId}`)
    await replyLink.click()
    await expect(page).toHaveURL(new RegExp(`/messages/${threadId}(?:[?#]|$)`))

    expect(todayReplies).toEqual([{ section: 'open', tasks: [expect.objectContaining({
      kind: 'guest_reply', status: 'open', title: marker, detail: 'Can you accommodate a group for dinner next week?', requestId: threadId, startsAt: null, dueAt: null,
      action: { type: 'open', label: 'Reply', path: `${ORG}/messages/${threadId}` },
    })] }])
    const replyTask = todayReplies[0]!.tasks[0]!
    expect(await replyTasks('upcoming')).toEqual([])
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
    // Cancelling a scheduled send answers nothing: the question is still owed.
    expect(await replyTasks('upcoming')).toEqual([])
    expect(await replyTasks('today')).toEqual([{ section: 'open', tasks: [expect.objectContaining({ id: replyTask.id, status: 'open', version: replyTask.version })] }])
    // The same task read through the tasks route.
    const taskRead = await page.request.get(`/api/organizations/${organizationId}/tasks/${replyTask.id}`)
    expect(taskRead.status(), await taskRead.text()).toBe(200)
    expect((await taskRead.json() as { task: TaskView }).task).toMatchObject({ id: replyTask.id, kind: 'guest_reply', status: 'open', requestId: threadId, can: { complete: false }, dismiss: { label: 'Dismiss', card: true } })
    // A reply task closes with its subject, not with Done.
    const refused = await page.request.post(`/api/organizations/${organizationId}/tasks/${replyTask.id}/complete`, { data: {} })
    expect(refused.status(), await refused.text()).toBe(409)
    expect(await refused.json()).toMatchObject({ data: { code: 'TASK_CLOSES_WITH_SUBJECT' } })
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
    const ownerFeed = await ownerResponse.json() as BusinessToday
    expect(ownerFeed.tasks.length + ownerFeed.opportunities.length, 'The owner sees organization-wide work the member must not').toBeGreaterThan(0)
    expect(ownerFeed.assignees.map(person => person.id)).toContain(actor!.id)
    const changed = await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId: seededTenant('restaurant').organizationId, memberId: actor!.id, role: 'member' },
    })
    expect(changed.status(), await changed.text()).toBe(200)
    await loginAs(memberContext.request, baseURL!, actor!.userId)
    const memberFeed = await memberContext.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo' } })
    expect(memberFeed.status(), await memberFeed.text()).toBe(200)
    expect(await memberFeed.json()).toEqual({ tasks: [], opportunities: [], opportunityIssues: [], assignees: [], resolvedAt: expect.any(String) })
    // Opportunities are the owner's decisions; the member cannot read or take one.
    const memberOpportunities = await memberContext.request.get(`/api/organizations/${seededTenant('restaurant').organizationId}/opportunities`)
    expect(memberOpportunities.status(), await memberOpportunities.text()).toBe(403)
    if (ownerFeed.opportunities.length) {
      const taken = await memberContext.request.post(`/api/organizations/${seededTenant('restaurant').organizationId}/opportunities/${ownerFeed.opportunities[0]!.id}/accept`, { data: {} })
      expect(taken.status(), await taken.text()).toBe(403)
    }
    const denied = await memberContext.request.get('/api/dashboard/analytics', { params: { org: 'ember-slice-demo' } })
    // Organization-wide surfaces deliberately conceal denied scope with 404.
    expect(denied.status()).toBe(404)
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
      // A confirmed reservation is a Calendar commitment, not a task: neither Today nor Upcoming lists it.
      for (const range of ['today', 'upcoming'] as const) {
        const feedResponse = await memberRequest.get('/api/dashboard/today', { params: { org, range } })
        expect(feedResponse.status(), await feedResponse.text()).toBe(200)
        expect((await feedResponse.json() as BusinessToday).tasks.flatMap(section => section.tasks).filter(task => task.requestId === reservationId)).toEqual([])
      }
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

test('opportunities follow explicit strategy, the owner’s decisions and actual publication', async ({ page, baseURL }, testInfo) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Priorities, drafts and decisions use disposable local data only')
  test.setTimeout(180_000)
  const organizationId = seededTenant('restaurant').organizationId
  const release = await acquireTenantMutationLock(testInfo, organizationId)
  const marker = `Lanternfish${Date.now()}`
  const editor = `/api/editor/organizations/${organizationId}/blog`
  const tasksApi = `/api/organizations/${organizationId}`
  let goal: { id: string; revision: string } | null = null
  let postId: string | null = null
  let categoryId: string | null = null
  const readToday = async () => {
    const response = await page.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo' } })
    expect(response.status(), await response.text()).toBe(200)
    return response.json() as Promise<BusinessToday>
  }
  const readGoals = async () => {
    const response = await page.request.get(`${tasksApi}/progress`, { params: { limit: 1 } })
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { goals: BusinessGoal[] }).goals
  }
  const listOpportunities = async () => {
    const response = await page.request.get(`${tasksApi}/opportunities`)
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { opportunities: OpportunityView[]; issues: string[] }).opportunities
  }
  try {
    await loginAs(page.request, baseURL!)
    const category = await page.request.post(`${editor}/categories`, { data: { name: marker, collection: 'blog' } })
    expect(category.status(), await category.text()).toBe(201)
    categoryId = (await category.json() as { category: { id: string } }).category.id
    const title = `${marker} supper club announcement`
    const created = await page.request.post(`${editor}/posts`, { data: { idempotency_key: crypto.randomUUID(), title, category_id: categoryId,
      excerpt: 'Our monthly supper club returns.', content_blocks: [{ type: 'markdown', data: { markdown: 'Our monthly supper club returns.', editor_mode: 'rich' } }] } })
    expect(created.status(), await created.text()).toBe(200)
    const article = (await created.json() as { post: { id: string; updated_at: string } }).post
    postId = article.id
    const blogPath = `${ORG}/website/blog/${postId}`
    // The opportunity for this draft, found by where it is done; Today and the opportunities route agree on it.
    const draftOpportunity = async () => {
      const today = (await readToday()).opportunities.filter(value => value.path === blogPath)
      const listed = (await listOpportunities()).filter(value => value.path === blogPath)
      expect(today).toEqual(listed)
      expect(today.length, 'one opportunity per draft').toBeLessThanOrEqual(1)
      return today[0]
    }

    const beforeGoal = await draftOpportunity()
    expect(beforeGoal, 'A real draft is useful marketing before the owner saves a matching priority').toMatchObject({ statusLine: 'Website', title: `Publish “${title}”`, icon: 'i-lucide-file-pen-line' })
    expect(beforeGoal!.detail).not.toContain('Your strategy')

    // The owner chooses channels explicitly; unrelated intent wording is not a relevance algorithm.
    const intent = `Help prospective guests choose us ${marker}`
    const goalRequest = { idempotencyKey: crypto.randomUUID(), intent, strategy: { channels: ['blog', 'social'], payments: false, availability: false } }
    const saved = await page.request.post(`${tasksApi}/goals`, { data: goalRequest })
    expect(saved.status(), await saved.text()).toBe(201)
    goal = (await saved.json() as { goal: { id: string; revision: string } }).goal
    expect((await readGoals()).find(value => value.id === goal!.id)?.strategy).toMatchObject({ channels: ['blog', 'social'] })
    // The strategy is now the opportunity's reason, recorded as a new opportunity for the new goal.
    const withGoal = await draftOpportunity()
    expect(withGoal).toMatchObject({ statusLine: 'Website', title: `Publish “${title}”`, detail: expect.stringContaining(`Your strategy: ${intent}`) })
    expect(withGoal!.id).not.toBe(beforeGoal!.id)

    // Later: set aside until tomorrow; it leaves Today while it waits.
    const until = new Date(Date.now() + 86_400_000).toISOString()
    const deferred = await page.request.post(`${tasksApi}/opportunities/${withGoal!.id}/defer`, { data: { until } })
    expect(deferred.status(), await deferred.text()).toBe(200)
    expect(await deferred.json()).toEqual({ opportunity: { id: withGoal!.id, availableAt: until } })
    expect(await draftOpportunity()).toBeUndefined()
    const pastDeferral = await page.request.post(`${tasksApi}/opportunities/${withGoal!.id}/defer`, { data: { until: new Date(Date.now() - 60_000).toISOString() } })
    expect(pastDeferral.status(), await pastDeferral.text()).toBe(422)
    // Deciding wrote nothing to the draft.
    const unchanged = await page.request.get(`${editor}/${postId}`)
    expect(unchanged.status(), await unchanged.text()).toBe(200)
    expect((await unchanged.json() as { post: { status: string; updated_at: string } }).post).toMatchObject({ status: 'draft', updated_at: article.updated_at })

    // A separate writer changes the draft: the changed evidence is a new opportunity, which the deferral of the old evidence does not hide.
    const edit = async (expectedUpdatedAt: string, excerpt: string) => {
      const edited = await page.request.patch(`${editor}/${postId}`, { data: { expected_updated_at: expectedUpdatedAt, excerpt } })
      expect(edited.status(), await edited.text()).toBe(200)
      return (await edited.json() as { post: { updated_at: string } }).post
    }
    const firstEdit = await edit(article.updated_at, 'Our supper club returns with a seasonal dinner menu.')
    const afterEdit = await draftOpportunity()
    expect(afterEdit).toMatchObject({ title: `Publish “${title}”`, detail: expect.stringContaining(`Your strategy: ${intent}`) })
    expect(afterEdit!.id).not.toBe(withGoal!.id)

    // Dismiss: gone while the evidence is unchanged, and a decided opportunity cannot be decided again.
    const dismissed = await page.request.post(`${tasksApi}/opportunities/${afterEdit!.id}/dismiss`, { data: { note: 'Not this week.' } })
    expect(dismissed.status(), await dismissed.text()).toBe(200)
    expect(await dismissed.json()).toEqual({ opportunity: { id: afterEdit!.id, status: 'dismissed' } })
    expect(await draftOpportunity()).toBeUndefined()
    const redecided = await page.request.post(`${tasksApi}/opportunities/${afterEdit!.id}/accept`, { data: {} })
    expect(redecided.status(), await redecided.text()).toBe(409)
    expect(await redecided.json()).toMatchObject({ data: { code: 'OPPORTUNITY_DECIDED' } })

    // New evidence again: accept it, and it is the owner's task due today.
    const editedArticle = await edit(firstEdit.updated_at, 'Our supper club returns with a seasonal dinner menu and live music.')
    const toAccept = await draftOpportunity()
    expect(toAccept!.id).not.toBe(afterEdit!.id)
    const accepted = await page.request.post(`${tasksApi}/opportunities/${toAccept!.id}/accept`, { data: {} })
    expect(accepted.status(), await accepted.text()).toBe(201)
    const { task: acceptedTask } = await accepted.json() as { task: TaskView }
    expect(await draftOpportunity()).toBeUndefined()
    const taskRead = await page.request.get(`${tasksApi}/tasks/${acceptedTask.id}`)
    expect(taskRead.status(), await taskRead.text()).toBe(200)
    expect((await taskRead.json() as { task: TaskView }).task).toMatchObject({
      id: acceptedTask.id, kind: 'opportunity', status: 'open', statusLine: 'Accepted opportunity', title: `Publish “${title}”`,
      assignee: { type: 'member', name: 'You', you: true }, dueAt: expect.any(String), action: { type: 'complete', label: 'Done' },
      can: { complete: true, skip: true, reopen: false, assign: true, edit: true }, dismiss: { label: 'Skip', card: false },
    })
    expect((await readToday()).tasks.find(section => section.id === 'open')?.tasks.map(task => task.id)).toContain(acceptedTask.id)

    // Publishing from another surface is the work the task asked for: it is done, and the next growth opportunity is offered.
    const published = await page.request.post(`${editor}/${postId}/publish`, { data: { expected_updated_at: editedArticle.updated_at } })
    expect(published.status(), await published.text()).toBe(200)
    const readBack = await page.request.get(`${editor}/${postId}`)
    expect(readBack.status(), await readBack.text()).toBe(200)
    expect((await readBack.json() as { post: { status: string } }).post.status).toBe('published')
    const after = await readToday()
    expect(after.tasks.find(section => section.id === 'done')?.tasks.find(task => task.id === acceptedTask.id)).toMatchObject({
      status: 'done', outcome: { note: null, photos: [], closedAt: expect.any(String), closedBy: null }, can: { complete: false, skip: false, reopen: false }, dismiss: null,
    })
    expect(await draftOpportunity()).toBeUndefined()
    const next = after.opportunities.find(value => ['Website', 'Social'].includes(value.statusLine) && !value.title.startsWith('Publish “'))
    expect(next, 'Publication makes the next useful growth action available').toBeDefined()
  } finally {
    try {
      if (goal) {
        const current = (await readGoals()).find(priority => priority.id === goal!.id)
        if (current && current.status === 'active') expect((await page.request.patch(`/api/organizations/${organizationId}/goals/${goal.id}`, { data: { revision: current.revision, status: 'archived' } })).status()).toBe(200)
      }
      if (postId) expect((await page.request.delete(`${editor}/${postId}`)).status()).toBe(200)
      if (categoryId) expect((await page.request.delete(`${editor}/categories/${categoryId}`)).status()).toBe(200)
    } finally { await release() }
  }
})
