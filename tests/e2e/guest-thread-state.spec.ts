import { dismissPreviewToolbar } from './helpers'
import { localDateAt, localDateTimeToInstant, localNow, unresolvableLocalTime } from '../../utils/timezone'
import { createHmac } from 'node:crypto'
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import type {
  InboxRow,
  InboxStreamItem,
  InboxThread,
  InboxThreadDetails,
} from '../../server/domain/guest-threads/types'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { bookTable, openSeating, tableSeatings } from './helpers/tables'
import { seededTenant } from './seed/manifest'
import { devLoginHeaders, seededSiteHeaders, testBaseUrl } from './test-env'
import type { TaskPerson, TaskSection } from '../../server/domain/tasks'
import type { OpportunityView } from '../../server/domain/opportunities'
import type { ConversationPage } from '../../shared/messages-contract'
import type { DashboardBookingDetails } from '../../server/utils/dashboard-booking-details'

interface DeliveryView {
  id: string
  conversation_id: string
  message_id: string
  purpose: string
  status: string
}

interface DeliveryList {
  deliveries: DeliveryView[]
}

/** GET /api/dashboard/today: the business's stored tasks and, for a manager, its opportunities. */
type BusinessToday = { tasks: TaskSection[]; opportunities: OpportunityView[]; opportunity_issues: string[]; assignees: TaskPerson[]; resolved_at: string }

const baseURL = testBaseUrl()
// Contact threads run on the seeded experience business; table bookings on the
// restaurant's Brooklyn tables.
const organizationId = () => seededTenant('experience').organizationId
const organizationSlug = () => seededTenant('experience').slug
const demoOrganizationId = () => seededTenant('restaurant').organizationId
const demoSlug = () => seededTenant('restaurant').slug
const demoLocationId = () => seededTenant('restaurant').locations.brooklyn!.id
const ownerId = 'user-e2e-pottery-owner'
const secondOwnerId = 'user-e2e-pottery-location-owner'
const foreignOwnerId = 'user-e2e-kikuzuki-owner'
const writable = ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)
const local = ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)

async function expectStatus(response: APIResponse, status: number) {
  expect(response.status(), await response.text()).toBe(status)
}

// Far enough ahead that the slot is still in the future when the reservation POST
// re-reads availability a second or two later, and short enough that the unusable
// window at the end of the location's local day stays this many minutes wide.
const TODAY_SLOT_LEAD_MINUTES = 6

interface LocationSlot { date: string; time: string }

/**
 * A minute today that the location does not already serve, far enough ahead to still be
 * bookable, or null once today has run out — the caller skips rather than pretending a
 * booking could land.
 *
 * Cleanup clears the location's special hours outright, so this must never land on a
 * slot the location already has: the editor calendar (read with includePast, so it covers
 * the whole day) says which minutes are taken, and minutes that are a multiple of five
 * are skipped so the time cannot sit on any ordinary 15/30/60-minute grid either.
 */
