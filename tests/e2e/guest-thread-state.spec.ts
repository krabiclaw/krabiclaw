import { dismissPreviewToolbar } from './helpers'
import { localDateAt, localNow, unresolvableLocalTime } from '../../utils/timezone'
import { createHmac } from 'node:crypto'
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import type {
  InboxRow,
  InboxStreamItem,
  InboxThread,
  InboxThreadDetails,
} from '../../server/domain/guest-threads/types'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import { devLoginHeaders, seededSiteHeaders, testBaseUrl } from './test-env'
import type { TodayFeedPayload } from '../../shared/dashboard-today'
import type { DashboardBookingDetails } from '../../server/utils/dashboard-booking-details'

interface NotificationView {
  id: string
  title: string | null
  created_at: string
  read_at: string | null
}

interface NotificationList {
  notifications: NotificationView[]
  unread_count: number
  next_cursor: string | null
}

interface DeliveryView {
  id: string
  request_id: string
  entry_id: string
  purpose: string
  status: string
}

interface DeliveryList {
  deliveries: DeliveryView[]
}

const baseURL = testBaseUrl()
// Contact threads run on the seeded experience business; reservations on the
// restaurant's Brooklyn location.
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

async function loadLocationDay(request: APIRequestContext, date: string) {
  const response = await request.get(`/api/editor/organizations/${demoOrganizationId()}/locations/${demoLocationId()}/reservation-availability`, {
    params: { from: date, to: date },
  })
  await expectStatus(response, 200)
  const { days } = await response.json() as { days: Array<{ slots: Array<{ time_slot: string }> }> }
  return new Set((days[0]?.slots ?? []).map(slot => slot.time_slot))
}

/**
 * Dated hours replace the day's ordinary periods, and a slot is generated every
 * thirty minutes from the opening until an hour before closing — so a period
 * exactly sixty minutes wide yields precisely the one minute asked for.
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
  const closeMinute = hours! * 60 + minutes! + 60
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
let priorReservationDuration: { value: number | null } | null = null
let priorSpecialHours: { value: unknown } | null = null
// The Brooklyn location's hours and reservation capacity are shared with the calendar and MCP specs.
let releaseDemoLock: (() => Promise<void>) | null = null

test.afterEach(async ({ page }) => {
  const release = releaseDemoLock
  releaseDemoLock = null
  try {
    if (priorReservationDuration) {
      const duration = priorReservationDuration.value
      priorReservationDuration = null
      const policy = await page.request.get(`/api/editor/organizations/${demoOrganizationId()}/locations/${demoLocationId()}/reservation-config`)
      await expectStatus(policy,200)
      await expectStatus(await page.request.put(`/api/editor/organizations/${demoOrganizationId()}/locations/${demoLocationId()}/reservation-config`, { data: { duration_minutes: duration, expected_updated_at: (await policy.json()).config.updated_at } }),200)
    }
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

// The list has no search of its own any more (search is the dashboard's one
// palette), so the guest under test is picked out of the tenant's contact threads.
async function loadThreadList(request: APIRequestContext, guestName: string) {
  const response = await request.get(`/api/dashboard/organizations/${organizationId()}/guest-threads`, {
    params: { type: 'contact' },
  })
  await expectStatus(response, 200)
  const { threads } = await response.json() as { threads: InboxRow[] }
  return { threads: threads.filter(thread => thread.guestName === guestName) }
}

async function loadThreadDetail(
  request: APIRequestContext,
  threadId: string,
  targetOrganizationId = organizationId(),
) {
  const response = await request.get(`/api/dashboard/organizations/${targetOrganizationId}/guest-threads/${threadId}`)
  await expectStatus(response, 200)
  return (await response.json() as { thread: InboxThread }).thread
}

/** What "In this conversation" offers for the thread, read as the member it was asked by. */
async function loadThreadActions(request: APIRequestContext, threadId: string, targetOrganizationId = organizationId()) {
  const response = await request.get(`/api/dashboard/organizations/${targetOrganizationId}/guest-threads/${threadId}/details`)
  await expectStatus(response, 200)
  return (await response.json() as InboxThreadDetails).actions
}

type StreamMessage = Extract<InboxStreamItem, { type: 'message' }>
type StreamEvent = Extract<InboxStreamItem, { type: 'event' }>
type StreamChange = Extract<InboxStreamItem, { type: 'change' }>
const streamMessages = (thread: InboxThread) => thread.stream.filter((item): item is StreamMessage => item.type === 'message')
const streamEvents = (thread: InboxThread, text: string) => thread.stream.filter((item): item is StreamEvent => item.type === 'event' && item.text === text)
const streamChanges = (thread: InboxThread) => thread.stream.filter((item): item is StreamChange => item.type === 'change')

interface LedgerEntry {
  id: string
  kind: string
  channel: string | null
  body: string | null
  event: string | null
  payload: Record<string, unknown> | null
  occurred_at: string
}

interface Ledger {
  state: string
  archived: boolean
  updated_at: string
  guest: { name: string | null; email: string | null; phone: string | null }
  operational_record: unknown
  entries: LedgerEntry[]
}

/**
 * The conversation's own ledger — state, archive flag, event names and
 * payloads — which the inbox view model keeps on the server. MCP's
 * get_guest_conversation is the surface that still reads it out, and reading
 * it acknowledges nothing.
 */
async function loadLedger(request: APIRequestContext, threadId: string, targetOrganizationId = organizationId()) {
  const response = await mcpRequest(request, baseURL, { method: 'tools/call', toolName: 'get_guest_conversation', args: { organization_id: targetOrganizationId, request_id: threadId } })
  await expectStatus(response, 200)
  return mcpData<{ conversation: Ledger }>(await response.json()).conversation
}

async function loadNotifications(request: APIRequestContext) {
  const response = await request.get('/api/dashboard/notifications', { params: { limit: 50 } })
  await expectStatus(response, 200)
  return await response.json() as NotificationList
}

// The alert addresses the guest by first name, which each proof makes unique to its run.
function contactNotification(state: NotificationList, guestName: string) {
  const notification = state.notifications.find(row => row.title === `Message from ${guestName.split(' ')[0]}`)
  expect(notification).toBeDefined()
  if (!notification) throw new Error('Contact notification was not visible to the owner')
  return notification
}

