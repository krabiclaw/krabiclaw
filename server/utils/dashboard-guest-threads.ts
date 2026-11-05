import { getGuestRequest } from '~/server/domain/requests'
import { queryFirst, type DbClient } from '~/server/db'
import { HTTPError, type H3Event } from 'nitro'
import { getInboxThread, getInboxThreadDetails } from '~/server/domain/guest-threads/inbox'
import { countUnreadInboxThreads, listGuestThreads } from '~/server/domain/guest-threads/repository'
import type {
  GuestThreadSubmissionType,
  InboxListPage,
  InboxRow,
  InboxThreadKind,
  InboxUnreadCounts,
} from '~/server/domain/guest-threads/types'
import type { GuestThreadMailbox } from '~/server/domain/guest-threads/mailbox'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { assertAssignedBookingAccess, memberAccessPrincipal, assertRoleAllows, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { publishNotificationInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { acknowledgeThreadNotifications } from '~/server/utils/notification-acknowledgement'
import { getNotificationAccess } from '~/server/utils/notification-access'
import { listTeamThreads, teamAccessFor } from '~/server/domain/team-messages'
import type { CloudflareEnv } from '~/server/utils/auth'

export interface DashboardGuestThreadListQuery {
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
 * Both thread-list routes parsed this identically, and neither said anything
 * about a parameter it did not implement: `?search=` was accepted, dropped, and
 * the whole inbox returned, which a test then asserted against for months. The
 * keys a caller may send are the keys read here, so the two cannot drift.
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
  const unread = filter('unread', ['1', 'true', '0', 'false'])
  const q = id('q')
  if (q !== null && q.length > 200) throw invalid('q', 'q must be at most 200 characters')
  // The menu's kinds: All is no filter, Team is the team inbox's own list.
  const kind = filter('kind', ['all', 'guests', 'support'])
  return {
    limit: query.limit === undefined ? 100 : Number(query.limit),
    offset: query.offset === undefined ? 0 : Number(query.offset),
    locationId: id('location_id'),
    type: filter<GuestThreadSubmissionType>('type', ['contact', 'reservation', 'booking', 'stay']),
    kind: kind === 'guests' ? 'guest' : kind === 'support' ? 'support' : null,
    q,
    unreadOnly: unread === '1' || unread === 'true',
    mailbox: filter<GuestThreadMailbox>('mailbox', ['current', 'past', 'blocked']),
  }
}

// `org` is the dashboard's route scope, not a filter, and is read elsewhere.
const GUEST_THREAD_LIST_PARAMS = new Set([
  'location_id', 'type', 'kind', 'q', 'unread', 'mailbox', 'org', 'limit', 'offset',
])

/** The extra row proves whether another page exists; no total is inferred. */
export function guestThreadListPage(rows: InboxRow[], query: Pick<DashboardGuestThreadListQuery, 'limit' | 'offset'>): InboxListPage {
  const limit = query.limit ?? 100, offset = query.offset ?? 0
  const hasMore = rows.length > limit
  return { threads: rows.slice(0, limit), pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null } }
}

/** Unread team conversations, for the Team line of the filter menu; a role without team messages has none to count. */
async function unreadTeamThreads(env: CloudflareEnv, db: DbClient, principal: MemberAccessPrincipal): Promise<number> {
  if (!await roleAllows({ ...principal, permissions: { team_messages: ['read'] } })) return 0
  const member = await queryFirst<{ id: string }>(db, 'SELECT id FROM member WHERE organizationId = ? AND userId = ?', [principal.organizationId, principal.userId])
  if (!member) throw new HTTPError({ statusCode: 403, message: 'This account is not a member of the workspace', data: { code: 'MEMBERSHIP_REQUIRED', field: 'organizationId' } })
  return (await listTeamThreads(env, db, await teamAccessFor(principal, member.id, 'read'))).filter(thread => thread.unread).length
}

/** The inbox list and its unread counts for a member whose access is resolved. */
async function memberInbox(env: CloudflareEnv, db: DbClient, organizationId: string, principal: MemberAccessPrincipal, query: DashboardGuestThreadListQuery): Promise<InboxListPage & { unread: InboxUnreadCounts }> {
  const options = {
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
  const [threads, guests, team] = await Promise.all([
    listGuestThreads(db, organizationId, options),
    countUnreadInboxThreads(db, organizationId, options),
    unreadTeamThreads(env, db, principal),
  ])
  // All is the guest and support list; Team is counted on its own line.
  return { ...guestThreadListPage(threads, query), unread: { ...guests, team } }
}

async function assertGuestOperations(principal: MemberAccessPrincipal) {
  if (!await roleAllows({ ...principal, permissions: { operations: ['read'] } })) await assertRoleAllows({ ...principal, permissions: { operations: ['assigned'] } })
}

export async function loadDashboardGuestThreads(
  event: H3Event,
  organizationId: string,
  query: DashboardGuestThreadListQuery,
) {
  const { env, db, organization } = await requireOrganizationMembership(event, organizationId)
  const principal = memberAccessPrincipal(organization.membership, { env, event })
  await assertGuestOperations(principal)
  return memberInbox(env, db, organizationId, principal, query)
}

/** One conversation for a member, read as the viewer; opening it acknowledges its alerts. */
async function memberThread(event: H3Event, organizationId: string, threadId: string) {
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const thread = await getGuestRequest(db, threadId, organizationId)
  if (!thread) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Thread not found', data: { code: 'THREAD_NOT_FOUND', field: 'threadId' } })
  }
  const principal = memberAccessPrincipal(organization.membership, { env, event })
  await assertAssignedBookingAccess(db, { ...principal, requestId: thread.id })
  return { db, env, thread, principal }
}

export async function loadDashboardGuestThread(
  event: H3Event,
  organizationId: string,
  threadId: string,
) {
  const { db, env, thread, principal } = await memberThread(event, organizationId, threadId)
  const view = await getInboxThread(db, threadId, organizationId, { audience: 'member', userId: principal.userId, principal })
  if (!view) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Thread not found', data: { code: 'THREAD_NOT_FOUND', field: 'threadId' } })
  }

  const notificationAccess = await getNotificationAccess(event)
  const acknowledged = await acknowledgeThreadNotifications(db, notificationAccess, threadId)
  if (acknowledged > 0) {
    await publishNotificationInvalidation(env, {
      type: 'notification.read',
      organizationId: thread.organization_id,
      locationId: thread.location_id,
      targetUserId: notificationAccess.userId,
    })
  }
  return { thread: view }
}

/** "In this conversation": its people, gallery and actions. */
export async function loadDashboardGuestThreadDetails(event: H3Event, organizationId: string, threadId: string) {
  const { db, principal } = await memberThread(event, organizationId, threadId)
  const details = await getInboxThreadDetails(db, threadId, organizationId, { audience: 'member', userId: principal.userId, principal })
  if (!details) throw new HTTPError({ statusCode: 404, statusMessage: 'Thread not found', data: { code: 'THREAD_NOT_FOUND', field: 'threadId' } })
  return details
}

export async function loadOrganizationGuestThreads(
  event: H3Event,
  query: DashboardGuestThreadListQuery,
  scope?: { orgSlug?: string | null },
) {
  const { db, env, organization } = await getDashboardMemberContext(event, {
    requireOrganization: true,
    organizationSlug: scope?.orgSlug,
  })
  // The one principal. Assembling a second shape here — a role, an id and a
  // team list the caller had gathered — is what let this list scope its rows
  // by a rule the thread list did not use.
  const principal = memberAccessPrincipal(organization, { env, event })
  await assertGuestOperations(principal)
  return memberInbox(env, db, organization.id, principal, query)
}
