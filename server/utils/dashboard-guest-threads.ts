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
} from '~/server/domain/guest-threads/types'
import type { GuestThreadMailbox } from '~/server/domain/guest-threads/mailbox'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { assertAssignedBookingAccess, memberAccessPrincipal, assertRoleAllows, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { publishNotificationInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { acknowledgeThreadNotifications } from '~/server/utils/notification-acknowledgement'
import { getNotificationAccess } from '~/server/utils/notification-access'

export interface DashboardGuestThreadListQuery {
  locationId?: string | null
  type?: GuestThreadSubmissionType | null
  conversationState?: ConversationState | null
  unreadOnly?: boolean
  mailbox?: GuestThreadMailbox | null
}

export interface OrganizationGuestThreadListQuery extends DashboardGuestThreadListQuery {
  organizationId?: string | null
}

/**
 * Both thread-list routes parsed this identically, and neither said anything
 * about a parameter it did not implement: `?search=` was accepted, dropped, and
 * the whole inbox returned, which a test then asserted against for months. The
 * keys a caller may send are the keys read here, so the two cannot drift.
 */
export function parseGuestThreadListQuery(
  query: Record<string, unknown>,
): { error: string } | OrganizationGuestThreadListQuery {
  const read = (key: string) => typeof query[key] === 'string' ? (query[key] as string).trim() : ''
  const unsupported = Object.keys(query).filter(key => !GUEST_THREAD_LIST_PARAMS.has(key))
  if (unsupported.length) return { error: `Unsupported query parameter(s): ${unsupported.join(', ')}` }

  const type = read('type')
  const conversationState = read('conversation_state')
  const mailbox = read('mailbox')
  return {
    organizationId: read('organization_id') || null,
    locationId: read('location_id') || null,
    type: type === 'contact' || type === 'reservation' || type === 'booking' || type === 'stay' ? type as GuestThreadSubmissionType : null,
    conversationState: conversationState === 'needs_attention' || conversationState === 'waiting_on_guest' || conversationState === 'resolved'
      ? conversationState as ConversationState
      : null,
    unreadOnly: query.unread === '1' || query.unread === 'true',
    mailbox: mailbox === 'current' || mailbox === 'past' ? mailbox : null,
  }
}

// `org` is the dashboard's route scope, not a filter, and is read elsewhere.
const GUEST_THREAD_LIST_PARAMS = new Set([
  'organization_id', 'location_id', 'type', 'conversation_state', 'unread', 'mailbox', 'org',
])

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
  return { threads, summary }
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
    throw new HTTPError({ statusCode: 404, statusMessage: 'Thread not found' })
  }
  await assertAssignedBookingAccess(db, { ...memberAccessPrincipal(organization.membership, { env, event }), requestId: thread.id })

  const detail = await getGuestThreadDetail(db, threadId, organizationId)
  if (!detail) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Thread not found' })
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
  query: OrganizationGuestThreadListQuery,
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
  return { threads, summary }
}