test('guest thread state stays source-owned, per-user, tenant-isolated, and idempotent', async ({ playwright }) => {
  test.skip(!writable, 'Guest-thread writes require disposable local or preview data')

  const owner = await playwright.request.newContext({ baseURL })
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
    const submission = await owner.post(`/api/public/contact`, {
      headers: seededSiteHeaders('experience'),
      data: { name: guestName, email: guestEmail, subject, message },
    })
    await expectStatus(submission, 201)

    const [ownerListBefore, secondOwnerListBefore, ownerNotificationsBefore, secondOwnerNotificationsBefore] = await Promise.all([
      loadThreadList(owner, guestName),
      loadThreadList(secondOwner, guestName),
      loadNotifications(owner),
      loadNotifications(secondOwner),
    ])
    expect(ownerListBefore.threads).toHaveLength(1)
    expect(secondOwnerListBefore.threads).toHaveLength(1)
    const threadId = ownerListBefore.threads[0]!.id
    const organizationList = await owner.get('/api/dashboard/guest-threads', {
      params: { org: organizationSlug(), type: 'contact' },
    })
    await expectStatus(organizationList, 200)
    expect((await organizationList.json() as { threads: InboxRow[] }).threads.filter(thread => thread.guestName === guestName))
      .toMatchObject([{ id: threadId }])
    await expectStatus(await foreignOwner.get('/api/dashboard/guest-threads', {
      params: { org: organizationSlug(), type: 'contact' },
    }), 404)
    expect(secondOwnerListBefore.threads[0]!.id).toBe(threadId)
    // The row is the guest's own words, from them, on the business's own channel.
    const guestFirstName = guestName.split(' ')[0]!
    expect(ownerListBefore.threads[0]).toMatchObject({ guestName, kind: 'guest', channel: 'direct', preview: message, previewFrom: guestFirstName, unread: true })
    expect(secondOwnerListBefore.threads[0]).toMatchObject({ guestName, kind: 'guest', channel: 'direct', preview: message, previewFrom: guestFirstName, unread: true })
    expect(contactNotification(ownerNotificationsBefore, guestName).read_at).toBeNull()
    expect(contactNotification(secondOwnerNotificationsBefore, guestName).read_at).toBeNull()

    // Two real contacts own the endpoints of this paging proof. Parallel
    // contacts can appear between them; no shared-history row is a premise.
    const firstNotification = contactNotification(ownerNotificationsBefore, guestName)
    const paginationGuestName = `Pagination${nonce} Proof`
    await submitContact(owner, paginationGuestName)
    const newerNotification = contactNotification(await loadNotifications(owner), paginationGuestName)
    expect(newerNotification.created_at > firstNotification.created_at || newerNotification.created_at === firstNotification.created_at && newerNotification.id > firstNotification.id).toBe(true)
    const seenNotifications = new Set([newerNotification.id])
    let cursor = newerNotification
    while (cursor.id !== firstNotification.id) {
      const olderResponse = await owner.get('/api/dashboard/notifications', { params: { limit: 1, after: cursor.id } })
      await expectStatus(olderResponse, 200)
      const older = await olderResponse.json() as NotificationList
      expect(older.notifications).toHaveLength(1)
      const row = older.notifications[0]!
      expect(seenNotifications.has(row.id)).toBe(false)
      expect(row.created_at < cursor.created_at || row.created_at === cursor.created_at && row.id < cursor.id).toBe(true)
      expect(row.created_at > firstNotification.created_at || row.created_at === firstNotification.created_at && row.id >= firstNotification.id).toBe(true)
      if (row.id !== firstNotification.id) expect(older.next_cursor).toBe(row.id)
      seenNotifications.add(row.id)
      cursor = row
    }
    expect(cursor.id).toBe(firstNotification.id)
    // unread_count covers the whole audience and may change when concurrent
    // contacts arrive. Per-user read state is verified exactly below.
    await expectStatus(await foreignOwner.get('/api/dashboard/notifications', { params: { limit: 1, after: newerNotification.id } }), 404)

    const detail = await loadThreadDetail(owner, threadId)
    // A contact has no record behind it, and a reply goes to the email the guest left.
    expect(detail).toMatchObject({
      id: threadId,
      kind: 'guest',
      guestName,
      channel: 'direct',
      when: null,
      recordId: null,
      recordKind: null,
      composer: { channel: 'email', available: true },
    })
    // The guest's own words open the conversation, once, as their message.
    expect(streamMessages(detail)).toMatchObject([{ side: 'guest', author: guestName, body: message, photos: [], translated: null }])
    // The submission's contact details stay in the ledger the opening message was drawn from.
    // The subject the form asked for is no longer drawn anywhere (inbox-parity.md: the opening submission dump is gone).
    const openingLedger = await loadLedger(owner, threadId)
    expect(openingLedger.guest).toEqual({ name: guestName, email: guestEmail, phone: null })
    const openingEntries = openingLedger.entries.filter(entry => entry.kind === 'submission')
    expect(openingEntries).toHaveLength(1)
    expect(openingEntries[0]).toMatchObject({
      id: streamMessages(detail)[0]!.id,
      channel: 'web',
      body: null,
      event: null,
      payload: { kind: 'contact' },
    })

    const [ownerListAfterRead, ownerNotificationsAfterRead, secondOwnerListStillUnread, secondOwnerNotificationsStillUnread] = await Promise.all([
      loadThreadList(owner, guestName),
      loadNotifications(owner),
      loadThreadList(secondOwner, guestName),
      loadNotifications(secondOwner),
    ])
    expect(ownerListAfterRead.threads[0]).toMatchObject({ id: threadId, unread: false })
    expect(contactNotification(ownerNotificationsAfterRead, guestName).read_at).toEqual(expect.any(String))
    expect(secondOwnerListStillUnread.threads[0]).toMatchObject({ id: threadId, unread: true })
    expect(contactNotification(secondOwnerNotificationsStillUnread, guestName).read_at).toBeNull()

    await loadThreadDetail(secondOwner, threadId)
    const [secondOwnerListAfterRead, secondOwnerNotificationsAfterRead] = await Promise.all([
      loadThreadList(secondOwner, guestName),
      loadNotifications(secondOwner),
    ])
    expect(secondOwnerListAfterRead.threads[0]).toMatchObject({ id: threadId, unread: false })
    expect(contactNotification(secondOwnerNotificationsAfterRead, guestName).read_at).toEqual(expect.any(String))

    const foreignRead = await foreignOwner.get(`/api/dashboard/organizations/${organizationId()}/guest-threads/${threadId}`)
    expect([403, 404]).toContain(foreignRead.status())
    const foreignMutation = await foreignOwner.post(`/api/dashboard/organizations/${organizationId()}/guest-threads/${threadId}/operations/reply`, {
      data: { body: `Foreign reply ${nonce}`, idempotencyKey: `foreign-reply-${nonce}` },
    })
    expect([403, 404]).toContain(foreignMutation.status())

    const replyBody = `Idempotent owner reply ${nonce}`
    const idempotencyKey = `guest-thread-reply-${nonce}`
    const replyUrl = `/api/dashboard/organizations/${organizationId()}/guest-threads/${threadId}/operations/reply`
    const sendReply = () => owner.post(replyUrl, {
      headers: { 'idempotency-key': idempotencyKey },
      data: { body: replyBody },
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
    expect(replyEntries).toMatchObject([{ side: 'business', author: 'You' }])
    expect((await loadLedger(owner, threadId)).entries.filter(entry => entry.body === replyBody)).toMatchObject([{
      id: replyEntries[0]!.id,
      kind: 'message',
      channel: 'email',
      event: 'thread.member_reply',
    }])

    const deliveryResponse = await owner.get('/api/dev/notifications', {
      headers: devLoginHeaders(),
      params: { organization_id: organizationId(), since: startedAt },
    })
    await expectStatus(deliveryResponse, 200)
    const deliveries = (await deliveryResponse.json() as DeliveryList).deliveries.filter(row =>
      row.request_id === threadId && row.purpose === 'member_reply',
    )
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.entry_id).toBe(replyEntries[0]!.id)

    const [ownerListAfterReply, ownerNotificationsAfterReply] = await Promise.all([
      loadThreadList(owner, guestName),
      loadNotifications(owner),
    ])
    expect(ownerListAfterReply.threads[0]).toMatchObject({
      id: threadId,
      preview: replyBody,
      previewFrom: 'You',
      unread: false,
    })
    expect((await loadLedger(owner, threadId)).state).toBe('waiting_on_guest')
    expect(contactNotification(ownerNotificationsAfterReply, guestName).read_at).toEqual(expect.any(String))
  } finally {
    await Promise.all([owner.dispose(), secondOwner.dispose(), foreignOwner.dispose()])
  }
})

