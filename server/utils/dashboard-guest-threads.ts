import { getGuestRequest } from '~/server/domain/requests'
import type { DbClient } from '~/server/db'
import { HTTPError, type H3Event } from 'nitro'
import { getGuestThreadDetail } from '~/server/domain/guest-threads/detail'
import {
  getGuestThreadOperationSummary,
  listGuestThreads,
  listOrganizationGuestThreads,
} from '~/server/domain/guest-threads/repository'
import type {
  ConversationState,
  GuestThreadSubmissionType,
  GuestThreadListItemViewModel,
  GuestThreadListPage,
} from '~/server/domain/guest-threads/types'
import type { GuestThreadMailbox } from '~/server/domain/guest-threads/mailbox'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { assertAssignedBookingAccess, memberAccessPrincipal, assertRoleAllows, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { publishNotificationInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { acknowledgeThreadNotifications } from '~/server/utils/notification-acknowledgement'
import { getNotificationAccess } from '~/server/utils/notification-access'

export interface DashboardGuestThreadListQuery {
  limit?: number
  offset?: number
  locationId?: string | null
  type?: GuestThreadSubmissionType | null
  conversationState?: ConversationState | null
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
  return {
    limit: query.limit === undefined ? 100 : Number(query.limit),
    offset: query.offset === undefined ? 0 : Number(query.offset),
    locationId: id('location_id'),
    type: filter<GuestThreadSubmissionType>('type', ['contact', 'reservation', 'booking', 'stay']),
    conversationState: filter<ConversationState>('conversation_state', ['needs_attention', 'waiting_on_guest', 'resolved']),
    unreadOnly: unread === '1' || unread === 'true',
    mailbox: filter<GuestThreadMailbox>('mailbox', ['current', 'past']),
  }
}

// `org` is the dashboard's route scope, not a filter, and is read elsewhere.
const GUEST_THREAD_LIST_PARAMS = new Set([
  'location_id', 'type', 'conversation_state', 'unread', 'mailbox', 'org', 'limit', 'offset',
])

/** The extra row proves whether another page exists; no total is inferred. */
export function guestThreadListPage(rows: GuestThreadListItemViewModel[], query: Pick<DashboardGuestThreadListQuery, 'limit' | 'offset'>): GuestThreadListPage {
  const limit = query.limit ?? 100, offset = query.offset ?? 0
  const hasMore = rows.length > limit
  return { threads: rows.slice(0, limit), pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null } }
}

/**
 * The thread list for a caller whose access is already resolved.
 *
 * `loadDashboardGuestThreads` below is this with the resolution in front of it,
 * for a request that arrives with nothing. A caller that has already resolved
 * the principal and asserted the same scope — the location overview does both —
 * uses this instead of handing over its event and paying for the whole chain a
 * second time.
 */
export async function listDashboardGuestThreadsForPrincipal(
  db: DbClient,
  organizationId: string,
  input: { principal: MemberAccessPrincipal; userId: string; query: DashboardGuestThreadListQuery },
) {
  const { principal, userId, query } = input
  const options = {
    limit: (query.limit ?? 100) + 1,
    offset: query.offset ?? 0,
    locationId: query.locationId ?? null,
    principal,
    userId,
    type: query.type ?? null,
    conversationState: query.conversationState ?? null,
    mailbox: query.mailbox ?? null,
    unreadOnly: query.unreadOnly ?? false,
  }
  const [threads, summary] = await Promise.all([
    listGuestThreads(db, organizationId, options),
    getGuestThreadOperationSummary(db, organizationId, options),
  ])
  return { ...guestThreadListPage(threads, query), summary }
}

export async function loadDashboardGuestThreads(
  event: H3Event,
  organizationId: string,
  query: DashboardGuestThreadListQuery,
) {
  const { env, db, session, organization } = await requireOrganizationMembership(event, organizationId)
  const principal = memberAccessPrincipal(organization.membership, { env, event })
  if (!await roleAllows({ ...principal, permissions: { operations: ['read'] } })) await assertRoleAllows({ ...principal, permissions: { operations: ['assigned'] } })
  return listDashboardGuestThreadsForPrincipal(db, organizationId, { principal, userId: session.user.id, query })
}

export async function loadDashboardGuestThread(
  event: H3Event,
  organizationId: string,
  threadId: string,
) {
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const thread = await getGuestRequest(db, threadId, organizationId)
  if (!thread) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Thread not found', data: { code: 'THREAD_NOT_FOUND', field: 'threadId' } })
  }
  await assertAssignedBookingAccess(db, { ...memberAccessPrincipal(organization.membership, { env, event }), requestId: thread.id })

  const detail = await getGuestThreadDetail(db, threadId, organizationId)
  if (!detail) {
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
  return { thread: detail }
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
  const userId = organization.userId
  // The rows are filtered by location scope below, so this only asks whether
  // the role takes part in guest operations at all.
  if (!await roleAllows({ organizationId: organization.id, role: organization.role, permissions: { operations: ['read'] } })) await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { operations: ['assigned'] } })

  // The one principal. Assembling a second shape here — a role, an id and a
  // team list the caller had gathered — is what let this list scope its rows
  // by a rule the thread list did not use.
  const principal = memberAccessPrincipal(organization, { env, event })
  const options = {
    limit: (query.limit ?? 100) + 1,
    offset: query.offset ?? 0,
    organizationId: organization.id,
    locationId: query.locationId ?? null,
    principal,
    userId,
    type: query.type ?? null,
    conversationState: query.conversationState ?? null,
    mailbox: query.mailbox ?? null,
    unreadOnly: query.unreadOnly ?? false,
  }
  const [threads, summary] = await Promise.all([
    listOrganizationGuestThreads(db, options),
    getGuestThreadOperationSummary(db, options.organizationId, options),
  ])
  return { ...guestThreadListPage(threads, query), summary }
}
