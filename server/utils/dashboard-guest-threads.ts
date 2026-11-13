import type { DbClient } from '~/server/db'
import { HTTPError, type H3Event } from 'nitro'
import { getInboxThread, getInboxThreadDetails } from '~/server/domain/guest-threads/inbox'
import { countUnreadConversations, listConversations } from '~/server/domain/guest-threads/repository'
import type {
  GuestThreadSubmissionType,
  InboxListPage,
  InboxRow,
  InboxThreadKind,
  InboxUnreadCounts,
} from '~/server/domain/guest-threads/types'
import type { GuestThreadMailbox } from '~/server/domain/guest-threads/mailbox'
import { requireOrganizationMembership, requireOrganizationPrincipal } from '~/server/utils/location-access'
import { memberAccessPrincipal, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { assertConversationAccess, assertGuestOperations, type ConversationRow } from '~/server/domain/conversations'
import type { CloudflareEnv } from '~/server/utils/auth'
import { messageListPage } from '~/server/domain/guest-message-schedule'

export interface DashboardGuestThreadListQuery {
  conversationIds?: string[]
  includeSortKey?: boolean
  limit?: number
  offset?: number
  locationId?: string | null
  type?: GuestThreadSubmissionType | null
  kind?: InboxThreadKind | null
  q?: string | null
  unreadOnly?: boolean
  mailbox?: GuestThreadMailbox | null
}

/**
 * The keys a caller may send are the keys read here: a parameter the list
 * does not implement is refused, never accepted and dropped (`?search=` once
 * returned the whole inbox, which a test then asserted against for months).
 */
export function parseGuestThreadListQuery(query: Record<string, unknown>): DashboardGuestThreadListQuery {
  const invalid = (field: string, message: string) => new HTTPError({ statusCode: 400, message, data: { code: 'INVALID_GUEST_THREAD_FILTER', field } })
  const unsupported = Object.keys(query).filter(key => !GUEST_THREAD_LIST_PARAMS.has(key))
  if (unsupported.length) throw invalid(unsupported.join(','), `Unsupported query parameter(s): ${unsupported.join(', ')}`)
  for (const key of ['limit', 'offset'] as const) {
    const value = query[key]
    if (value !== undefined && (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))
      || (key === 'limit' ? Number(value) < 1 || Number(value) > 100 : Number(value) < 0))) {
      throw invalid(key, key === 'limit' ? 'limit must be an integer from 1 to 100' : 'offset must be a nonnegative safe integer')
    }
  }
  // An absent filter lists everything; a present one that is not a value the
  // filter takes is refused, never read as absent and answered with every row.
  function filter<T extends string>(key: string, values: readonly T[]): T | null {
    const value = query[key]
    if (value === undefined) return null
    if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T
    throw invalid(key, `${key} must be one of: ${values.join(', ')}`)
  }
  function id(key: string): string | null {
    const value = query[key]
    if (value === undefined) return null
    if (typeof value === 'string' && value.trim()) return value.trim()
    throw invalid(key, `${key} must be a non-empty string`)
  }
  const ids = id('ids')?.split(',')
  if (ids && (ids.length > 100 || ids.some(value => !value || value.length > 200) || query.offset !== undefined)) {
    throw invalid('ids', 'ids must name up to 100 conversations without an offset')
  }
  const includeSortKey = filter('sort_key', ['1'])
  const unread = filter('unread', ['1', 'true', '0', 'false'])
  const q = id('q')
  if (q !== null && q.length > 200) throw invalid('q', 'q must be at most 200 characters')
  // The menu's kinds: All is no filter.
  const kind = filter('kind', ['all', 'guests', 'support', 'team'])
  return {
    conversationIds: ids,
    includeSortKey: Boolean(includeSortKey),
    limit: query.limit === undefined ? 100 : Number(query.limit),
    offset: query.offset === undefined ? 0 : Number(query.offset),
    locationId: id('location_id'),
    type: filter<GuestThreadSubmissionType>('type', ['contact', 'booking', 'stay']),
    kind: kind === 'guests' ? 'guest' : kind === 'support' ? 'support' : kind === 'team' ? 'team' : null,
    q,
    unreadOnly: unread === '1' || unread === 'true',
    mailbox: filter<GuestThreadMailbox>('mailbox', ['current', 'past', 'blocked']),
  }
}