type Mailbox = 'current' | 'past'

// Both list loaders, so the mailbox vocabulary cannot survive in only one.
async function loadMailbox(request: APIRequestContext, mailbox: Mailbox) {
  const [byId, byOrg] = await Promise.all([
    request.get(`/api/dashboard/organizations/${organizationId()}/guest-threads`, { params: { mailbox } }),
    request.get('/api/dashboard/guest-threads', { params: { org: organizationSlug(), mailbox } }),
  ])
  await expectStatus(byId, 200)
  await expectStatus(byOrg, 200)
  return {
    byId: (await byId.json() as { threads: InboxRow[] }).threads,
    byOrg: (await byOrg.json() as { threads: InboxRow[] }).threads,
  }
}

/**
 * A Past conversation nobody archived: its booking ended, so it offers neither
 * Archive nor Move to Messages. The experience seed has one; a run's own
 * archived contacts are Past too, and they offer Move to Messages.
 */
async function endedConversation(request: APIRequestContext) {
  for (const thread of (await loadMailbox(request, 'past')).byId) {
    const actions = await loadThreadActions(request, thread.id)
    if (!actions.archive && !actions.unarchive) return thread
  }
  throw new Error('The experience seed includes a booking that has ended, and no Past conversation is one')
}

async function submitContact(request: APIRequestContext, guestName: string) {
  const response = await request.post('/api/public/contact', {
    headers: seededSiteHeaders('experience'),
    data: { name: guestName, email: `${guestName.replace(/\W+/g, '-').toLowerCase()}@playwright.example`, subject: 'partnerships', message: `Mailbox proof for ${guestName}` },
  })
  await expectStatus(response, 201)
}

