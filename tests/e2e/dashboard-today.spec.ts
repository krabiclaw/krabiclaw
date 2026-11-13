import { expect, test, type BrowserContext, type Request } from '@playwright/test'
import { loginAs, authRequestHeaders } from './helpers/auth'
import { dismissPreviewToolbar } from './helpers'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { bookTable, openSeating, seededTables } from './helpers/tables'
import { seededSiteHeaders } from './test-env'
import { seededTenant } from './seed/manifest'
import type { TaskPerson, TaskSection, TaskView } from '../../server/domain/tasks'
import type { OpportunityView } from '../../server/domain/opportunities'
import type { BusinessGoal } from '../../shared/business-progress'
import type { AgendaPayload } from '../../server/utils/dashboard-agenda'
import type { DashboardBookingDetails } from '../../server/utils/dashboard-booking-details'
import type { InboxListPage } from '../../server/domain/guest-threads/types'
import type { ConversationPage } from '../../shared/messages-contract'
import { isDashboardInvalidation } from '../../shared/dashboard-invalidations'

const ORG = '/dashboard/ember-slice-demo'

/** GET /api/dashboard/today: the business's stored tasks and, for a manager, its opportunities. */
type BusinessToday = { tasks: TaskSection[]; opportunities: OpportunityView[]; opportunity_issues: string[]; assignees: TaskPerson[]; resolved_at: string }