// `org` is the dashboard's route scope, not a filter, and is read elsewhere.
const GUEST_THREAD_LIST_PARAMS = new Set([
  'location_id', 'type', 'kind', 'q', 'unread', 'mailbox', 'org', 'limit', 'offset', 'ids', 'sort_key',
])

/** The extra row proves whether another page exists; no total is inferred. */
export function guestThreadListPage(rows: InboxRow[], query: Pick<DashboardGuestThreadListQuery, 'limit' | 'offset'>): InboxListPage {
  const { items: threads, pagination } = messageListPage(rows, { limit: query.limit ?? 100, offset: query.offset ?? 0 })
  return { threads, pagination }
}

/** The list response the dashboard and the app read, with its unread counts; the contract fixtures in contracts/inbox are generated from it. */
export async function memberInbox(db: DbClient, organizationId: string, principal: MemberAccessPrincipal, query: DashboardGuestThreadListQuery): Promise<InboxListPage & { unread: InboxUnreadCounts }> {
  const options = {
    conversationIds: query.conversationIds,
    includeSortKey: query.includeSortKey,
    limit: (query.limit ?? 100) + 1,
    offset: query.offset ?? 0,
    locationId: query.locationId ?? null,
    principal,
    userId: principal.userId,
    type: query.type ?? null,
    kind: query.kind ?? null,
    q: query.q ?? null,
    mailbox: query.mailbox ?? null,
    unreadOnly: query.unreadOnly ?? false,
  }
  const [threads, unread] = await Promise.all([
    listConversations(db, organizationId, options),
    countUnreadConversations(db, organizationId, options),
  ])
  return { ...guestThreadListPage(threads, query), unread }
}

/** Every conversation the member sees, of every kind: what their role and their seats let them read. */
export async function loadOrganizationConversations(event: H3Event, organizationId: string, query: DashboardGuestThreadListQuery) {
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  return memberInbox(db, organizationId, memberAccessPrincipal(organization.membership, { env, event }), query)
}

/** The workspace Messages badge counts exactly the same Current conversations as the list. */
export async function loadOrganizationConversationUnread(event: H3Event, organizationId: string) {
  const { db, principal } = await requireOrganizationPrincipal(event, organizationId)
  return countUnreadConversations(db, organizationId, { principal, userId: principal.userId })
}

/** One conversation the member may read, by the one access statement. */
export async function memberConversation(event: H3Event, organizationId: string, conversationId: string): Promise<{ db: DbClient; env: CloudflareEnv; principal: MemberAccessPrincipal; conversation: ConversationRow }> {
  const { db, env, principal } = await requireOrganizationPrincipal(event, organizationId)
  return { db, env, principal, conversation: await assertConversationAccess(db, principal, conversationId) }
}

/** One guest conversation for a member, read as the viewer. */
async function memberThread(event: H3Event, organizationId: string, threadId: string) {
  const { db, principal, conversation } = await memberConversation(event, organizationId, threadId)
  await assertGuestOperations(principal)
  if (conversation.kind === 'team') throw new HTTPError({ statusCode: 404, statusMessage: 'Thread not found', data: { code: 'THREAD_NOT_FOUND', field: 'threadId' } })
  return { db, conversation, principal }
}

/** The conversation as the member reads it. Reading it never writes: the client reads it through with POST …/read. */
export async function loadDashboardGuestThread(event: H3Event, organizationId: string, threadId: string) {
  const { db, conversation, principal } = await memberThread(event, organizationId, threadId)
  const view = await getInboxThread(db, threadId, organizationId, { audience: 'member', userId: principal.userId, principal, conversation })
  if (!view) throw new HTTPError({ statusCode: 404, statusMessage: 'Thread not found', data: { code: 'THREAD_NOT_FOUND', field: 'threadId' } })
  return { thread: view }
}

/** "In this conversation": its people, gallery and actions. */
export async function loadDashboardGuestThreadDetails(event: H3Event, organizationId: string, threadId: string) {
  const { db, conversation, principal } = await memberThread(event, organizationId, threadId)
  const details = await getInboxThreadDetails(db, threadId, organizationId, { audience: 'member', userId: principal.userId, principal, conversation })
  if (!details) throw new HTTPError({ statusCode: 404, statusMessage: 'Thread not found', data: { code: 'THREAD_NOT_FOUND', field: 'threadId' } })
  return details
}