test('archive and Move to messages file a conversation without reordering the inbox', async ({ playwright }) => {
  test.skip(!writable, 'Guest-thread writes require disposable local or preview data')

  const owner = await playwright.request.newContext({ baseURL })
  const foreignOwner = await playwright.request.newContext({ baseURL })
  try {
    await Promise.all([loginAs(owner, baseURL, ownerId), loginAs(foreignOwner, baseURL, foreignOwnerId)])

    // The retired vocabulary is refused by both loaders rather than ignored.
    await expectStatus(await owner.get(`/api/dashboard/organizations/${organizationId()}/guest-threads`, { params: { occurrence: 'upcoming' } }), 400)
    await expectStatus(await owner.get('/api/dashboard/guest-threads', { params: { org: organizationSlug(), occurrence: 'past' } }), 400)

    const nonce = Date.now()
    const filedName = `Mailbox filed ${nonce}`
    const newerName = `Mailbox newer ${nonce}`
    await submitContact(owner, filedName)
    await submitContact(owner, newerName)

    const current = await loadMailbox(owner, 'current')
    const filed = current.byId.find(thread => thread.guestName === filedName)
    const newer = current.byId.find(thread => thread.guestName === newerName)
    expect(filed).toBeDefined()
    expect(current.byOrg.some(thread => thread.id === filed!.id)).toBe(true)
    const threadId = filed!.id
    expect(await loadThreadActions(owner, threadId)).toMatchObject({ archive: true, unarchive: false })
    const before = await loadLedger(owner, threadId)
    expect(before.archived).toBe(false)

    const operationUrl = (action: 'archive' | 'unarchive') =>
      `/api/dashboard/organizations/${organizationId()}/guest-threads/${threadId}/operations/${action}`

    // Another business's owner cannot reach it, and a key is required.
    expect([403, 404]).toContain((await foreignOwner.post(operationUrl('archive'), { data: { idempotencyKey: `foreign-${nonce}` } })).status())
    await expectStatus(await owner.post(operationUrl('archive'), { data: {} }), 400)
    expect((await loadLedger(owner, threadId)).archived).toBe(false)
    expect((await loadMailbox(owner, 'current')).byId.some(thread => thread.id === threadId)).toBe(true)

    // One key, sent twice at once and once more after: one archive, said once in the conversation.
    const archive = () => owner.post(operationUrl('archive'), { data: { idempotencyKey: `archive-${nonce}` } })
    for (const response of await Promise.all([archive(), archive()])) await expectStatus(response, 200)
    const archived = await loadThreadDetail(owner, threadId)
    const archivedEvents = streamEvents(archived, 'You archived this conversation')
    expect(archivedEvents).toHaveLength(1)
    // Filing it away is not conversation activity: its state and last change are the ones it had.
    expect(await loadLedger(owner, threadId)).toMatchObject({ archived: true, state: before.state, updated_at: before.updated_at })
    expect(await loadThreadActions(owner, threadId)).toMatchObject({ archive: false, unarchive: true })
    await expectStatus(await archive(), 200)
    const retried = await loadThreadDetail(owner, threadId)
    expect(streamEvents(retried, 'You archived this conversation')).toEqual(archivedEvents)
    expect((await loadLedger(owner, threadId)).entries.filter(entry => entry.event === 'thread.archived')).toMatchObject([{ id: archivedEvents[0]!.id, kind: 'operation' }])

    const afterArchiveCurrent = await loadMailbox(owner, 'current')
    const afterArchivePast = await loadMailbox(owner, 'past')
    expect(afterArchiveCurrent.byId.some(thread => thread.id === threadId)).toBe(false)
    expect(afterArchiveCurrent.byOrg.some(thread => thread.id === threadId)).toBe(false)
    expect(afterArchivePast.byId.some(thread => thread.id === threadId)).toBe(true)
    expect(afterArchivePast.byOrg.some(thread => thread.id === threadId)).toBe(true)

    const unarchive = () => owner.post(operationUrl('unarchive'), { data: { idempotencyKey: `unarchive-${nonce}` } })
    for (const response of await Promise.all([unarchive(), unarchive()])) await expectStatus(response, 200)
    await expectStatus(await unarchive(), 200)
    const restored = await loadThreadDetail(owner, threadId)
    expect(streamEvents(restored, 'You moved this conversation back to Messages')).toHaveLength(1)
    expect(streamEvents(restored, 'You archived this conversation')).toEqual(archivedEvents)
    expect(await loadLedger(owner, threadId)).toMatchObject({ archived: false, updated_at: before.updated_at })
    expect(await loadThreadActions(owner, threadId)).toMatchObject({ archive: true, unarchive: false })

    // Filing it away and back is not conversation activity: the newer thread
    // is still ahead of it.
    const order = (await loadMailbox(owner, 'current')).byId.map(thread => thread.id)
    expect(order.indexOf(newer!.id)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(newer!.id)).toBeLessThan(order.indexOf(threadId))

    // A conversation Past because its booking ended cannot be moved back.
    const ended = await endedConversation(owner)
    const refused = await owner.post(`/api/dashboard/organizations/${organizationId()}/guest-threads/${ended.id}/operations/unarchive`, {
      data: { idempotencyKey: `unarchive-ended-${nonce}` },
    })
    await expectStatus(refused, 409)
    expect(await refused.json()).toMatchObject({ error: 'This conversation is past because its booking has ended' })
    expect((await loadMailbox(owner, 'past')).byId.some(thread => thread.id === ended.id)).toBe(true)
    expect((await loadLedger(owner, ended.id)).archived).toBe(false)
    expect(await loadThreadActions(owner, ended.id)).toMatchObject({ archive: false, unarchive: false })
  } finally {
    await Promise.all([owner.dispose(), foreignOwner.dispose()])
  }
})

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
]) {
  test(`In this conversation archives a conversation and moves it back (${viewport.name})`, async ({ page }) => {
    test.skip(!writable, 'Guest-thread writes require disposable local or preview data')
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await loginAs(page.request, baseURL, ownerId)
    const guestName = `Mailbox row ${viewport.name} ${Date.now()}`
    await submitContact(page.request, guestName)
    await dismissPreviewToolbar(page)

    // The rows are server-rendered, so they are visible before they have a
    // handler: the list says when it has hydrated, and nothing is pressed
    // before. On desktop the index then opens its newest thread beside the
    // list, and that navigation re-renders the rows, so the screen has settled
    // only once a thread is open.
    const openMessages = async (query = '') => {
      await page.goto(`${baseURL}/dashboard/${organizationSlug()}/messages${query}`)
      await expect(page.locator('[data-guest-thread-list-hydrated="true"]')).toBeVisible()
      if (viewport.name === 'desktop') await expect(page).toHaveURL(/\/messages\/[^/?]+(\?|$)/)
    }
    const rowFor = (name: string) => page.locator('[data-thread-row]').filter({ hasText: name })
    // The conversation's actions are in its header's "In this conversation" sheet, not on the row.
    const thread = page.locator('#dashboard-panel-organization-messages-thread')
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
    await expect(rowFor(guestName)).toBeVisible()
    await expect(rowFor(guestName).getByRole('button')).toHaveCount(0)
    const threadId = await rowFor(guestName).getAttribute('data-thread-row')
    await openConversation(threadId!)
    await sheetButton.click()
    await expect(sheet.getByRole('button', { name: 'Archive', exact: true })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Move to Messages', exact: true })).toHaveCount(0)
    const archived = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/guest-threads/${threadId}/operations/archive`))
    await sheet.getByRole('button', { name: 'Archive', exact: true }).click()
    expect((await archived).status()).toBe(200)
    await expect(sheet).toHaveCount(0)
    await expect(rowFor(guestName)).toHaveCount(0)
    // The archived conversation is not left open beside the list.
    await expect(page).not.toHaveURL(new RegExp(`/messages/${threadId}`))

    await openMessages('?archived=')
    await expect(rowFor(guestName)).toBeVisible()

    // A conversation Past because its booking ended offers no way back; its
    // guest can still be reported or blocked.
    const ended = await endedConversation(page.request)
    await expect(page.locator(`[data-thread-row="${ended.id}"]`)).toBeVisible()
    await openConversation(ended.id, '?archived=')
    await sheetButton.click()
    await expect(sheet.getByRole('button', { name: 'Report', exact: true })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Block', exact: true })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0)
    await expect(sheet.getByRole('button', { name: 'Move to Messages', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)

    // Moving it back keeps the conversation open where it is read, and it
    // leaves Past for Current.
    if (viewport.name === 'mobile') await openMessages('?archived=')
    await openConversation(threadId!, '?archived=')
    await sheetButton.click()
    await expect(sheet.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0)
    const moved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/guest-threads/${threadId}/operations/unarchive`))
    await sheet.getByRole('button', { name: 'Move to Messages', exact: true }).click()
    expect((await moved).status()).toBe(200)
    await expect(sheet).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/messages/${threadId}\\?archived=$`))
    await expect(thread.getByText('You moved this conversation back to Messages', { exact: true })).toBeVisible()
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

test('Today uses the CMS patterns and sends one reservation change request', async ({ page }, testInfo) => {
  test.skip(!writable, 'Today writes require disposable local or preview data')
  releaseDemoLock = await acquireTenantMutationLock(testInfo, demoOrganizationId())
  await loginAs(page.request, baseURL)

  const reservationConfig = `/api/editor/organizations/${demoOrganizationId()}/locations/${demoLocationId()}/reservation-config`
  const priorPolicy = await page.request.get(reservationConfig)
  await expectStatus(priorPolicy,200)
  const policy = (await priorPolicy.json()).config
  priorReservationDuration = { value: policy.duration_minutes }
  await expectStatus(await page.request.put(reservationConfig,{data:{duration_minutes:60,expected_updated_at:policy.updated_at}}),200)

  const now = Date.now()
  const firstName = 'Maya'
  const guestName = `${firstName} Chen`
  const guestEmail = `maya-${now}@example.test`
  const availability = await page.request.get('/api/public/reservations/availability', {
    params: { date: new Date(now).toISOString().slice(0, 10), location_id: demoLocationId() },
    headers: seededSiteHeaders('restaurant'),
  })
  await expectStatus(availability, 200)
  const { timezone } = await availability.json() as { timezone: string }
  expect(timezone).toEqual(expect.any(String))
  // The Today tab shows only bookings whose day key equals the *location's* current
  // local day (listTodayAgenda), and listReservationSlots drops every slot already in
  // the past. the Brooklyn location's ordinary hours end at 22:00 America/New_York, so once a
  // run starts after that, the location's today has no bookable
  // slot left and a guest who "arrives today" cannot be created at all. Dated hours for
  // the rest of today are what special hours exist for, so the test opens one instead of
  // depending on the hour CI happens to start.
  // One reading of the location's clock feeds both the calendar lookup and the chosen
  // minute; reading it twice could straddle local midnight and write the hours to a
  // different day than the one checked for collisions.
  const localToday = localNow(timezone)
  const todaySlot = openableMinuteToday(localToday, await loadLocationDay(page.request, localToday.date), timezone)
  test.skip(
    !todaySlot,
    `${timezone} is within ${TODAY_SLOT_LEAD_MINUTES} minutes of midnight, so no reservation can still arrive today`,
  )
  priorSpecialHours = { value: await readSpecialHours(page.request) }
  await expectStatus(await setLocationSlot(page.request, todaySlot!), 200)

  const bookingIds: string[] = []
  for (const [name, email, plan] of [
    [guestName, guestEmail, todaySlot!],
    ['Priya Patel', `priya-${now}@example.test`, now + 86_400_000],
  ] as const) {
    let date: string
    let time: string
    if (typeof plan === 'number') {
      // The upcoming guest only has to land on some later day the location is open,
      // so it takes the location's own availability and walks forward to find one.
      let slot: { time_slot: string } | undefined
      date = localDateAt(new Date(plan), timezone)
      for (let dayOffset = 0; dayOffset < 4 && !slot; dayOffset += 1) {
        date = localDateAt(new Date(plan + dayOffset * 86_400_000), timezone)
        const day = await page.request.get('/api/public/reservations/availability', { params: { date, location_id: demoLocationId() }, headers: seededSiteHeaders('restaurant') })
        await expectStatus(day, 200)
        // is_closed answers whether the location serves the time, not whether anyone is
        // left to seat: a slot at capacity comes back is_full with is_closed false, and
        // booking it fails the POST with a 409 the loop could have avoided by trying the
        // next slot or the next day.
        const { dates } = await day.json() as { dates: Array<{ slots: Array<{ time_slot: string; is_closed: boolean; is_full: boolean }> }> }
        slot = dates[0]?.slots.filter(candidate => !candidate.is_closed && !candidate.is_full).at(-1)
      }
      expect(slot, `The Brooklyn location offers no open slot within four days of ${localDateAt(new Date(plan), timezone)}`).toBeTruthy()
      time = slot!.time_slot
    } else {
      ({ date, time } = plan)
    }
    const response = await page.request.post('/api/public/reservations', {
      headers: seededSiteHeaders('restaurant'),
      data: { name, email, phone: '+12025550123', date, time, guests: '2', location_id: demoLocationId(), idempotency_key: crypto.randomUUID() },
    })
    await expectStatus(response, 201)
    const { id } = await response.json() as { id: string }
    expect(id).toEqual(expect.any(String))
    bookingIds.push(id)
  }
  const upcomingBookingId = bookingIds[1]!

  await dismissPreviewToolbar(page)

  await page.goto(`${baseURL}/dashboard/${demoSlug()}`)
  // A new confirmed reservation is a commitment, not a task: it is on today's
  // schedule, and its whole-card link opens the exact booking's actions.
  const todayResponse = await page.request.get('/api/dashboard/today', { params: { org: demoSlug() } })
  await expectStatus(todayResponse, 200)
  const todayFeed = await todayResponse.json() as TodayFeedPayload
  expect(todayFeed.cards.some(card => card.id === `attention:${bookingIds[0]}`)).toBe(false)
  const reviewCard = todayFeed.cards.find(card => card.id === `reservation:${bookingIds[0]}`)
  expect(reviewCard?.priority).toBe('schedule')
  expect(reviewCard?.to).toBe(`/dashboard/${demoSlug()}/bookings/reservation/${bookingIds[0]}`)
  const due = todayFeed.cards.filter(card => card.priority === 'attention').length
  await expect(page.getByRole('heading', { name: due ? `You have ${due} ${due === 1 ? 'thing' : 'things'} to do` : 'Your day at a glance', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Filter activity', exact: true })).toBeVisible()

  const upcomingResponse = await page.request.get('/api/dashboard/today', { params: {
    org: demoSlug(), range: 'upcoming', from: localToday.date,
    to: localDateAt(new Date(now + 5 * 86_400_000), timezone),
  } })
  await expectStatus(upcomingResponse, 200)
  const upcomingFeed = await upcomingResponse.json() as TodayFeedPayload
  const upcomingCard = upcomingFeed.cards.find(card => card.id === `reservation:${upcomingBookingId}`)
  expect(upcomingCard?.to).toBe(`/dashboard/${demoSlug()}/bookings/reservation/${upcomingBookingId}`)
  expect(localDateAt(new Date(upcomingCard!.occurrenceAt!), timezone) > localToday.date).toBe(true)
  expect(upcomingFeed.cards.some(card => card.id === `reservation:${bookingIds[0]}`)).toBe(false)

  await page.locator(`[data-card-id="${reviewCard!.id}"]`).click()
  await expect(page.getByRole('heading', { name: 'Currently hosting', exact: true })).toBeVisible()
  await expect(page.getByText(guestName, { exact: true }).first()).toBeVisible()
  await expect(page.getByText(guestEmail, { exact: true })).toHaveCount(0)
  const detailPanel = page.locator('#dashboard-panel-booking-details')
  const body = detailPanel.locator(':scope > [data-slot="body"]')
  const summaryResponse = await page.request.get(`/api/dashboard/bookings/reservation/${bookingIds[0]}`, { params: { org: demoSlug() } })
  await expectStatus(summaryResponse, 200)
  const summary = (await summaryResponse.json() as { booking: DashboardBookingDetails }).booking
  expect(summary).toMatchObject({ guestName, guestPhone: '+12025550123', partySize: 2 })
  expect(summary.threadId).not.toBeNull()
  const priorViewport = page.viewportSize()!
  let desktopCountWidth: number | undefined
  for (const width of [1728, 390]) {
    await page.setViewportSize({ width, height: 940 })
    const identity = detailPanel.getByRole('heading', { level: 2, name: `${firstName}’s group of ${summary.partySize}`, exact: true })
    const message = detailPanel.getByRole('link', { name: 'Message guest', exact: true })
    const call = detailPanel.getByRole('link', { name: 'Call', exact: true })
    await expect(message).toHaveAttribute('href', `/dashboard/${demoSlug()}/messages/${encodeURIComponent(summary.threadId!)}`)
    await expect(call).toHaveAttribute('href', `tel:${summary.guestPhone}`)
    await expect(identity).toBeInViewport()
    await expect(message).toBeInViewport()
    await expect(call).toBeInViewport()
    const otherGuests = detailPanel.getByLabel(`${summary.partySize! - 1} other ${summary.partySize === 2 ? 'guest' : 'guests'}`, { exact: true })
    const guestGroup = otherGuests.locator('..')
    const mainAvatar = guestGroup.locator(':scope > [data-slot="root"]')
    await expect(guestGroup).toBeInViewport()
    await expect(mainAvatar).toHaveCount(1)
    if (summary.guestImageUrl) await expect(guestGroup.getByAltText(summary.guestName!, { exact: true })).toHaveAttribute('src', summary.guestImageUrl)
    else await expect(mainAvatar).toHaveText(summary.guestName!.trim().slice(0, 1))
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
    expect(guestBounds.y - bodyBounds.y, 'The guest cluster leads 64px below the record header').toBe(64)
    expect(identityBounds.y - guestBounds.y - guestBounds.height, 'The party title follows the guest cluster at the measured Airbnb spacing').toBe(width === 1728 ? 32 : 24)
    expect(Math.abs(guestBounds.x + guestBounds.width / 2 - paneCenter)).toBeLessThanOrEqual(1)
    expect(Math.abs(identityBounds.x + identityBounds.width / 2 - paneCenter), 'The record header centers in its visible pane').toBeLessThanOrEqual(1)
    expect(await identity.evaluate(element => getComputedStyle(element).textAlign)).toBe('center')
    const paymentInfo = detailPanel.getByRole('heading', { name: 'Payment info', exact: true })
    await expect(paymentInfo).toHaveCount(summary.payments?.length ?? 0)
    const sections = [
      detailPanel.getByText('Date', { exact: true }),
      detailPanel.getByText('Your notes', { exact: true }),
      detailPanel.getByRole('link', { name: `Guests ${summary.guestName} · ${summary.partySize} guests`, exact: true }),
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
  await detailPanel.getByRole('link', { name: `Guests ${summary.guestName} · ${summary.partySize} guests`, exact: true }).click()
  await expect(page.getByText(guestEmail, { exact: true })).toBeVisible()
  await page.goBack()

  const note = `Today page note ${Date.now()}`
  const noteContext = `?range=upcoming&locationId=${demoLocationId()}&kinds=reservation`
  const recordPath = `/dashboard/${demoSlug()}/bookings/reservation/${bookingIds[0]}`
  const noteEndpoint = `/api/dashboard/bookings/reservation/${bookingIds[0]}/notes`
  await page.goto(`${baseURL}${recordPath}${noteContext}`)
  const noteInput = detailPanel.getByRole('textbox', { name: 'Add a note to yourself', exact: true })
  await noteInput.fill(note)
  const noteWrite = page.waitForResponse(response => new URL(response.url()).pathname === noteEndpoint && response.request().method() === 'POST')
  await detailPanel.getByText('Your notes', { exact: true }).click()
  const noteResponse = await noteWrite
  await expectStatus(noteResponse, 200)
  expect(noteResponse.request().postDataJSON()).toMatchObject({ note, idempotencyKey: expect.any(String) })
  expect(noteResponse.request().postDataJSON()).not.toHaveProperty('noteId')
  await expect(noteInput).toHaveValue('')
  // The member's conversation says the note in its own words, once; the ledger keeps it private.
  const notedThread = await loadThreadDetail(page.request, summary.threadId!, demoOrganizationId())
  const addedNotes = streamEvents(notedThread, note)
  expect(addedNotes).toHaveLength(1)
  expect((await loadLedger(page.request, summary.threadId!, demoOrganizationId())).entries.filter(entry => entry.id === addedNotes[0]!.id))
    .toMatchObject([{ kind: 'operation', channel: 'system', event: 'internal_note.added', body: note, payload: { private: true } }])
  const notePath = `${recordPath}/notes/${addedNotes[0]!.id}${noteContext}`
  const editNote = detailPanel.getByRole('link', { name: `Edit note: ${note}`, exact: true })
  await expect(editNote).toHaveAttribute('href', notePath)
  const secondNote = `${note} added while opening the saved note`
  await noteInput.fill(secondNote)
  const secondWrite = page.waitForResponse(response => new URL(response.url()).pathname === noteEndpoint
    && response.request().method() === 'POST' && response.request().postDataJSON().note === secondNote)
  // Clicking the saved note causes blur and navigation together, without an
  // artificial pause between the real writer and the route transition.
  await editNote.click()
  const secondResponse = await secondWrite
  await expectStatus(secondResponse, 200)
  expect(secondResponse.request().postDataJSON()).toMatchObject({ note: secondNote, idempotencyKey: expect.any(String) })
  const secondThread = await loadThreadDetail(page.request, summary.threadId!, demoOrganizationId())
  const secondNotes = streamEvents(secondThread, secondNote)
  expect(secondNotes).toHaveLength(1)
  expect((await loadLedger(page.request, summary.threadId!, demoOrganizationId())).entries.filter(entry => entry.id === secondNotes[0]!.id))
    .toMatchObject([{ kind: 'operation', channel: 'system', event: 'internal_note.added', body: secondNote, payload: { private: true } }])
  await expect(page).toHaveURL(`${baseURL}${notePath}`)
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue(note)
  await expect(noteInput).toHaveCount(0)
  // Beside its index a leaf carries only Save — Airbnb's shape at two columns,
  // measured 2026-09-21 — so leaving one here is the index's own Back. Cancel
  // belongs to the sheet the leaf becomes below `lg`. The rule is the leaf's, so
  // it is asserted inside the leaf. The record is its direct parent.
  await expect(page.locator('#dashboard-panel-booking-note').getByRole('button', { name: 'Cancel', exact: true })).toBeHidden()
  await expect(page.locator('#dashboard-panel-booking-note').getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  const revisedNote = `${note} revised`
  await page.getByLabel('Note', { exact: true }).fill(revisedNote)
  const noteRevisionWrite = page.waitForResponse(response => new URL(response.url()).pathname === noteEndpoint && response.request().method() === 'POST')
  await page.locator('#dashboard-panel-booking-note').getByRole('button', { name: 'Save', exact: true }).click()
  const noteRevisionResponse = await noteRevisionWrite
  await expectStatus(noteRevisionResponse, 200)
  expect(noteRevisionResponse.request().postDataJSON()).toEqual({ note: revisedNote, idempotencyKey: expect.any(String), noteId: addedNotes[0]!.id, revisionId: addedNotes[0]!.id })
  await expect(page).toHaveURL(`${baseURL}${recordPath}${noteContext}`)
  await expect(noteInput).toHaveValue('')
  const revisedThread = await loadThreadDetail(page.request, summary.threadId!, demoOrganizationId())
  const revisedNotes = streamEvents(revisedThread, revisedNote)
  expect(revisedNotes).toHaveLength(1)
  expect((await loadLedger(page.request, summary.threadId!, demoOrganizationId())).entries.filter(entry => entry.id === revisedNotes[0]!.id))
    .toMatchObject([{ kind: 'operation', channel: 'system', event: 'internal_note.updated', body: revisedNote,
      payload: { private: true, noteId: addedNotes[0]!.id, revisionId: addedNotes[0]!.id } }])
  await expect(detailPanel.getByRole('link', { name: `Edit note: ${revisedNote}`, exact: true })).toHaveAttribute('href', notePath)

  // Change is a mode of the booking leaf, not a dialog over it: the action is a
  // link, every field is a row of the same staged draft, and one footer commit
  // sends the request the guest confirms.
  await detailPanel.getByRole('button', { name: 'Manage reservation', exact: true }).click()
  const manage = page.getByRole('dialog', { name: 'Manage reservation', exact: true })
  await manage.getByRole('link', { name: 'Change reservation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'What do you want to change?', exact: true })).toBeVisible()
  await expect(page.getByText(`${firstName} confirms the change before anything moves.`)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Change date', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeVisible()

  const changeContext = `?range=upcoming&locationId=${demoLocationId()}&kinds=reservation`
  await page.goto(`${baseURL}/dashboard/${demoSlug()}/bookings/reservation/${upcomingBookingId}/change${changeContext}`)
  const beforeResponse = await page.request.get(
    `/api/dashboard/bookings/reservation/${upcomingBookingId}`,
    { params: { org: demoSlug() } },
  )
  await expectStatus(beforeResponse, 200)
  const before = await beforeResponse.json() as { booking: { partySize: number; threadId: string } }
  const targetPartySize = before.booking.partySize === 99 ? 98 : before.booking.partySize + 1
  await page.getByRole('link', { name: 'Change guests', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}/dashboard/${demoSlug()}/bookings/reservation/${upcomingBookingId}/change/guests${changeContext}`)
  await page.getByRole('spinbutton', { name: 'Guests', exact: true }).fill(String(targetPartySize))
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  const requestedAt = new Date().toISOString()
  const requestCompleted = page.waitForResponse(response =>
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith(`/api/dashboard/bookings/reservation/${upcomingBookingId}/changes`),
  )
  await page.getByRole('button', { name: 'Send request', exact: true }).click()
  const changeResponse = await requestCompleted
  expect(changeResponse.status(), await changeResponse.text()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Coming up', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(`${baseURL}/dashboard/${demoSlug()}/bookings/reservation/${upcomingBookingId}${changeContext}`)

  const detail = await loadThreadDetail(page.request, before.booking.threadId, demoOrganizationId())
  const requests = streamChanges(detail).filter(item => item.sentAt >= requestedAt)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.change).toMatchObject({ requestedBy: 'business', status: 'pending', after: { partySize: targetPartySize } })
  const deliveryResponse = await page.request.get('/api/dev/notifications', {
    headers: devLoginHeaders(),
    params: { organization_id: demoOrganizationId(), since: requestedAt },
  })
  await expectStatus(deliveryResponse, 200)
  const deliveries = (await deliveryResponse.json() as DeliveryList).deliveries.filter(row => row.entry_id === requests[0]!.id)
  expect(deliveries.some(row => row.purpose === 'status_update' && row.status === 'sent')).toBe(true)
  expect(deliveries.some(row => row.purpose === 'owner_alert' && row.status === 'sent')).toBe(true)

  if (local) {
    const request = requests[0]!
    const token = createHmac('sha256', 'local-playwright-email-reply-secret')
      .update(`booking-change:v1:${before.booking.threadId}:${request.id}`)
      .digest('hex')
    await page.goto(`${baseURL}/booking-changes/${before.booking.threadId}/${request.id}#${token}`)
    await expect(page.getByRole('button', { name: 'Accept changes', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Accept changes', exact: true }).click()
    await expect(page.getByText('Your booking has been updated.', { exact: true })).toBeVisible()

    const afterResponse = await page.request.get(
      `/api/dashboard/bookings/reservation/${upcomingBookingId}`,
      { params: { org: demoSlug() } },
    )
    await expectStatus(afterResponse, 200)
    expect(await afterResponse.json()).toMatchObject({ booking: { partySize: targetPartySize } })
    // The proposal reads accepted, and the conversation says so once.
    const afterDetail = await loadThreadDetail(page.request, before.booking.threadId, demoOrganizationId())
    expect(streamChanges(afterDetail).find(item => item.id === request.id)?.change.status).toBe('accepted')
    expect(streamEvents(afterDetail, `${afterDetail.guestName}’s change was accepted`)).toHaveLength(1)
  }
})

test('buyer conversation approves and declines canonical changes without moving a pending reservation', async ({ page, playwright }, testInfo) => {
  test.skip(!local, 'Buyer decisions and log-only delivery use disposable local data')
  releaseDemoLock = await acquireTenantMutationLock(testInfo, demoOrganizationId())
  const owner = await playwright.request.newContext({ baseURL })
  let threadId: string | null = null
  try {
    await loginAs(owner, baseURL, 'user-e2e-demo-owner')
    await loginAs(page.request, baseURL, 'user-e2e-buyer')
    let slot: { date: string; time: string } | null = null
    for (let offset = 1; offset <= 7 && !slot; offset++) {
      const date = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
      const available = await page.request.get('/api/public/reservations/availability', {
        params: { date, location_id: demoLocationId() }, headers: seededSiteHeaders('restaurant'),
      })
      await expectStatus(available, 200)
      const { dates } = await available.json() as { dates: Array<{ slots: Array<{ time_slot: string; is_closed: boolean; is_full: boolean }> }> }
      const time = dates[0]?.slots.find(candidate => !candidate.is_closed && !candidate.is_full)?.time_slot
      if (time) slot = { date, time }
    }
    expect(slot, 'The existing restaurant fixture has a future reservable time').not.toBeNull()
    // The guest's own Messages count: their conversations with a business reply they have not read.
    const guestUnread = async () => {
      const response = await page.request.get('/api/dashboard/notifications/unread-count', { params: { scope: 'personal' } })
      await expectStatus(response, 200)
      return (await response.json() as { unread_conversations: number }).unread_conversations
    }
    const unreadBefore = await guestUnread()
    const created = await page.request.post('/api/public/reservations', {
      headers: seededSiteHeaders('restaurant'),
      data: { name: 'E2E Buyer', email: 'buyer@playwright.example', phone: '+12025550123', ...slot!, guests: '1', location_id: demoLocationId(), idempotency_key: crypto.randomUUID() },
    })
    await expectStatus(created, 201)
    threadId = (await created.json() as { request_id: string }).request_id
    const read = async () => {
      const response = await owner.get(`/api/dashboard/bookings/reservation/${threadId}`, { params: { org: demoSlug() } })
      await expectStatus(response, 200)
      return (await response.json() as { booking: { updatedAt: string; bookingDate: string; bookingTime: string; partySize: number; locationId: string } }).booking
    }
    const original = await read()
    const requestChange = async (partySize: number) => {
      const current = await read()
      const response = await owner.post(`/api/dashboard/bookings/reservation/${threadId}/changes`, {
        params: { org: demoSlug() },
        data: { kind: 'reservation', locationId: current.locationId, bookingDate: current.bookingDate, bookingTime: current.bookingTime.slice(0, 5), partySize, expectedUpdatedAt: current.updatedAt, idempotencyKey: crypto.randomUUID() },
      })
      await expectStatus(response, 200)
      const detail = await loadThreadDetail(owner, threadId!, demoOrganizationId())
      const proposal = streamChanges(detail).at(-1)
      expect(proposal?.change.status).toBe('pending')
      return proposal!
    }
    const first = await requestChange(2)
    expect(await read()).toMatchObject({ partySize: 1, bookingDate: original.bookingDate, bookingTime: original.bookingTime })
    expect(await guestUnread(), 'The business’s change request is unread in the guest’s Messages').toBe(unreadBefore + 1)
    await dismissPreviewToolbar(page)
    const guestRead = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/account/messages/${threadId}/read`)
    await page.goto(`${baseURL}/dashboard/account/messages/${threadId}`)
    await expectStatus(await guestRead, 200)
    expect(await guestUnread(), 'Opening the conversation reads it').toBe(unreadBefore)
    const card = page.getByTestId('booking-change-request')
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('heading', { name: 'Review changes', exact: true })).toBeVisible()
    await expect(card).toContainText('Before')
    await expect(card).toContainText('Proposed')
    await expect(card).toContainText('Your booking stays unchanged until you accept.')
    await expect(card.getByRole('button', { name: 'Accept changes', exact: true })).toBeVisible()
    const declined = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/account/bookings/change')
    await card.getByRole('button', { name: 'Decline changes', exact: true }).click()
    await expectStatus(await declined, 200)
    await expect(card).toContainText('Changes declined')
    await expect(card).toContainText('Your original booking is unchanged.')
    await expect(card.getByRole('button', { name: 'Accept changes', exact: true })).toHaveCount(0)
    expect(await read()).toMatchObject({ partySize: 1, bookingDate: original.bookingDate, bookingTime: original.bookingTime })
    const afterDecline = await loadThreadDetail(owner, threadId, demoOrganizationId())
    expect(streamChanges(afterDecline).find(item => item.id === first.id)?.change.status).toBe('declined')
    expect(streamEvents(afterDecline, 'E2E Buyer’s change was declined')).toHaveLength(1)

    const second = await requestChange(2)
    await page.reload()
    const pending = card.filter({ hasText: 'Your booking stays unchanged until you accept.' })
    await expect(pending).toHaveCount(1)
    const accepted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/account/bookings/change')
    await pending.getByRole('button', { name: 'Accept changes', exact: true }).click()
    await expectStatus(await accepted, 200)
    await expect(card.filter({ hasText: 'Changes accepted' })).toContainText('Your booking has been updated.')
    expect(await read()).toMatchObject({ partySize: 2, bookingDate: original.bookingDate, bookingTime: original.bookingTime })
    const final = await loadThreadDetail(owner, threadId, demoOrganizationId())
    expect(streamChanges(final).find(item => item.id === second.id)?.change.status).toBe('accepted')
    expect(streamEvents(final, 'E2E Buyer’s change was accepted')).toHaveLength(1)
    const finalRecord = (await loadLedger(owner, threadId, demoOrganizationId())).operational_record
    const replay = await page.request.post('/api/account/bookings/change', {
      headers: authRequestHeaders(baseURL), data: { thread_id: threadId, request_id: second.id, decision: 'accept' },
    })
    await expectStatus(replay, 200)
    // The replayed answer is the same answer: still one acceptance in the conversation.
    const replayed = await loadThreadDetail(owner, threadId, demoOrganizationId())
    expect(streamChanges(replayed).find(item => item.id === second.id)?.change.status).toBe('accepted')
    expect(streamEvents(replayed, 'E2E Buyer’s change was accepted')).toHaveLength(1)
    await page.goto(`${baseURL}/dashboard/account/activity/reservation/${threadId}`)
    await page.getByRole('button', { name: 'Manage reservation', exact: true }).click()
    await page.getByRole('link', { name: 'Send a change request', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}/dashboard/account/messages/${threadId}?intent=booking-change`)
    const changeMessage = 'Could we move this reservation later? Please send an available time.'
    await expect(page.getByText('Describe the dates, time or guest details you would like to change. The business will review your request before anything changes.', { exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Write a message…', exact: true }).fill(changeMessage)
    const sentAt = new Date().toISOString()
    const sentRequest = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/account/messages/${threadId}/reply`)
    await page.getByRole('button', { name: 'Send a change request', exact: true }).click()
    await expectStatus(await sentRequest, 200)
    await expect(page.getByText('Your change request was sent to the business. Your booking is unchanged while it is reviewed.', { exact: true })).toBeVisible()
    // A guest's request is a message for the business to answer; the reservation itself has not moved.
    const requested = await loadThreadDetail(owner, threadId, demoOrganizationId())
    const requestedLedger = await loadLedger(owner, threadId, demoOrganizationId())
    expect(requestedLedger.state).toBe('needs_attention')
    expect(requestedLedger.operational_record).toEqual(finalRecord)
    const customerRequest = streamMessages(requested).filter(item => item.side === 'guest' && item.body === changeMessage)
    expect(customerRequest).toMatchObject([{ author: 'E2E Buyer' }])
    const requestDelivery = await owner.get('/api/dev/notifications', { headers: devLoginHeaders(), params: { organization_id: demoOrganizationId(), since: sentAt } })
    await expectStatus(requestDelivery, 200)
    expect((await requestDelivery.json() as DeliveryList).deliveries.some(delivery => delivery.entry_id === customerRequest[0]!.id && delivery.purpose === 'owner_alert' && delivery.status === 'sent')).toBe(true)
  } finally {
    if (threadId) await expectStatus(await owner.post(`/api/dashboard/organizations/${demoOrganizationId()}/guest-threads/${threadId}/operations/cancel`, { data: { idempotencyKey: crypto.randomUUID() } }), 200)
    await owner.dispose()
  }
})