test('automation remains in Inbox while Today keeps the unanswered inquiry', async ({ page, request, browser, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Scheduled replies use disposable local data only')
  const organizationId = seededTenant('restaurant').organizationId
  const release = await acquireTenantMutationLock(testInfo, organizationId)
  const marker = `ScheduledReply${Date.now()}`
  let messageId: string | null = null
  let futureMessageId: string | null = null
  let cancelled = false
  let otherOwner: BrowserContext | undefined
  try {
    await loginAs(page.request, baseURL!)
    await dismissPreviewToolbar(page)
    const submitted = await request.post('/api/public/contact', { headers: seededSiteHeaders('restaurant'), data: {
      name: marker, email: `${marker.toLowerCase()}@playwright.example`, subject: 'general', consent: true,
      message: 'Can you accommodate a group for dinner next week?',
    } })
    expect(submitted.status(), await submitted.text()).toBe(201)
    const inbox = await page.request.get('/api/messages', { params: { organization_id: organizationId, type: 'contact' } })
    expect(inbox.status(), await inbox.text()).toBe(200)
    const threads = (await inbox.json() as { threads: Array<{ id: string; title: string }> }).threads.filter(thread => thread.title === marker)
    expect(threads).toHaveLength(1)
    const threadId = threads[0]!.id
    const schedulePath = `/api/dashboard/organizations/${organizationId}/guest-threads/${threadId}/send-later`
    const reply = `We can discuss your group dinner, ${marker}.`
    const futureSendAt = new Date(Date.now() + 40 * 86_400_000).toISOString()
    const futureScheduled = await page.request.post(schedulePath, {
      data: { body: `Later follow-up for ${marker}.`, due_at: futureSendAt },
    })
    expect(futureScheduled.status(), await futureScheduled.text()).toBe(201)
    futureMessageId = (await futureScheduled.json() as { message: { id: string } }).message.id

    // The unanswered inquiry is one open reply task on Today; the scheduled sends are Inbox automation, not tasks.
    const replyTasks = async (range: 'today' | 'upcoming') => {
      const read = await page.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo', range } })
      expect(read.status(), await read.text()).toBe(200)
      return (await read.json() as BusinessToday).tasks.map(section => ({ section: section.id, tasks: section.tasks.filter(task => task.conversation_id === threadId) })).filter(section => section.tasks.length)
    }
    const todayReplies = await replyTasks('today')
    const socketCapture = page.waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname === '/api/dashboard/guest-inbox/socket' })
    expect((await page.goto(ORG))?.status()).toBe(200)
    const socket = await socketCapture
    const replyCard = page.getByTestId('today-task').filter({ hasText: marker })
    const replyLink = replyCard.getByRole('link', { name: marker, exact: true })
    await expect(replyLink).toHaveAttribute('href', `${ORG}/messages/${threadId}`)
    await replyLink.click()
    await expect(page).toHaveURL(new RegExp(`/messages/${threadId}(?:[?#]|$)`))

    // A second owner has the same conversation seat, but the reply is private to its author.
    otherOwner = await browser.newContext({ baseURL })
    await loginAs(otherOwner.request, baseURL!, 'user-e2e-demo-owner')
    const otherTranscript = await otherOwner.request.get(`/api/messages/${threadId}`)
    expect(otherTranscript.status(), await otherTranscript.text()).toBe(200)
    const otherPage = await otherOwner.newPage()
    const otherSocketCapture = otherPage.waitForEvent('websocket', { predicate: connected => new URL(connected.url()).pathname === '/api/dashboard/guest-inbox/socket' })
    expect((await otherPage.goto(ORG))?.status()).toBe(200)
    const otherSocket = await otherSocketCapture
    const otherScheduleUpdates: string[] = []
    otherSocket.on('framereceived', frame => {
      if (frame.payload === 'pong') return
      const event: unknown = JSON.parse(String(frame.payload))
      if (isDashboardInvalidation(event) && event.type === 'MESSAGE_UPDATE' && event.scheduled && event.conversation_id === threadId) otherScheduleUpdates.push(event.event_id)
    })
    // An authenticated acknowledgement gives the second socket an observable ready boundary.
    const originalMessage = (await otherTranscript.json() as ConversationPage).entries.find(entry => entry.type === 'message')
    expect(originalMessage).toBeDefined()
    const [read] = await Promise.all([
      otherOwner.request.post(`/api/messages/${threadId}/read`, { headers: authRequestHeaders(baseURL!), data: { message_id: originalMessage!.id } }),
      otherSocket.waitForEvent('framereceived', { predicate: frame => {
        if (frame.payload === 'pong') return false
        const event: unknown = JSON.parse(String(frame.payload))
        return isDashboardInvalidation(event) && event.type === 'MESSAGE_ACK' && event.conversation_id === threadId
      } }),
    ])
    expect(read.status(), await read.text()).toBe(200)

    await page.getByRole('textbox', { name: 'Write a message…', exact: true }).fill(reply)
    await page.getByRole('button', { name: 'Add to message' }).click()
    await page.getByRole('menuitem', { name: 'Send later', exact: true }).click()
    await page.getByRole('dialog', { name: 'Send later' }).getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send now instead' })).toBeVisible()
    const chatReads: string[] = []
    const trackChatRead = (request: Request) => {
      const { pathname, search } = new URL(request.url())
      if (request.method() === 'GET' && (pathname === '/api/messages' || pathname === '/api/messages/unread-count' || pathname === `/api/messages/${threadId}`)) chatReads.push(pathname + search)
    }
    page.on('request', trackChatRead)
    try {
      const [scheduled, scheduleFrame] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === schedulePath),
        socket.waitForEvent('framereceived', { predicate: frame => {
          if (frame.payload === 'pong') return false
          const event: unknown = JSON.parse(String(frame.payload))
          return isDashboardInvalidation(event) && event.type === 'MESSAGE_UPDATE' && event.scheduled === true && event.conversation_id === threadId
        } }),
        page.getByRole('button', { name: 'Send reply', exact: true }).click(),
      ])
      expect(scheduled.status(), await scheduled.text()).toBe(201)
      messageId = (await scheduled.json() as { message: { id: string } }).message.id
      expect(Object.keys(JSON.parse(String(scheduleFrame.payload))).sort()).toEqual(
        ['conversation_id', 'event_id', 'location_id', 'occurred_at', 'organization_id', 'scheduled', 'team', 'type'],
      )
      await expect(page.getByText('Message scheduled', { exact: true })).toBeVisible()
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect(chatReads).toEqual([])
    } finally { page.off('request', trackChatRead) }

    expect(todayReplies).toEqual([{ section: 'open', tasks: [expect.objectContaining({
      kind: 'guest_reply', status: 'open', title: marker, detail: 'Can you accommodate a group for dinner next week?', conversation_id: threadId, starts_at: null, due_at: null,
      action: { type: 'open', label: 'Reply', path: `${ORG}/messages/${threadId}` },
    })] }])
    const replyTask = todayReplies[0]!.tasks[0]!
    expect(await replyTasks('upcoming')).toEqual([])
    // The replies are in the one outbox, as the member's own.
    const outbox = () => page.request.get('/api/dashboard/scheduled-guest-messages', { params: { org: 'ember-slice-demo', conversation_id: threadId, limit: 25, offset: 0 } })
    const pending = await outbox()
    expect(pending.status(), await pending.text()).toBe(200)
    const pendingMessages = (await pending.json() as { messages: Array<{ id: string; status: string }> }).messages
    expect(pendingMessages).toHaveLength(2)
    for (const id of [messageId, futureMessageId]) {
      expect(pendingMessages.find(message => message.id === id)).toMatchObject({ id, conversation_id: threadId, status: 'pending', author_user_id: expect.any(String), booking_id: null })
    }
    const otherOutbox = await otherOwner.request.get('/api/dashboard/scheduled-guest-messages', { params: { org: 'ember-slice-demo', conversation_id: threadId, limit: 25, offset: 0 } })
    expect(otherOutbox.status(), await otherOutbox.text()).toBe(200)
    expect(await otherOutbox.json()).toMatchObject({ messages: [] })
    // The thread opens its own view of the outbox, where the author cancels a reply.
    await expect(page.getByText(reply, { exact: true })).toHaveCount(0)
    await page.getByRole('link', { name: 'Sent and upcoming' }).click()
    await expect(page).toHaveURL(`${ORG}/messages/scheduled?conversation_id=${threadId}`)
    const scheduledRows = page.locator('[data-scheduled-message]')
    await expect(scheduledRows).toHaveCount(2)
    const scheduledRow = page.locator(`[data-scheduled-message="${messageId}"]`)
    await expect(scheduledRow.getByText(reply, { exact: true })).toBeVisible()
    const [response] = await Promise.all([
      page.waitForResponse(candidate => candidate.request().method() === 'POST' && new URL(candidate.url()).pathname === `/api/dashboard/scheduled-guest-messages/${messageId}/cancel`),
      scheduledRow.getByRole('button', { name: 'Cancel scheduled message' }).click(),
    ])
    expect(response.status(), await response.text()).toBe(200)
    expect(await response.json()).toMatchObject({ message: { id: messageId, status: 'cancelled', reason: 'Cancelled by its author.' } })
    cancelled = true
    await expect(scheduledRow.getByText('Cancelled', { exact: true })).toBeVisible()
    await otherPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(otherScheduleUpdates).toEqual([])
    const persisted = await outbox()
    expect(persisted.status(), await persisted.text()).toBe(200)
    // The outbox keeps the cancelled reply with its status; cancelled work still leaves Upcoming independently below.
    expect((await persisted.json() as { messages: Array<{ id: string; status: string }> }).messages.filter(message => message.id === messageId).map(message => message.status)).toEqual(['cancelled'])
    await page.getByRole('link', { name: 'Back to conversation' }).click()
    await expect(page).toHaveURL(`${ORG}/messages/${threadId}`)
    await page.goBack()
    await expect(page).toHaveURL(ORG)
    // Cancelling a scheduled send answers nothing: the question is still owed.
    expect(await replyTasks('upcoming')).toEqual([])
    expect(await replyTasks('today')).toEqual([{ section: 'open', tasks: [expect.objectContaining({ id: replyTask.id, status: 'open', version: replyTask.version })] }])
    // The same task read through the tasks route.
    const taskRead = await page.request.get(`/api/organizations/${organizationId}/tasks/${replyTask.id}`)
    expect(taskRead.status(), await taskRead.text()).toBe(200)
    expect((await taskRead.json() as { task: TaskView }).task).toMatchObject({ id: replyTask.id, kind: 'guest_reply', status: 'open', conversation_id: threadId, can: { complete: false }, dismiss: { label: 'Dismiss', card: true } })
    // A reply task closes with its subject, not with Done.
    const refused = await page.request.post(`/api/organizations/${organizationId}/tasks/${replyTask.id}/complete`, { data: {} })
    expect(refused.status(), await refused.text()).toBe(409)
    expect(await refused.json()).toMatchObject({ data: { code: 'TASK_CLOSES_WITH_SUBJECT' } })
  } finally {
    try {
      if (messageId && !cancelled) {
        const response = await page.request.post(`/api/dashboard/scheduled-guest-messages/${messageId}/cancel`, { params: { org: 'ember-slice-demo' } })
        expect(response.status(), await response.text()).toBe(200)
      }
      if (futureMessageId) {
        const response = await page.request.post(`/api/dashboard/scheduled-guest-messages/${futureMessageId}/cancel`, { params: { org: 'ember-slice-demo' } })
        expect(response.status(), await response.text()).toBe(200)
      }
    } finally {
      try { await otherOwner?.close() } finally { await release() }
    }
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
    expect(await memberFeed.json()).toEqual({ reservations: { title: null, cards: [] }, tasks: [], opportunities: [], opportunity_issues: [], assignees: [], resolved_at: expect.any(String) })
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

test('booking assignment and workspace admin promotion do not grant a conversation seat', async ({ page, browser, request, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Table bookings and role changes use disposable local data only')
  const release = await acquireTenantMutationLock(testInfo, seededTenant('restaurant').organizationId)
  const org = 'ember-slice-demo'
  const organizationId = seededTenant('restaurant').organizationId
  const locationId = seededTenant('restaurant').locations.brooklyn.id
  // A branch's tables are one product; the member its booking setup names handles every table booked there.
  const tables = seededTables('brooklyn')
  const tablesPath = `/api/editor/organizations/${organizationId}/products/${tables.id}/booking`
  const chefMemberId = seededTenant('restaurant').memberIds['user-e2e-demo-owner']!
  const listPath = '/api/messages'
  type Member = { id: string; userId: string; role: string }
  let reassigned = false
  let actor: Member | undefined
  let reservationId: string | null = null
  let bookingId: string | null = null
  let memberContext: BrowserContext | null = null
  const failures: unknown[] = []
  const assign = async (memberId: string) => {
    const saved = await page.request.put(tablesPath, { data: { assigned_member_id: memberId } })
    expect(saved.status(), await saved.text()).toBe(200)
  }
  try {
    memberContext = await browser.newContext({ baseURL })
    const memberRequest = memberContext.request
    await loginAs(page.request, baseURL!)
    const members = await page.request.get('/api/dashboard/members', { params: { org } })
    expect(members.status(), await members.text()).toBe(200)
    actor = (await members.json() as { members: Member[] }).members.find(member => member.userId === 'user-e2e-demo-role-owner')
    expect(actor, 'The canonical role actor already belongs to the demo tenant').toBeDefined()
    if (!actor) throw new Error('The canonical demo role actor is missing')
    // The tables are the chef's to handle; the actor holds none of them.
    expect(actor.id).not.toBe(chefMemberId)

    const changed = await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId, memberId: actor.id, role: 'member' },
    })
    expect(changed.status(), await changed.text()).toBe(200)
    const slot = await openSeating(request, 2, 2 * 86_400_000)
    const day = { date: new Intl.DateTimeFormat('en-CA', { timeZone: slot.timezone }).format(new Date(slot.starts_at)) }
    const guestName = `Branch${Date.now()} Guest`
    const made = await bookTable(request, { name: guestName, email: `branch-assignment-${Date.now()}@playwright.example`, phone: '+61491570007', partySize: 2, seating: slot })
    reservationId = made.requestId
    bookingId = made.bookingId
    expect(reservationId).toEqual(expect.any(String))
    const bookingPath = `/api/dashboard/bookings/${bookingId}`
    const destination = `${ORG}/bookings/${bookingId}`
    const ownerBooking = await page.request.get(bookingPath, { params: { org } })
    expect(ownerBooking.status(), await ownerBooking.text()).toBe(200)
    const { booking } = await ownerBooking.json() as { booking: DashboardBookingDetails }
    expect(booking).toMatchObject({ conversation_id: reservationId, organization_id: organizationId, location_id: locationId, guest_name: guestName, status: 'confirmed', booking_date: day.date, timezone: slot.timezone, party_size: 2 })
    const ownerThread = await page.request.get(`/api/messages/${reservationId}`)
    expect(ownerThread.status(), await ownerThread.text()).toBe(200)
    const { conversation: ownerConversation, viewer_role: role } = await ownerThread.json() as ConversationPage
    expect(role).toBe('member')
    expect(ownerConversation).toMatchObject({ id: reservationId, kind: 'guest', title: guestName, channel: 'direct', home: booking.location_title, booking_id: booking.booking_id, record_kind: 'booking' })
    await loginAs(memberRequest, baseURL!, actor.userId)
    const verifyAccess = async (assigned: boolean) => {
      const agendaResponse = await memberRequest.get('/api/dashboard/agenda', { params: { org, from: day.date, to: day.date } })
      expect(agendaResponse.status(), await agendaResponse.text()).toBe(200)
      const agenda = await agendaResponse.json() as AgendaPayload
      if (assigned) expect(agenda.items.find(item => item.conversation_id === reservationId)).toMatchObject({ id: `booking:${reservationId}`, kind: 'booking', conversation_id: reservationId, booking_id: booking.booking_id, location_id: locationId, title: guestName, status: 'confirmed', starts_at: slot.starts_at, to: destination })
      else expect(agenda.items.some(item => item.conversation_id === reservationId)).toBe(false)
      const response = await memberRequest.get(listPath, { params: { organization_id: organizationId, org, location_id: locationId, type: 'booking' } })
      expect(response.status(), await response.text()).toBe(200)
      const { threads } = await response.json() as InboxListPage
      expect(threads.some(thread => thread.id === reservationId)).toBe(false)
      const detail = await memberRequest.get(`/api/messages/${reservationId}`)
      expect(detail.status(), await detail.text()).toBe(404)
      const record = await memberRequest.get(bookingPath, { params: { org } })
      expect(record.status(), await record.text()).toBe(assigned ? 200 : 404)
      if (assigned) expect((await record.json() as { booking: DashboardBookingDetails }).booking).toMatchObject({ booking_id: bookingId, conversation_id: reservationId, location_id: locationId, status: 'confirmed' })
    }
    await verifyAccess(false)
    await assign(actor.id)
    reassigned = true
    await verifyAccess(true)
    const deniedSend = await memberRequest.post(`/api/messages/${reservationId}`, {
      headers: authRequestHeaders(baseURL!), data: { body: 'Assignment alone cannot send this', idempotency_key: crypto.randomUUID() },
    })
    expect(deniedSend.status(), await deniedSend.text()).toBe(404)
    const promoted = await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId, memberId: actor.id, role: 'admin' },
    })
    expect(promoted.status(), await promoted.text()).toBe(200)
    await loginAs(memberRequest, baseURL!, actor.userId)
    const stillDenied = await memberRequest.get(`/api/messages/${reservationId}`)
    expect(stillDenied.status(), await stillDenied.text()).toBe(404)
    const demoted = await page.request.post('/api/auth/organization/update-member-role', {
      headers: authRequestHeaders(baseURL!), data: { organizationId, memberId: actor.id, role: 'member' },
    })
    expect(demoted.status(), await demoted.text()).toBe(200)
    await loginAs(memberRequest, baseURL!, actor.userId)
    await verifyAccess(true)
    await assign(chefMemberId)
    reassigned = false
    await verifyAccess(false)
  } catch (error) {
    failures.push(error)
  } finally {
    try {
      if (reservationId) {
        const current = await page.request.get(`/api/dashboard/bookings/${bookingId}`, { params: { org } })
        expect(current.status(), await current.text()).toBe(200)
        const cancelled = await page.request.post(`/api/dashboard/bookings/${bookingId}/cancel`, { params: { org }, data: { version: (await current.json()).booking.version, idempotency_key: crypto.randomUUID() } })
        expect(cancelled.status(), await cancelled.text()).toBe(200)
        const read = await page.request.get(`/api/dashboard/bookings/${bookingId}`, { params: { org } })
        expect(read.status(), await read.text()).toBe(200)
        expect((await read.json() as { booking: DashboardBookingDetails }).booking).toMatchObject({ conversation_id: reservationId, status: 'cancelled' })
      }
    } catch (error) { failures.push(error) }
    try {
      if (reassigned) await assign(chefMemberId)
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
  let goal: { id: string; updated_at: string } | null = null
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
    expect(beforeGoal, 'A real draft is useful marketing before the owner saves a matching priority').toMatchObject({ status_line: 'Website', title: `Publish “${title}”`, icon: 'i-lucide-file-pen-line' })
    expect(beforeGoal!.detail).not.toContain('Your strategy')

    // The owner chooses channels explicitly; unrelated intent wording is not a relevance algorithm.
    const intent = `Help prospective guests choose us ${marker}`
    const goalRequest = { idempotency_key: crypto.randomUUID(), intent, strategy: { channels: ['blog', 'social'], payments: false, availability: false } }
    const saved = await page.request.post(`${tasksApi}/goals`, { data: goalRequest })
    expect(saved.status(), await saved.text()).toBe(201)
    goal = (await saved.json() as { goal: { id: string; updated_at: string } }).goal
    expect((await readGoals()).find(value => value.id === goal!.id)?.strategy).toMatchObject({ channels: ['blog', 'social'] })
    // The strategy is now the opportunity's reason, recorded as a new opportunity for the new goal.
    const withGoal = await draftOpportunity()
    expect(withGoal).toMatchObject({ status_line: 'Website', title: `Publish “${title}”`, detail: expect.stringContaining(`Your strategy: ${intent}`) })
    expect(withGoal!.id).not.toBe(beforeGoal!.id)

    // Later: set aside until tomorrow; it leaves Today while it waits.
    const until = new Date(Date.now() + 86_400_000).toISOString()
    const deferred = await page.request.post(`${tasksApi}/opportunities/${withGoal!.id}/defer`, { data: { until } })
    expect(deferred.status(), await deferred.text()).toBe(200)
    expect(await deferred.json()).toEqual({ opportunity: { id: withGoal!.id, available_at: until } })
    expect(await draftOpportunity()).toBeUndefined()
    const pastDeferral = await page.request.post(`${tasksApi}/opportunities/${withGoal!.id}/defer`, { data: { until: new Date(Date.now() - 60_000).toISOString() } })
    expect(pastDeferral.status(), await pastDeferral.text()).toBe(422)
    // Deciding wrote nothing to the draft.
    const unchanged = await page.request.get(`${editor}/${postId}`)
    expect(unchanged.status(), await unchanged.text()).toBe(200)
    expect((await unchanged.json() as { post: { status: string; updated_at: string } }).post).toMatchObject({ status: 'draft', updated_at: article.updated_at })

    // A separate writer changes the draft: the changed evidence is a new opportunity, which the deferral of the old evidence does not hide.
    const edit = async (expectedUpdatedAt: string, excerpt: string) => {
      const edited = await page.request.patch(`${editor}/${postId}`, { data: { updated_at: expectedUpdatedAt, excerpt } })
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
      id: acceptedTask.id, kind: 'opportunity', status: 'open', status_line: 'Accepted opportunity', title: `Publish “${title}”`,
      assignee: { type: 'member', name: 'You', you: true }, due_at: expect.any(String), action: { type: 'complete', label: 'Done' },
      can: { complete: true, skip: true, reopen: false, assign: true, edit: true }, dismiss: { label: 'Skip', card: false },
    })
    expect((await readToday()).tasks.find(section => section.id === 'open')?.tasks.map(task => task.id)).toContain(acceptedTask.id)

    // Publishing from another surface is the work the task asked for: it is done, and the next growth opportunity is offered.
    const published = await page.request.post(`${editor}/${postId}/publish`, { data: { updated_at: editedArticle.updated_at } })
    expect(published.status(), await published.text()).toBe(200)
    const readBack = await page.request.get(`${editor}/${postId}`)
    expect(readBack.status(), await readBack.text()).toBe(200)
    expect((await readBack.json() as { post: { status: string } }).post.status).toBe('published')
    const after = await readToday()
    expect(after.tasks.find(section => section.id === 'done')?.tasks.find(task => task.id === acceptedTask.id)).toMatchObject({
      status: 'done', outcome: { note: null, photos: [], closed_at: expect.any(String), closed_by: null }, can: { complete: false, skip: false, reopen: false }, dismiss: null,
    })
    expect(await draftOpportunity()).toBeUndefined()
    const next = after.opportunities.find(value => ['Website', 'Social'].includes(value.status_line) && !value.title.startsWith('Publish “'))
    expect(next, 'Publication makes the next useful growth action available').toBeDefined()
  } finally {
    try {
      if (goal) {
        const current = (await readGoals()).find(priority => priority.id === goal!.id)
        if (current && current.status === 'active') expect((await page.request.patch(`/api/organizations/${organizationId}/goals/${goal.id}`, { data: { updated_at: current.updated_at, status: 'archived' } })).status()).toBe(200)
      }
      if (postId) expect((await page.request.delete(`${editor}/${postId}`)).status()).toBe(200)
      if (categoryId) expect((await page.request.delete(`${editor}/categories/${categoryId}`)).status()).toBe(200)
    } finally { await release() }
  }
})
