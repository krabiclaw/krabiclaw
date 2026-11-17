import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import type {
  InboxRow,
} from '../../server/domain/guest-threads/types'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { seededTenant } from './seed/manifest'
import { devLoginHeaders, seededSiteHeaders, testBaseUrl } from './test-env'
import type { ConversationEntry, ConversationHeader, ConversationPage } from '../../shared/messages-contract'

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

const baseURL = testBaseUrl()
// Contact threads run on the seeded experience business.
const organizationId = () => seededTenant('experience').organizationId
const ownerId = 'user-e2e-pottery-owner'
const secondOwnerId = 'user-e2e-pottery-location-owner'
const foreignOwnerId = 'user-e2e-kikuzuki-owner'
const writable = ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)

async function expectStatus(response: APIResponse, status: number) {
  expect(response.status(), await response.text()).toBe(status)
}

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

type StreamMessage = Extract<ConversationEntry, { type: 'message' }>
const streamMessages = (thread: ConversationHeader & { stream: ConversationEntry[] }) => thread.stream.filter((item): item is StreamMessage => item.type === 'message')

/** Opening a conversation reads it through to the newest message shown; the GET that showed it wrote nothing. */
async function readThrough(request: APIRequestContext, thread: ConversationHeader & { stream: ConversationEntry[] }) {
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
      booking_id: null,
    })
    expect(detail.composer).toEqual({ channel: 'email' })
    // The guest's own words open the conversation, once, as their message.
    expect(streamMessages(detail)).toMatchObject([{ side: 'guest', author: guestName, body: message, photos: [] }])
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
  } finally {
    await Promise.all([owner.dispose(), guest.dispose(), secondOwner.dispose(), foreignOwner.dispose()])
  }
})