function openableMinuteToday(local: { date: string; time: string }, taken: ReadonlySet<string>, timezone: string): LocationSlot | null {
  const { date, time } = local
  const [hours, minutes] = time.split(':').map(Number)
  for (let minuteOfDay = hours! * 60 + minutes! + TODAY_SLOT_LEAD_MINUTES; minuteOfDay < 24 * 60; minuteOfDay += 1) {
    const slot = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`
    // On a clock-change day a minute in the repeated or skipped hour names no single instant, and nobody can book it.
    if (minuteOfDay % 5 !== 0 && !taken.has(slot) && !unresolvableLocalTime(date, slot, timezone)) return { date, time: slot }
  }
  return null
}

/** The local start times of the Brooklyn tables' seatings on a day, as the guest's site offers them. */
async function loadLocationDay(request: APIRequestContext, date: string, timezone: string) {
  const local = (instant: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant)).replace(',', '')
  return new Set((await tableSeatings(request)).map(session => local(session.starts_at)).filter(at => at.startsWith(`${date} `)).map(at => at.slice(11)))
}

/**
 * Dated hours replace the day's ordinary periods. The fixture's 90-minute table
 * duration fits once in a 90-minute opening period.
 */
async function readSpecialHours(request: APIRequestContext): Promise<unknown> {
  const response = await request.get(`/api/organizations/${demoOrganizationId()}/locations/${demoLocationId()}`)
  await expectStatus(response, 200)
  return (await response.json() as { location: { special_hours: unknown } }).location.special_hours ?? null
}

function restoreSpecialHours(request: APIRequestContext, special: unknown) {
  return request.patch(`/api/organizations/${demoOrganizationId()}/locations/${demoLocationId()}`, { data: { special_hours: special } })
}

function setLocationSlot(request: APIRequestContext, slot: LocationSlot) {
  const [hours, minutes] = slot.time.split(':').map(Number)
  const closeMinute = hours! * 60 + minutes! + 90
  const close = `${String(Math.floor(closeMinute / 60) % 24).padStart(2, '0')}:${String(closeMinute % 60).padStart(2, '0')}`
  return request.patch(`/api/organizations/${demoOrganizationId()}/locations/${demoLocationId()}`, {
    data: {
      special_hours: [{
        kind: 'hours',
        date: slot.date,
        periods: [{ open_time: slot.time, close_time: close, close_day_offset: closeMinute >= 24 * 60 ? 1 : 0 }],
        note: null,
      }],
    },
  })
}

// The location's own special hours, read before the Today journey replaces them, so
// cleanup puts back what the tenant had rather than clearing the field. Null is a
// value here: it means the location had none, which is not the same as "leave it".
let priorSpecialHours: { value: unknown } | null = null
// The Brooklyn location's hours and its tables are shared with the calendar and MCP specs.
let releaseDemoLock: (() => Promise<void>) | null = null

test.afterEach(async ({ page }) => {
  const release = releaseDemoLock
  releaseDemoLock = null
  try {
    if (!priorSpecialHours) return
    const previous = priorSpecialHours.value
    priorSpecialHours = null
    // A cleanup that quietly 4xxs would leave the location open at an hour it does not serve,
    // and PATCH resolves on any status, so the status is asserted rather than assumed.
    await expectStatus(await restoreSpecialHours(page.request, previous), 200)
  } finally {
    await release?.()
  }
})

// The one conversation list, narrowed to the tenant's contact conversations; the guest under test is picked out of it.
async function loadThreadList(request: APIRequestContext, guestName: string) {
  const response = await request.get('/api/messages', {
    params: { organization_id: organizationId(), type: 'contact', q: guestName },
  })
  await expectStatus(response, 200)
  const { threads } = await response.json() as { threads: InboxRow[] }
  return { threads: threads.filter(thread => thread.title === guestName) }
}

async function loadThreadDetail(
  request: APIRequestContext,
  threadId: string,
  targetOrganizationId = organizationId(),
) {
  const response = await request.get(`/api/messages/${threadId}`)
  await expectStatus(response, 200)
  const { conversation, entries } = await response.json() as ConversationPage
  expect(conversation.organization_id).toBe(targetOrganizationId)
  if (conversation.kind === 'team') throw new Error(`Expected a guest conversation for ${threadId}`)
  return { ...conversation, stream: entries }
}

/** What "In this conversation" offers for the thread, read as the member it was asked by. */
async function loadThreadActions(request: APIRequestContext, threadId: string, targetOrganizationId = organizationId()) {
  const response = await request.get(`/api/dashboard/organizations/${targetOrganizationId}/guest-threads/${threadId}/details`)
  await expectStatus(response, 200)
  return (await response.json() as InboxThreadDetails).actions
}

type StreamMessage = Extract<InboxStreamItem, { type: 'message' }>
type StreamEvent = Extract<InboxStreamItem, { type: 'event' }>
const streamMessages = (thread: InboxThread) => thread.stream.filter((item): item is StreamMessage => item.type === 'message')
const streamEvents = (thread: InboxThread, text: string) => thread.stream.filter((item): item is StreamEvent => item.type === 'event' && item.text === text)

/** The owner's reply tasks on Today, open and done today, for one conversation. */
async function loadReplyTasks(request: APIRequestContext, slug: string, threadId: string) {
  const response = await request.get('/api/dashboard/today', { params: { org: slug, kind: 'guest_reply' } })
  await expectStatus(response, 200)
  return (await response.json() as BusinessToday).tasks.map(section => ({ section: section.id, tasks: section.tasks.filter(task => task.conversation_id === threadId) })).filter(section => section.tasks.length)
}

/** Opening a conversation reads it through to the newest message shown; the GET that showed it wrote nothing. */
async function readThrough(request: APIRequestContext, thread: InboxThread) {
  const newest = thread.stream.filter(item => item.type !== 'day').at(-1)!.id
  const response = await request.post(`/api/messages/${thread.id}/read`, { headers: authRequestHeaders(baseURL), data: { message_id: newest } })
  await expectStatus(response, 200)
  expect(await response.json()).toEqual({ read: true, last_read_message_id: newest })
}

test('guest thread state stays source-owned, per-user, tenant-isolated, and idempotent', async ({ playwright }) => {
  test.skip(!writable, 'Guest-thread writes require disposable local or preview data')

  const owner = await playwright.request.newContext({ baseURL })
  const guest = await playwright.request.newContext({ baseURL })
  const secondOwner = await playwright.request.newContext({ baseURL })
  const foreignOwner = await playwright.request.newContext({ baseURL })

  try {
    await Promise.all([
      loginAs(owner, baseURL, ownerId),
      loginAs(secondOwner, baseURL, secondOwnerId),
      loginAs(foreignOwner, baseURL, foreignOwnerId),
    ])

    const nonce = Date.now()
    const guestName = `Thread${nonce} Proof`
    const guestEmail = `guest-thread-${nonce}@playwright.example`
    const subject = 'partnerships'
    const message = `Canonical source detail proof ${nonce}`
    const startedAt = new Date().toISOString()
    const submission = await guest.post(`/api/public/contact`, {
      headers: seededSiteHeaders('experience'),
      data: { name: guestName, email: guestEmail, subject, message, location_id: seededTenant('experience').locations['ao-nang']!.id },
    })
    await expectStatus(submission, 201)

    const [ownerListBefore, secondOwnerListBefore] = await Promise.all([
      loadThreadList(owner, guestName),
      loadThreadList(secondOwner, guestName),
    ])
    expect(ownerListBefore.threads).toHaveLength(1)
    expect(secondOwnerListBefore.threads).toHaveLength(1)
    const threadId = ownerListBefore.threads[0]!.id
    expect([403, 404]).toContain((await foreignOwner.get('/api/messages', {
      params: { organization_id: organizationId(), type: 'contact' },
    })).status())
    expect(secondOwnerListBefore.threads[0]!.id).toBe(threadId)
    // The row is the guest's own words, from them, on the business's own channel.
    const guestFirstName = guestName.split(' ')[0]!
    expect(ownerListBefore.threads[0]).toMatchObject({ title: guestName, kind: 'guest', channel: 'direct', preview: message, preview_from: guestFirstName, unread: true })
    expect(secondOwnerListBefore.threads[0]).toMatchObject({ title: guestName, kind: 'guest', channel: 'direct', preview: message, preview_from: guestFirstName, unread: true })

    const detail = await loadThreadDetail(owner, threadId)
    // A contact has no record behind it, and a reply goes to the email the guest left.
    expect(detail).toMatchObject({
      id: threadId,
      kind: 'guest',
      title: guestName,
      channel: 'direct',
      when: null,
      booking_id: null,
      record_kind: null,
      composer: { channel: 'email', available: true },
    })
    // The guest's own words open the conversation, once, as their message.
    expect(streamMessages(detail)).toMatchObject([{ side: 'guest', author: guestName, body: message, photos: [], translated: null }])
    // The guest's question is the business's to answer: one open reply task on Today, which opens the conversation.
    expect(await loadReplyTasks(owner, organizationSlug(), threadId)).toEqual([{ section: 'open', tasks: [expect.objectContaining({
      kind: 'guest_reply', status: 'open', title: `Thread${nonce}`, detail: message, conversation_id: threadId, outcome: null,
      action: { type: 'open', label: 'Reply', path: expect.stringContaining(threadId) },
      can: expect.objectContaining({ complete: false }),
    })] }])
    const replyTask = (await loadReplyTasks(owner, organizationSlug(), threadId))[0]!.tasks[0]!

    // Showing the conversation wrote nothing; reading it through is this owner's alone.
    expect((await loadThreadList(owner, guestName)).threads[0]).toMatchObject({ id: threadId, unread: true })
    await readThrough(owner, detail)
    const [ownerListAfterRead, secondOwnerListStillUnread] = await Promise.all([
      loadThreadList(owner, guestName),
      loadThreadList(secondOwner, guestName),
    ])
    expect(ownerListAfterRead.threads[0]).toMatchObject({ id: threadId, unread: false })
    expect(secondOwnerListStillUnread.threads[0]).toMatchObject({ id: threadId, unread: true })

    await readThrough(secondOwner, await loadThreadDetail(secondOwner, threadId))
    expect((await loadThreadList(secondOwner, guestName)).threads[0]).toMatchObject({ id: threadId, unread: false })
    // Another business's owner cannot move this conversation's read position.
    expect([403, 404]).toContain((await foreignOwner.post(`/api/messages/${threadId}/unread`, { headers: authRequestHeaders(baseURL) })).status())

    const foreignRead = await foreignOwner.get(`/api/messages/${threadId}`)
    expect([403, 404]).toContain(foreignRead.status())
    const foreignMutation = await foreignOwner.post(`/api/messages/${threadId}`, {
      headers: authRequestHeaders(baseURL), data: { body: `Foreign reply ${nonce}`, idempotency_key: `foreign-reply-${nonce}` },
    })
    expect([403, 404]).toContain(foreignMutation.status())

    const replyBody = `Idempotent owner reply ${nonce}`
    const idempotencyKey = `guest-thread-reply-${nonce}`
    const replyUrl = `/api/messages/${threadId}`
    const sendReply = () => owner.post(replyUrl, {
      headers: authRequestHeaders(baseURL),
      data: { body: replyBody, idempotency_key: idempotencyKey },
    })
    const concurrentReplies = await Promise.all([sendReply(), sendReply()])
    const concurrentReplyStatuses = concurrentReplies.map(response => response.status())
    expect(concurrentReplyStatuses).toContain(200)
    expect(concurrentReplyStatuses.every(status => status === 200 || status === 202)).toBe(true)
    await expectStatus(await sendReply(), 200)

    // Three sends under one key are one message on the business's side; "You" is the
    // server's word for a message the reading member wrote, so it is the owner's.
    const afterReplies = await loadThreadDetail(owner, threadId)
    const replyEntries = streamMessages(afterReplies).filter(item => item.body === replyBody)
    expect(replyEntries).toMatchObject([{ side: 'business', author: 'You', receipt: 'Recorded locally' }])
    const deliveryResponse = await owner.get('/api/dev/notifications', {
      headers: devLoginHeaders(),
      params: { organization_id: organizationId(), since: startedAt },
    })
    await expectStatus(deliveryResponse, 200)
    const deliveries = (await deliveryResponse.json() as DeliveryList).deliveries.filter(row =>
      row.conversation_id === threadId && row.purpose === 'member_reply',
    )
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.message_id).toBe(replyEntries[0]!.id)

    // The owner's own reply is not news to them, and the second owner has not read it yet.
    const [ownerListAfterReply, secondOwnerListAfterReply] = await Promise.all([
      loadThreadList(owner, guestName),
      loadThreadList(secondOwner, guestName),
    ])
    expect(secondOwnerListAfterReply.threads[0]).toMatchObject({ id: threadId, unread: true })
    expect(ownerListAfterReply.threads[0]).toMatchObject({
      id: threadId,
      preview: replyBody,
      preview_from: 'You',
      unread: false,
    })
    // A reply is an answer once a provider accepted it. This environment delivers email log-only, so the record
    // shows no delivered answer: the one reply task stays open, for every owner alike.
    expect(await loadReplyTasks(owner, organizationSlug(), threadId)).toEqual([{ section: 'open', tasks: [expect.objectContaining({ id: replyTask.id, status: 'open', outcome: null })] }])
    expect(await loadReplyTasks(secondOwner, organizationSlug(), threadId)).toEqual([{ section: 'open', tasks: [expect.objectContaining({ id: replyTask.id, status: 'open' })] }])
  } finally {
    await Promise.all([owner.dispose(), guest.dispose(), secondOwner.dispose(), foreignOwner.dispose()])
  }
})

type Mailbox = 'current' | 'past'

// The one list, in one mailbox.
async function loadMailbox(request: APIRequestContext, mailbox: Mailbox) {
  const response = await request.get('/api/messages', { params: { organization_id: organizationId(), mailbox } })
  await expectStatus(response, 200)
  return (await response.json() as { threads: InboxRow[] }).threads
}

async function submitContact(request: APIRequestContext, guestName: string) {
  const response = await request.post('/api/public/contact', {
    headers: seededSiteHeaders('experience'),
    data: { name: guestName, email: `${guestName.replace(/\W+/g, '-').toLowerCase()}@playwright.example`, subject: 'partnerships', message: `Mailbox proof for ${guestName}`, location_id: seededTenant('experience').locations['ao-nang']!.id },
  })
  await expectStatus(response, 201)
}

test('archive and Move to messages file a conversation for the one member, without reordering the inbox', async ({ playwright }) => {
  test.skip(!writable, 'Guest-thread writes require disposable local or preview data')

  const owner = await playwright.request.newContext({ baseURL })
  const guest = await playwright.request.newContext({ baseURL })
  const secondOwner = await playwright.request.newContext({ baseURL })
  const foreignOwner = await playwright.request.newContext({ baseURL })
  try {
    await Promise.all([loginAs(owner, baseURL, ownerId), loginAs(secondOwner, baseURL, secondOwnerId), loginAs(foreignOwner, baseURL, foreignOwnerId)])

    // The retired vocabulary is refused rather than ignored.
    await expectStatus(await owner.get('/api/messages', { params: { organization_id: organizationId(), occurrence: 'upcoming' } }), 400)

    const nonce = Date.now()
    const filedName = `Mailbox filed ${nonce}`
    const newerName = `Mailbox newer ${nonce}`
    await submitContact(guest, filedName)
    await submitContact(guest, newerName)

    const current = await loadMailbox(owner, 'current')
    const filed = current.find(thread => thread.title === filedName)
    const newer = current.find(thread => thread.title === newerName)
    expect(filed).toBeDefined()
    const threadId = filed!.id
    expect(await loadThreadActions(owner, threadId)).toMatchObject({ archive: true, unarchive: false })
    const streamBefore = (await loadThreadDetail(owner, threadId)).stream.map(item => item.id)

    const archiveUrl = `/api/messages/${threadId}/archive`
    // Another business's owner cannot reach it, and the request says which way it files it.
    expect([403, 404]).toContain((await foreignOwner.post(archiveUrl, { headers: authRequestHeaders(baseURL), data: { archived: true } })).status())
    await expectStatus(await owner.post(archiveUrl, { headers: authRequestHeaders(baseURL), data: {} }), 422)
    expect((await loadMailbox(owner, 'current')).some(thread => thread.id === threadId)).toBe(true)

    // Archiving twice at once and once more after files it once. It is this owner's filing:
    // no message is written, and the other owner still has it in Messages.
    const archive = () => owner.post(archiveUrl, { headers: authRequestHeaders(baseURL), data: { archived: true } })
    for (const response of await Promise.all([archive(), archive()])) {
      await expectStatus(response, 200)
      expect(await response.json()).toEqual({ archived: true })
    }
    await expectStatus(await archive(), 200)
    expect((await loadThreadDetail(owner, threadId)).stream.map(item => item.id)).toEqual(streamBefore)
    expect((await loadMailbox(owner, 'current')).some(thread => thread.id === threadId)).toBe(false)
    expect((await loadMailbox(owner, 'past')).some(thread => thread.id === threadId)).toBe(true)
    expect((await loadMailbox(secondOwner, 'current')).some(thread => thread.id === threadId)).toBe(true)
    // Archiving dismisses the reply the owner owed, as Dismiss does.
    expect(await loadReplyTasks(owner, organizationSlug(), threadId)).toEqual([{ section: 'done', tasks: [
      expect.objectContaining({ kind: 'guest_reply', status: 'skipped', conversation_id: threadId, outcome: expect.objectContaining({ closed_by: 'You' }) }),
    ] }])
    expect(await loadThreadActions(owner, threadId)).toMatchObject({ archive: false, unarchive: true })

    const unarchive = () => owner.post(archiveUrl, { headers: authRequestHeaders(baseURL), data: { archived: false } })
    for (const response of await Promise.all([unarchive(), unarchive()])) await expectStatus(response, 200)
    await expectStatus(await unarchive(), 200)
    expect((await loadThreadDetail(owner, threadId)).stream.map(item => item.id)).toEqual(streamBefore)
    expect((await loadMailbox(owner, 'current')).some(thread => thread.id === threadId)).toBe(true)
    expect(await loadThreadActions(owner, threadId)).toMatchObject({ archive: true, unarchive: false })

    // Filing it away and back is not conversation activity: the newer thread
    // is still ahead of it.
    const order = (await loadMailbox(owner, 'current')).map(thread => thread.id)
    expect(order.indexOf(newer!.id)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(newer!.id)).toBeLessThan(order.indexOf(threadId))

  } finally {
    await Promise.all([owner.dispose(), guest.dispose(), secondOwner.dispose(), foreignOwner.dispose()])
  }
})

test('suggested replies fill the composer, hide while typing or after ×, and come back from +', async ({ page, request }) => {
  test.skip(!writable, 'Guest-thread writes require disposable local or preview data')
  await page.setViewportSize({ width: 1440, height: 900 })
  await loginAs(page.request, baseURL, ownerId)
  const guestName = `Suggestions ${Date.now()}`
  await submitContact(request, guestName)
  const { threads } = await loadThreadList(page.request, guestName)
  expect(threads).toHaveLength(1)
  const threadId = threads[0]!.id
  // The drafts come from Workers AI, which the E2E server has no binding for; the
  // composer's behaviour around them is what this covers, so their words are fixed here.
  const drafts = ['Thanks for writing, we will check and get back to you.', 'Happy to help with that.']
  await page.route(new RegExp(`/guest-threads/${threadId}/suggested-reply(\\?|$)`), route => route.fulfill({ json: { generation_id: 'e2e-generation', suggestions: drafts } }))
  await dismissPreviewToolbar(page)
  await page.goto(`${baseURL}/dashboard/${organizationSlug()}/messages/${threadId}`)

  const label = page.getByText('Suggested replies', { exact: true })
  const rows = drafts.map(draft => page.getByRole('button', { name: draft, exact: true }))
  const field = page.getByRole('textbox', { name: 'Write a message…', exact: true })
  const plus = page.getByRole('button', { name: 'Add to message', exact: true })
  const recall = page.getByRole('menuitem', { name: 'Suggested replies' })
  await expect(label).toBeVisible()
  for (const row of rows) await expect(row).toBeVisible()
  // Nothing is pre-written: the field starts empty.
  await expect(field).toHaveValue('')

  // While shown, + offers no way to show them.
  await plus.click()
  await expect(recall).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Typing puts them away; + brings them back.
  await field.fill('Let me check')
  await expect(label).toHaveCount(0)
  await plus.click()
  await recall.click()
  for (const row of rows) await expect(row).toBeVisible()

  // × puts them away too; + brings them back again.
  await page.getByRole('button', { name: 'Dismiss suggested replies', exact: true }).click()
  await expect(label).toHaveCount(0)
  await plus.click()
  await recall.click()
  await expect(label).toBeVisible()

  // A tap fills the field and sends nothing.
  let replies = 0
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/messages/${threadId}`) replies += 1
  })
  await rows[1]!.click()
  await expect(field).toHaveValue(drafts[1]!)
  expect(replies).toBe(0)
})

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
]) {
  test(`In this conversation archives a conversation and moves it back (${viewport.name})`, async ({ page, request }) => {
    test.skip(!writable, 'Guest-thread writes require disposable local or preview data')
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await loginAs(page.request, baseURL, ownerId)
    const nonce = Date.now()
    const guestName = `Mailbox row ${viewport.name} ${nonce}`
    await submitContact(request, `Mailbox next row ${viewport.name} ${nonce}`)
    await submitContact(request, guestName)
    await dismissPreviewToolbar(page)

    // The rows are server-rendered. Wait for hydration and the desktop selection.
    const messages = `${baseURL}/dashboard/${organizationSlug()}/messages`
    const thread = page.locator('#dashboard-panel-organization-messages-thread')
    const expectInbox = async (query: string) => {
      await expect(page.locator('[data-conversation-list-hydrated="true"]')).toBeVisible()
      if (viewport.name === 'desktop') {
        await expect(page).toHaveURL(url => url.href.startsWith(`${messages}/`) && url.search === query)
        const selected = page.locator('[data-thread-row]').first()
        await expect(selected).toHaveAttribute('data-thread-row', /.+/)
        await expect(page).toHaveURL(`${messages}/${await selected.getAttribute('data-thread-row')}${query}`)
      } else {
        await expect(page).toHaveURL(`${messages}${query}`)
        await expect(thread).toHaveCount(0)
      }
    }
    const openMessages = async (query = '') => {
      await page.goto(`${messages}${query}`)
      await expectInbox(query)
    }
    const rowFor = (name: string) => page.locator('[data-thread-row]').filter({ hasText: name })
    // The conversation's actions are in its header's "In this conversation" sheet, not on the row.
    const sheetButton = thread.getByRole('button', { name: 'In this conversation', exact: true })
    const sheet = page.getByRole('dialog', { name: 'In this conversation' })
    const openConversation = async (id: string, query = '') => {
      await page.locator(`[data-thread-row="${id}"]`).click()
      await expect(page).toHaveURL(new RegExp(`/messages/${id}${query.replace('?', '\\?')}$`))
      // The URL changes before the new conversation replaces the old one; its header names which is open.
      await expect(thread.locator(`[data-thread-id="${id}"]`)).toBeVisible()
      await expect(sheetButton).toBeVisible()
    }

    await openMessages()
    await page.reload()
    await expectInbox('')
    await expect(rowFor(guestName)).toBeVisible()
    await expect(rowFor(guestName).getByRole('button')).toHaveCount(0)
    const threadId = await rowFor(guestName).getAttribute('data-thread-row')
    await openConversation(threadId!)
    await sheetButton.click()
    await expect(sheet.getByRole('button', { name: 'Archive', exact: true })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Move to Messages', exact: true })).toHaveCount(0)
    const archived = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/messages/${threadId}/archive`))
    await sheet.getByRole('button', { name: 'Archive', exact: true }).click()
    expect((await archived).status()).toBe(200)
    await expect(sheet).toHaveCount(0)
    await expect(rowFor(guestName)).toHaveCount(0)
    // The archived conversation closes. Desktop selects the next visible row.
    await expectInbox('')

    await openMessages('?archived=')
    await expect(rowFor(guestName)).toBeVisible()

    // Moving it back keeps the conversation open where it is read, and it
    // leaves Past for Current. In Past its guest can still be reported or blocked.
    await openConversation(threadId!, '?archived=')
    await sheetButton.click()
    await expect(sheet.getByRole('button', { name: 'Report', exact: true })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Block', exact: true })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0)
    const moved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/messages/${threadId}/archive`))
    await sheet.getByRole('button', { name: 'Move to Messages', exact: true }).click()
    expect((await moved).status()).toBe(200)
    await expect(sheet).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/messages/${threadId}\\?archived=$`))
    if (viewport.name === 'desktop') await expect(rowFor(guestName)).toHaveCount(0)

    await openMessages()
    await expect(rowFor(guestName)).toBeVisible()
    // Keyboard: the header's button is reachable and opens the sheet with Enter.
    await openConversation(threadId!)
    await sheetButton.focus()
    await page.keyboard.press('Enter')
    await expect(sheet.getByRole('button', { name: 'Archive', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  })
}

test('Calendar retains confirmed table bookings and their detail sends one change request', async ({ page }, testInfo) => {
  test.skip(!writable, 'Today writes require disposable local or preview data')
  releaseDemoLock = await acquireTenantMutationLock(testInfo, demoOrganizationId())
  await loginAs(page.request, baseURL)

  const now = Date.now()
  const firstName = 'Maya'
  const guestName = `${firstName} Chen`
  const guestEmail = `maya-${now}@example.test`
  const timezone = seededTenant('restaurant').locations.brooklyn!.timezone
  // The Today tab shows only bookings whose day key equals the location's current local day, and
  // the site offers no seating already past. Brooklyn's ordinary hours end at 22:00, so once a run
  // starts after the last seating there is nothing left to book today. The owner adds a seating for
  // the rest of today, and dated hours keep the location open for it, rather than depending on the
  // hour CI happens to start. One reading of the location's clock feeds both the lookup and the
  // chosen minute; reading it twice could straddle local midnight.
  const localToday = localNow(timezone)
  const todaySlot = openableMinuteToday(localToday, await loadLocationDay(page.request, localToday.date, timezone), timezone)
  test.skip(
    !todaySlot,
    `${timezone} is within ${TODAY_SLOT_LEAD_MINUTES} minutes of midnight, so no table can still be booked for today`,
  )
  priorSpecialHours = { value: await readSpecialHours(page.request) }
  await expectStatus(await setLocationSlot(page.request, todaySlot!), 200)
  const todayStart = localDateTimeToInstant(todaySlot!.date, todaySlot!.time, timezone, 'reject')
  const todaySeating = (await tableSeatings(page.request)).find(session => session.starts_at === todayStart.toISOString())
  expect(todaySeating, 'The seating added for today is offered on the site').toBeDefined()

  const bookingIds: string[] = []
  const requestIds: string[] = []
  const futureSeating = await openSeating(page.request, 2, 2 * 86_400_000)
  // Two days out, so the change request below is inside the 24-hour change window whatever the hour.
  for (const [name, email, seating] of [
    [guestName, guestEmail, todaySeating!],
    ['Priya Patel', `priya-${now}@example.test`, futureSeating],
  ] as const) {
    const booked = await bookTable(page.request, { name, email, phone: '+12025550123', partySize: 2, seating })
    bookingIds.push(booked.bookingId)
    requestIds.push(booked.requestId)
  }
  const upcomingBookingId = bookingIds[1]!

  await dismissPreviewToolbar(page)

  await page.goto(`${baseURL}/dashboard/${demoSlug()}`)
  // A table is held by the member its tables name: today's is theirs to prepare for on Today.
  const todayResponse = await page.request.get('/api/dashboard/today', { params: { org: demoSlug() } })
  await expectStatus(todayResponse, 200)
  const todayFeed = await todayResponse.json() as BusinessToday
  const prep = todayFeed.tasks.flatMap(section => section.tasks).filter(task => task.kind === 'consultation_prep' && task.product_session_id === todaySeating!.id)
  expect(prep).toMatchObject([{ booking_id: null, status: 'open', path: expect.stringContaining(`/calendar?date=${localToday.date}`) }])
  const agendaResponse = await page.request.get('/api/dashboard/agenda', { params: { org: demoSlug(), from: localToday.date, to: localDateAt(new Date(now + 5 * 86_400_000), timezone) } })
  await expectStatus(agendaResponse, 200)
  const agenda = await agendaResponse.json() as { items: Array<{ id: string; to: string; starts_at: string; ends_at: string }> }
  const reservation = agenda.items.find(item => item.id === `booking:${requestIds[0]}`)
  expect(reservation?.to).toBe(`/dashboard/${demoSlug()}/bookings/${bookingIds[0]}`)
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toBeVisible()
  const prepCalendar = await page.goto(`${baseURL}${prep[0]!.path}`)
  expect(prepCalendar?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible()
  await expect(page.getByText('The calendar could not be loaded')).toHaveCount(0)

  const upcomingResponse = await page.request.get('/api/dashboard/today', { params: { org: demoSlug(), range: 'upcoming' } })
  await expectStatus(upcomingResponse, 200)
  const upcomingFeed = await upcomingResponse.json() as BusinessToday
  expect(upcomingFeed.tasks.flatMap(section => section.tasks).filter(task => task.kind === 'consultation_prep' && task.product_session_id === futureSeating.id))
    .toMatchObject([{ booking_id: null, status: 'open' }])
  const upcomingReservation = agenda.items.find(item => item.id === `booking:${requestIds[1]}`)
  expect(upcomingReservation?.to).toBe(`/dashboard/${demoSlug()}/bookings/${upcomingBookingId}`)
  expect(localDateAt(new Date(upcomingReservation!.starts_at), timezone) > localToday.date).toBe(true)

  await page.goto(`${baseURL}${reservation!.to}`)
  const instant = new Date().toISOString()
  await expect(page.locator('#dashboard-panel-booking-details').getByRole('heading', { name: reservation!.starts_at <= instant && instant < reservation!.ends_at! ? 'Currently hosting' : 'Today', exact: true })).toBeVisible()
  await expect(page.getByText(guestName, { exact: true }).first()).toBeVisible()
  await expect(page.getByText(guestEmail, { exact: true })).toHaveCount(0)
  const detailPanel = page.locator('#dashboard-panel-booking-details')
  const body = detailPanel.locator(':scope > [data-slot="body"]')
  const summaryResponse = await page.request.get(`/api/dashboard/bookings/${bookingIds[0]}`, { params: { org: demoSlug() } })
  await expectStatus(summaryResponse, 200)
  const summary = (await summaryResponse.json() as { booking: DashboardBookingDetails }).booking
  expect(summary).toMatchObject({ guest_name: guestName, guest_phone: '+12025550123', party_size: 2 })
  expect(summary.resource_image_url, 'This reservation has its location’s actual authored picture').not.toBeNull()
  expect(summary.conversation_id).not.toBeNull()
  const priorViewport = page.viewportSize()!
  let desktopCountWidth: number | undefined
  for (const width of [1728, 390]) {
    await page.setViewportSize({ width, height: 940 })
    const identity = detailPanel.getByRole('heading', { level: 2, name: `${firstName}’s group of ${summary.party_size}`, exact: true })
    const message = detailPanel.getByRole('link', { name: 'Message guest', exact: true })
    const call = detailPanel.getByRole('link', { name: 'Call', exact: true })
    await expect(message).toHaveAttribute('href', `/dashboard/${demoSlug()}/messages/${encodeURIComponent(summary.conversation_id!)}`)
    await expect(call).toHaveAttribute('href', `tel:${summary.guest_phone}`)
    await expect(identity).toBeInViewport()
    await expect(message).toBeInViewport()
    await expect(call).toBeInViewport()
    const otherGuests = detailPanel.getByLabel(`${summary.party_size! - 1} other ${summary.party_size === 2 ? 'guest' : 'guests'}`, { exact: true })
    const guestGroup = otherGuests.locator('..')
    const mainAvatar = guestGroup.locator(':scope > [data-slot="root"]')
    await expect(guestGroup).toBeInViewport()
    await expect(mainAvatar).toHaveCount(1)
    if (summary.guest_image_url) await expect(guestGroup.getByAltText(summary.guest_name!, { exact: true })).toHaveAttribute('src', summary.guest_image_url)
    else await expect(mainAvatar).toHaveText(summary.guest_name!.trim().slice(0, 1))
    const bodyBounds = (await body.boundingBox())!
    const guestBounds = (await guestGroup.boundingBox())!
    const avatarBounds = (await mainAvatar.boundingBox())!
    const countBounds = (await otherGuests.boundingBox())!
    const identityBounds = (await identity.boundingBox())!
    const paneBounds = (await detailPanel.boundingBox())!
    const paneCenter = paneBounds.x + paneBounds.width / 2
    expect(avatarBounds.width, 'The guest is dominant within the group').toBeGreaterThan(countBounds.width)
    expect(avatarBounds.height).toBeGreaterThan(countBounds.height)
    expect(avatarBounds.height).toBe(avatarBounds.width)
    expect(countBounds.height).toBe(countBounds.width)
    expect(countBounds.y, 'The smaller guest count is raised beside the guest').toBeLessThan(avatarBounds.y)
    expect(countBounds.x + countBounds.width / 2).toBeGreaterThan(avatarBounds.x + avatarBounds.width / 2)
    if (width === 1728) desktopCountWidth = countBounds.width
    else expect(desktopCountWidth, 'The desktop guest counter is larger than the phone counter').toBeGreaterThan(countBounds.width)
    const picture = detailPanel.locator('img[alt=""]').first()
    await expect(picture).toHaveAttribute('src', summary.resource_image_url!)
    await expect.poll(() => picture.evaluate(image => (image as HTMLImageElement).naturalWidth), { message: 'The resource photo loads' }).toBeGreaterThan(0)
    const pictureBounds = (await picture.boundingBox())!
    expect(pictureBounds.y, 'The photo leads the record').toBeGreaterThanOrEqual(bodyBounds.y)
    expect(pictureBounds.width, 'The photo leads as a substantial square').toBeGreaterThanOrEqual(280)
    expect(pictureBounds.height).toBe(pictureBounds.width)
    expect(Math.abs(pictureBounds.x + pictureBounds.width / 2 - paneCenter)).toBeLessThanOrEqual(1)
    expect(guestBounds.y, 'The guests overlap the photo’s lower edge').toBeLessThan(pictureBounds.y + pictureBounds.height)
    expect(guestBounds.y + guestBounds.height).toBeGreaterThan(pictureBounds.y + pictureBounds.height)
    expect(identityBounds.y - guestBounds.y - guestBounds.height, 'The party title follows the guest cluster at the measured Airbnb spacing').toBe(width === 1728 ? 32 : 24)
    expect(Math.abs(guestBounds.x + guestBounds.width / 2 - paneCenter)).toBeLessThanOrEqual(1)
    expect(Math.abs(identityBounds.x + identityBounds.width / 2 - paneCenter), 'The record header centers in its visible pane').toBeLessThanOrEqual(1)
    expect(await identity.evaluate(element => getComputedStyle(element).textAlign)).toBe('center')
    const paymentInfo = detailPanel.getByRole('heading', { name: 'Payment info', exact: true })
    await expect(paymentInfo).toHaveCount(summary.payments?.length ?? 0)
    const sections = [
      detailPanel.getByText('Date', { exact: true }),
      detailPanel.getByRole('heading', { name: 'Private note', exact: true }),
      detailPanel.getByRole('link', { name: `Guests ${summary.guest_name} · ${summary.party_size} guests`, exact: true }),
      detailPanel.getByRole('button', { name: /^Cancellation policy/ }),
      ...await paymentInfo.all(),
      detailPanel.getByRole('button', { name: 'Manage reservation', exact: true }),
      detailPanel.getByText('Booking date', { exact: true }),
    ]
    for (let at = 1; at < sections.length; at++) {
      const previous = (await sections[at - 1]!.boundingBox())!
      const current = (await sections[at]!.boundingBox())!
      expect(current.y, 'The reservation’s sections follow their reading order vertically').toBeGreaterThan(previous.y)
    }
    const date = (await detailPanel.getByText('Date', { exact: true }).boundingBox())!
    const time = (await detailPanel.getByText('Time', { exact: true }).boundingBox())!
    expect(time.y).toBe(date.y)
    const todayPanel = page.locator('#dashboard-panel-org-today')
    if (width === 1728) {
      await expect(todayPanel).toBeVisible()
      const agendaBounds = (await todayPanel.boundingBox())!
      const detailBounds = (await detailPanel.boundingBox())!
      expect(detailBounds.x).toBeGreaterThanOrEqual(agendaBounds.x + agendaBounds.width - 1)
    } else await expect(todayPanel).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const footer = detailPanel.locator(':scope > div').filter({ has: page.getByRole('link', { name: 'Message guest', exact: true }) })
    await expect(footer).toHaveCount(1)
    const footerBounds = (await footer.boundingBox())!
    const messageBefore = await message.boundingBox()
    const callBefore = await call.boundingBox()
    expect(Math.abs((messageBefore!.x + callBefore!.x + callBefore!.width) / 2 - paneCenter), 'Contact actions center in the same visible pane as the record header').toBeLessThanOrEqual(1)
    const maximum = await body.evaluate(element => element.scrollHeight - element.clientHeight)
    // A short record may fit without scrolling; its native end must still
    // expose the final metadata above the pinned contact actions.
    await page.mouse.move(bodyBounds.x + 4, bodyBounds.y + bodyBounds.height / 2)
    await page.mouse.wheel(0, maximum + bodyBounds.height)
    await expect.poll(() => body.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
    await expect(message).toBeInViewport({ ratio: 1 })
    await expect(call).toBeInViewport({ ratio: 1 })
    expect(await message.boundingBox()).toEqual(messageBefore)
    expect(await call.boundingBox()).toEqual(callBefore)
    const recordMade = detailPanel.getByText('Booking date', { exact: true }).locator('..')
    await expect(recordMade).toBeInViewport({ ratio: 1 })
    const madeBounds = (await recordMade.boundingBox())!
    expect(madeBounds.y + madeBounds.height, 'The final metadata clears the pinned actions').toBeLessThanOrEqual(footerBounds.y + 1)
    const endCapture = testInfo.outputPath(`reservation-details-end-${width}.png`)
    await page.screenshot({ path: endCapture, ...(width === 1728 ? { clip: paneBounds } : { fullPage: false }) })
    await testInfo.attach(`reservation-details-end-${width}`, { path: endCapture, contentType: 'image/png' })
    await page.mouse.wheel(0, -maximum - bodyBounds.height)
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0)
    const capture = testInfo.outputPath(`reservation-details-${width}.png`)
    // Show the actual desktop detail pane without publishing copied
    // conversations elsewhere in Today's local fixture. Mobile is this record.
    const detailBounds = (await detailPanel.boundingBox())!
    await page.screenshot({ path: capture, ...(width === 1728 ? { clip: detailBounds } : { fullPage: false }) })
    await testInfo.attach(`reservation-details-${width}`, { path: capture, contentType: 'image/png' })
  }
  await page.setViewportSize(priorViewport)
  await detailPanel.getByRole('link', { name: `Guests ${summary.guest_name} · ${summary.party_size} guests`, exact: true }).click()
  await expect(page.getByText(guestEmail, { exact: true })).toBeVisible()
  await page.goBack()

  // The team's one private note lives on the booking, saved as a whole when the field is left; it never enters the conversation.
  const note = `Today page note ${Date.now()}`
  const noteContext = `?range=upcoming&location_id=${demoLocationId()}&kinds=booking`
  const recordPath = `/dashboard/${demoSlug()}/bookings/${bookingIds[0]}`
  const noteEndpoint = `/api/dashboard/bookings/${bookingIds[0]}`
  const readBooking = async () => {
    const read = await page.request.get(`/api/dashboard/bookings/${bookingIds[0]}`, { params: { org: demoSlug() } })
    await expectStatus(read, 200)
    return (await read.json() as { booking: DashboardBookingDetails }).booking
  }
  await page.goto(`${baseURL}${recordPath}${noteContext}`)
  const noteInput = detailPanel.getByRole('textbox', { name: 'Private note', exact: true })
  for (const [written, expectedUpdatedAt] of [[note, summary.updated_at], [`${note} revised`, null]] as const) {
    const before = await readBooking()
    if (expectedUpdatedAt) expect(before.updated_at).toBe(expectedUpdatedAt)
    await noteInput.fill(written)
    const noteWrite = page.waitForResponse(response => new URL(response.url()).pathname === noteEndpoint && response.request().method() === 'PATCH')
    await detailPanel.getByText('Private note', { exact: true }).click()
    const noteResponse = await noteWrite
    await expectStatus(noteResponse, 200)
    expect(noteResponse.request().postDataJSON()).toEqual({ private_notes: written, version: before.version })
    // Read back through the booking, not the write's own answer.
    expect((await readBooking()).private_notes).toBe(written)
    await expect(noteInput).toHaveValue(written)
    // Nothing in the conversation carries it: no message, event or preview.
    expect(JSON.stringify(await loadThreadDetail(page.request, summary.conversation_id!, demoOrganizationId()))).not.toContain(written)
  }

  // Change is one sheet beneath the record, as Airbnb's: the details are edited
  // in place and one footer commit sends the request the guest confirms.
  await detailPanel.getByRole('button', { name: 'Manage reservation', exact: true }).click()
  const manage = page.getByRole('dialog', { name: 'Manage reservation', exact: true })
  await manage.getByRole('link', { name: 'Change reservation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'What do you want to change?', exact: true })).toBeVisible()
  await expect(page.getByText(`Nothing changes until ${firstName} accepts.`)).toBeVisible()
  await expect(page.getByLabel('Date', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeVisible()

  const changeContext = `?range=upcoming&location_id=${demoLocationId()}&kinds=booking`
  await page.goto(`${baseURL}/dashboard/${demoSlug()}/bookings/${upcomingBookingId}/change${changeContext}`)
  const beforeResponse = await page.request.get(
    `/api/dashboard/bookings/${upcomingBookingId}`,
    { params: { org: demoSlug() } },
  )
  await expectStatus(beforeResponse, 200)
  const before = await beforeResponse.json() as { booking: { party_size: number; conversation_id: string } }
  const targetPartySize = before.booking.party_size === 99 ? 98 : before.booking.party_size + 1
  await page.getByRole('spinbutton', { name: 'Guests', exact: true }).fill(String(targetPartySize))
  // A typed count enables Send without leaving the field.
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeEnabled()
  const requestedAt = new Date().toISOString()
  const requestCompleted = page.waitForResponse(response =>
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith(`/api/dashboard/bookings/${upcomingBookingId}/move`),
  )
  await page.getByRole('button', { name: 'Send request', exact: true }).click()
  const changeResponse = await requestCompleted
  expect(changeResponse.status(), await changeResponse.text()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Coming up', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(`${baseURL}/dashboard/${demoSlug()}/bookings/${upcomingBookingId}${changeContext}`)

  const detail = await loadThreadDetail(page.request, before.booking.conversation_id, demoOrganizationId())
  const requests = detail.stream.filter((item): item is StreamEvent => item.type === 'event' && item.sent_at >= requestedAt && item.text.startsWith('Requested '))
  expect(requests).toHaveLength(1)
  const pendingRecord = await page.request.get(`/api/dashboard/bookings/${upcomingBookingId}`, { params: { org: demoSlug() } })
  await expectStatus(pendingRecord, 200)
  expect(await pendingRecord.json()).toMatchObject({ booking: { pending_change: { message_id: requests[0]!.id, before: { party_size: before.booking.party_size }, after: { party_size: targetPartySize } } } })
  await page.goto(`${baseURL}/dashboard/${demoSlug()}/messages/${before.booking.conversation_id}`)
  const reservationLink = page.getByRole('link', { name: 'Show reservation', exact: true })
  await expect(reservationLink).toHaveAttribute('href', `/dashboard/${demoSlug()}/bookings/${upcomingBookingId}`)
  await expect(page.getByTestId('booking-change-request')).toHaveCount(0)
  await reservationLink.click()
  await expect(page.getByTestId('booking-change-request')).toContainText('Change requested')
  const deliveryResponse = await page.request.get('/api/dev/notifications', {
    headers: devLoginHeaders(),
    params: { organization_id: demoOrganizationId(), since: requestedAt },
  })
  await expectStatus(deliveryResponse, 200)
  const deliveries = (await deliveryResponse.json() as DeliveryList).deliveries.filter(row => row.message_id === requests[0]!.id)
  expect(deliveries.some(row => row.purpose === 'status_update' && row.status === 'sent')).toBe(true)
  expect(deliveries.some(row => row.purpose === 'owner_alert' && row.status === 'sent')).toBe(true)

  if (local) {
    const request = requests[0]!
    const token = createHmac('sha256', 'local-playwright-email-reply-secret')
      .update(`booking-change:v1:${before.booking.conversation_id}:${request.id}`)
      .digest('hex')
    await page.goto(`${baseURL}/booking-changes/${before.booking.conversation_id}/${request.id}#${token}`)
    await expect(page.getByRole('button', { name: 'Accept changes', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Accept changes', exact: true }).click()
    await expect(page.getByText('Your booking has been updated.', { exact: true })).toBeVisible()

    const afterResponse = await page.request.get(
      `/api/dashboard/bookings/${upcomingBookingId}`,
      { params: { org: demoSlug() } },
    )
    await expectStatus(afterResponse, 200)
    expect(await afterResponse.json()).toMatchObject({ booking: { party_size: targetPartySize, pending_change: null } })
    const afterDetail = await loadThreadDetail(page.request, before.booking.conversation_id, demoOrganizationId())
    expect(streamEvents(afterDetail, 'Your change was accepted')).toHaveLength(1)
  }
})

test('buyer opens the reservation from chat to decide a booking change', async ({ page, playwright }, testInfo) => {
  test.skip(!local, 'Buyer decisions and log-only delivery use disposable local data')
  releaseDemoLock = await acquireTenantMutationLock(testInfo, demoOrganizationId())
  const owner = await playwright.request.newContext({ baseURL })
  let threadId: string | null = null
  let changeBookingId: string | null = null
  try {
    await loginAs(owner, baseURL, 'user-e2e-demo-owner')
    await loginAs(page.request, baseURL, 'user-e2e-buyer')
    // A table's recurring hours make it bookable a year ahead.
    const seating = await openSeating(page.request, 2, 365 * 86_400_000)
    // The guest's own Messages count: their conversations with something from the business they have not read.
    const guestUnread = async () => {
      const response = await page.request.get('/api/messages/unread-count')
      await expectStatus(response, 200)
      return (await response.json() as { count: number }).count
    }
    const unreadBefore = await guestUnread()
    const booked = await bookTable(page.request, { name: 'E2E Buyer', email: 'buyer@playwright.example', phone: '+12025550123', partySize: 1, seating })
    threadId = booked.requestId
    changeBookingId = booked.bookingId
    const read = async () => {
      const response = await owner.get(`/api/dashboard/bookings/${booked.bookingId}`, { params: { org: demoSlug() } })
      await expectStatus(response, 200)
      return (await response.json() as { booking: { version: number; updated_at: string; booking_date: string; booking_time: string; party_size: number; location_id: string; product_session_id: string; pending_change: { message_id: string; before: { party_size: number }; after: { party_size: number } } | null } }).booking
    }
    const original = await read()
    const movePath = `/api/dashboard/bookings/${booked.bookingId}/move`
    const moveParams = { org: demoSlug() }
    const requestChange = async (partySize: number) => {
      const current = await read()
      const data = { apply: false, product_session_id: current.product_session_id, party_size: partySize, version: current.version, idempotency_key: crypto.randomUUID() }
      const response = await owner.post(movePath, { params: moveParams, data })
      await expectStatus(response, 200)
      expect(await response.json()).toMatchObject({ change_status: 'awaiting_guest_acceptance', booking: { booking_id: booked.bookingId } })
      const proposal = (await read()).pending_change
      expect(proposal).toMatchObject({ message_id: expect.any(String), before: { party_size: current.party_size }, after: { party_size: partySize } })
      return { id: proposal!.message_id, data }
    }
    const first = await requestChange(2)
    expect(await read()).toMatchObject({ party_size: 1, booking_date: original.booking_date, booking_time: original.booking_time })
    const ownerPage = await page.context().browser()!.newPage({ baseURL })
    try {
      await loginAs(ownerPage.request, baseURL, 'user-e2e-demo-owner')
      await ownerPage.goto(`${baseURL}/dashboard/${demoSlug()}/messages/${threadId}`)
      const reservation = ownerPage.getByRole('link', { name: 'Show reservation', exact: true })
      await expect(reservation).toHaveAttribute('href', `/dashboard/${demoSlug()}/bookings/${booked.bookingId}`)
      await expect(ownerPage.getByTestId('booking-change-request')).toHaveCount(0)
      await reservation.click()
      await expect(ownerPage.getByTestId('booking-change-request')).toContainText('Change requested')
    } finally {
      await ownerPage.context().close()
    }
    expect(await guestUnread(), 'The business’s change request is unread in the guest’s Messages').toBe(unreadBefore + 1)
    await dismissPreviewToolbar(page)
    const guestRead = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/messages/${threadId}/read`)
    await page.goto(`${baseURL}/dashboard/account/messages/${threadId}`)
    await expectStatus(await guestRead, 200)
    expect(await guestUnread(), 'Opening the conversation reads it').toBe(unreadBefore)
    await expect(page.getByText(/^Requested .+ for 2 guests/)).toBeVisible()
    await expect(page.getByRole('button', { name: /^(Accept|Decline)( changes)?$/ })).toHaveCount(0)
    await page.getByRole('link', { name: 'Show reservation', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}/dashboard/account/activity/booking/${threadId}`)
    const card = page.getByTestId('booking-change-request')
    await expect(card).toContainText('1 guest')
    await expect(card).toContainText('2 guests')
    const declined = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.startsWith(`/api/public/booking-changes/${threadId}/`))
    await card.getByRole('button', { name: 'Decline', exact: true }).click()
    await expectStatus(await declined, 200)
    await expect(card).toHaveCount(0)
    expect(await read()).toMatchObject({ party_size: 1, booking_date: original.booking_date, booking_time: original.booking_time, pending_change: null })
    const afterDecline = await loadThreadDetail(owner, threadId, demoOrganizationId())
    expect(streamEvents(afterDecline, 'E2E Buyer’s change was declined')).toHaveLength(1)
    const declinedReplay = await owner.post(movePath, { params: moveParams, data: first.data })
    await expectStatus(declinedReplay, 200)
    expect(await declinedReplay.json()).toMatchObject({ change_status: 'declined', booking: { booking_id: booked.bookingId, party_size: 1 } })

    const second = await requestChange(2)
    await expect(card).toHaveCount(1)
    const accepted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.startsWith(`/api/public/booking-changes/${threadId}/`))
    await card.getByRole('button', { name: 'Accept', exact: true }).click()
    await expectStatus(await accepted, 200)
    await expect(card).toHaveCount(0)
    expect(await read()).toMatchObject({ party_size: 2, booking_date: original.booking_date, booking_time: original.booking_time, pending_change: null })
    const final = await loadThreadDetail(owner, threadId, demoOrganizationId())
    expect(streamEvents(final, 'E2E Buyer’s change was accepted')).toHaveLength(1)
    const acceptedReplay = await owner.post(movePath, { params: moveParams, data: second.data })
    await expectStatus(acceptedReplay, 200)
    expect(await acceptedReplay.json()).toMatchObject({ change_status: 'accepted', booking: { booking_id: booked.bookingId, party_size: 2 } })
    const replay = await page.request.post(`/api/public/booking-changes/${threadId}/${second.id}`, {
      headers: authRequestHeaders(baseURL), data: { decision: 'accept' },
    })
    await expectStatus(replay, 200)
    // The replayed answer is the same answer: still one acceptance in the conversation.
    const replayed = await loadThreadDetail(owner, threadId, demoOrganizationId())
    expect(streamEvents(replayed, 'E2E Buyer’s change was accepted')).toHaveLength(1)
    await page.goto(`${baseURL}/dashboard/account/activity/booking/${threadId}`)
    await page.getByRole('button', { name: 'Manage reservation', exact: true }).click()
    await page.getByRole('link', { name: 'Send a change request', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}/dashboard/account/messages/${threadId}?intent=booking-change`)
    const changeMessage = 'Could we move this reservation later? Please send an available time.'
    await expect(page.getByText('Describe the dates, time or guest details you would like to change. The business will review your request before anything changes.', { exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Write a message…', exact: true }).fill(changeMessage)
    const sent_at = new Date().toISOString()
    const sentRequest = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/messages/${threadId}`)
    await page.getByRole('button', { name: 'Send a change request', exact: true }).click()
    await expectStatus(await sentRequest, 200)
    await expect(page.getByText('Your change request was sent to the business. Your booking is unchanged while it is reviewed.', { exact: true })).toBeVisible()
    // A guest's request is a message for the business to answer; the reservation itself has not moved.
    const requested = await loadThreadDetail(owner, threadId, demoOrganizationId())
    expect(await read()).toMatchObject({ party_size: 2, booking_date: original.booking_date, booking_time: original.booking_time })
    // It is the owner's open reply task on Today, quoting the guest's words.
    expect(await loadReplyTasks(owner, demoSlug(), threadId)).toEqual([{ section: 'open', tasks: [expect.objectContaining({
      kind: 'guest_reply', status: 'open', detail: changeMessage, conversation_id: threadId,
    })] }])
    const customerRequest = streamMessages(requested).filter(item => item.side === 'guest' && item.body === changeMessage)
    expect(customerRequest).toMatchObject([{ author: 'E2E Buyer' }])
    const requestDelivery = await owner.get('/api/dev/notifications', { headers: devLoginHeaders(), params: { organization_id: demoOrganizationId(), since: sent_at } })
    await expectStatus(requestDelivery, 200)
    expect((await requestDelivery.json() as DeliveryList).deliveries.some(delivery => delivery.message_id === customerRequest[0]!.id && delivery.purpose === 'owner_alert' && delivery.status === 'sent')).toBe(true)
  } finally {
    if (changeBookingId) {
      const current = await owner.get(`/api/dashboard/bookings/${changeBookingId}`, { params: { org: demoSlug() } })
      await expectStatus(current, 200)
      await expectStatus(await owner.post(`/api/dashboard/bookings/${changeBookingId}/cancel`, { params: { org: demoSlug() },
        data: { version: (await current.json()).booking.version, idempotency_key: crypto.randomUUID() } }), 200)
    }
    await owner.dispose()
  }
})
