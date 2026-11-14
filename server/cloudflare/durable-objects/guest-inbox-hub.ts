import { DurableObject } from 'cloudflare:workers'
import { HTTPError } from 'nitro'
import { isDashboardInvalidation, type DashboardInvalidation } from '../../../shared/dashboard-invalidations'
import { queryAll, queryFirst } from '~/server/db'
import { assignedMemberSql, memberAccessPrincipal, resolveMembership, roleAllows, type ResolvedMembership } from '~/server/utils/member-access'
import { assertConversationAccess, guestVisibleSql } from '~/server/domain/conversations'
import { createAuth, type CloudflareEnv } from '~/server/utils/auth'
import { runOrganizationJobs } from '~/server/domain/cleaner-jobs'
import { guestInboxTarget, SCHEDULED_AUTHOR_HEADER } from '~/server/cloudflare/guest-inbox-events'

type GuestInboxHubEnv = CloudflareEnv

const JOBS_ORGANIZATION = 'jobs:organization'

interface InboxSocketAttachment {
  organizationId: string | null
  userId: string
  sessionId: string
  /** Better Auth's opaque session credential, private across hibernation. */
  sessionToken: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSocketAttachment(value: unknown): value is InboxSocketAttachment {
  return isRecord(value)
    && (value.organizationId === null || typeof value.organizationId === 'string')
    && value.scope === undefined
    && typeof value.userId === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.sessionToken === 'string' && Boolean(value.sessionToken)
}

function failure(status: number, code: string, message: string, field: string): Response {
  return Response.json({ error: message, code, field }, { status })
}

async function socketSession(env: GuestInboxHubEnv, attachment: InboxSocketAttachment) {
  const headers = new Headers({ authorization: `Bearer ${attachment.sessionToken}` })
  // The open socket must not extend a revoked or expired session through the
  // browser's cookie cache. Better Auth remains the session authority.
  const session = await createAuth(env).api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (!session || session.user.id !== attachment.userId || session.session.id !== attachment.sessionId) return null
  return session
}

async function canReceive(env: GuestInboxHubEnv, membership: ResolvedMembership, event: DashboardInvalidation): Promise<boolean> {
  // Scope changes carry no resource or person identity. Former assignees must
  // learn to re-read too, even though resource events no longer reach them.
  if (event.type === 'access.changed' || event.type === 'business.changed') return true
  // A read position or archive moved: the reader's own apps alone.
  if (event.type === 'MESSAGE_ACK') return true
  if (event.type === 'CONVERSATION_LEAVE') {
    // An old keyed retry must not evict someone who has since been added again.
    return !await queryFirst(env.DB, 'SELECT 1 FROM conversation_participants WHERE organization_id = ? AND conversation_id = ? AND user_id = ?',
      [membership.organizationId, event.conversation_id, membership.userId])
  }
  if (event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE') {
    // Only current conversation participants can receive its message events.
    try {
      await assertConversationAccess(env.DB, memberAccessPrincipal(membership, { env }), event.conversation_id)
      return true
    } catch (error) {
      if (error instanceof HTTPError && error.status === 404) return false
      throw error
    }
  }
  if (event.type !== 'stay.changed' && event.type !== 'nights.changed') throw new Error(`Dashboard event ${event.type} has no audience rule`)
  if (await roleAllows({ ...membership, permissions: { operations: ['read'] } })) return true
  // What remains is a home's stay or nights change: the home's responsible members.
  return Boolean(await queryFirst(env.DB, `SELECT c.product_id FROM product_stay_configs s JOIN product_booking_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      WHERE c.organization_id = ? AND c.product_id = ? AND (${assignedMemberSql('c')})`,
    [membership.organizationId, event.product_id, membership.userId]))
}

/** Use the conversation's guest seats and the same visibility rule as its history. */
async function guestAudience(env: GuestInboxHubEnv, event: DashboardInvalidation): Promise<string[]> {
  if (!('conversation_id' in event)) return []
  if (event.type === 'CONVERSATION_LEAVE') {
    // The committed removal names a former recipient. A retry must not remove
    // a traveler who gained a seat again in the meantime.
    const removed = await queryFirst(env.DB, `SELECT 1 FROM conversations c
      WHERE c.organization_id = ? AND c.id = ? AND c.kind <> 'team' AND NOT EXISTS (
        SELECT 1 FROM conversation_participants seat WHERE seat.conversation_id = c.id AND seat.user_id = ? AND seat.role = 'guest')`,
    [event.organization_id, event.conversation_id, event.user_id])
    return removed ? [event.user_id] : []
  }
  const message = 'message' in event ? event.message : undefined
  const rows = await queryAll<{ user_id: string }>(env.DB, `SELECT seat.user_id
    FROM conversation_participants seat JOIN conversations c ON c.id = seat.conversation_id AND c.organization_id = seat.organization_id
    WHERE c.organization_id = ? AND c.id = ? AND c.kind <> 'team' AND seat.role = 'guest'
    ${event.type === 'MESSAGE_ACK' ? 'AND seat.user_id = ?' : ''}
    ${message ? `AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.id = ? AND ${guestVisibleSql('m', 'c.user_id = seat.user_id')})` : ''}`,
  [event.organization_id, event.conversation_id, ...(event.type === 'MESSAGE_ACK' ? [event.user_id] : []), ...(message ? [message.id] : [])])
  return rows.map(row => row.user_id)
}

export class GuestInboxHubObject extends DurableObject<GuestInboxHubEnv> {
  constructor(ctx: DurableObjectState, env: GuestInboxHubEnv) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.env.DB || !this.env.BETTER_AUTH_SECRET) return failure(503, 'REALTIME_CONFIGURATION_REQUIRED', 'Dashboard realtime configuration is incomplete', 'realtime')
    try {
      return await this.handleRequest(request)
    } catch (error) {
      console.error('dashboard_realtime_failed', { name: error instanceof Error ? error.name : 'UnknownError' })
      return failure(503, 'REALTIME_UNAVAILABLE', 'Dashboard realtime could not complete the request', 'realtime')
    }
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      return await this.handleBroadcast(request)
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return failure(426, 'WEBSOCKET_UPGRADE_REQUIRED', 'Expected WebSocket upgrade', 'Upgrade')
    }

    // The public Worker verifies the session and scope before creating these
    // headers for the private binding. No client headers are forwarded.
    const attachment = {
      organizationId: request.headers.get('x-krabiclaw-organization-id'),
      userId: request.headers.get('x-krabiclaw-user-id'),
      sessionId: request.headers.get('x-krabiclaw-session-id'),
      sessionToken: request.headers.get('x-krabiclaw-session-token'),
    }
    if (!isSocketAttachment(attachment)) return failure(401, 'UNAUTHORIZED', 'Authentication required', 'session')
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    if (!client || !server) return failure(500, 'WEBSOCKET_UNAVAILABLE', 'WebSocket pair unavailable', 'realtime')
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * The organization's cleaning jobs. Every stay or business change wakes them
   * at once (a job given, moved or cancelled is told in its conversation right
   * away); each wake reads D1, posts what is due and re-arms to the next
   * reminder. A wake that throws is retried by the alarm itself.
   */
  private async wakeJobs(organizationId: string): Promise<void> {
    await this.ctx.storage.put(JOBS_ORGANIZATION, organizationId)
    await this.ctx.storage.setAlarm(Date.now())
  }

  override async alarm(): Promise<void> {
    const organizationId = await this.ctx.storage.get<string>(JOBS_ORGANIZATION)
    if (!organizationId) throw new Error('The jobs alarm fired for a hub that holds no organization')
    const { next, failures } = await runOrganizationJobs(this.env, this.env.DB, organizationId)
    if (next) {
      // A change that arrived while this ran has already set an earlier wake.
      const scheduled = await this.ctx.storage.getAlarm()
      if (scheduled === null || next.getTime() < scheduled) await this.ctx.storage.setAlarm(next.getTime())
    }
    // The other jobs' reminders are armed before a failing one is reported.
    if (failures.length) throw new AggregateError(failures, `${failures.length} cleaning jobs of ${organizationId} could not be told about: ${failures.map(error => error instanceof Error ? error.message : String(error)).join('; ')}`)
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping' || (typeof message === 'string' && message === 'ping')) {
      socket.send('pong')
    }
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    console.error('Dashboard WebSocket error', error)
    socket.close(1011, 'Guest inbox connection error')
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    let event: unknown
    try {
      event = await request.json()
    } catch {
      return failure(400, 'INVALID_JSON', 'Dashboard invalidation must be valid JSON', 'body')
    }
    const organizationId = request.headers.get('x-krabiclaw-organization-id')
    if (!organizationId || !isDashboardInvalidation(event) || event.organization_id !== organizationId) {
      return failure(400, 'INVALID_DASHBOARD_INVALIDATION', 'Invalid dashboard invalidation', 'body')
    }
    const accountUserId = request.headers.get('x-krabiclaw-account-user-id')
    if (accountUserId !== null) {
      if (!accountUserId || !('conversation_id' in event) || ('scheduled' in event && event.scheduled) || ('team' in event && event.team)
        || ('user_id' in event && event.user_id !== accountUserId)) {
        return failure(400, 'INVALID_DASHBOARD_INVALIDATION', 'Invalid account conversation event', 'body')
      }
      return this.broadcastToSockets(event, accountUserId)
    }
    const scheduledAuthor = request.headers.get(SCHEDULED_AUTHOR_HEADER)
    const scheduleOnly = event.type === 'MESSAGE_UPDATE' && event.scheduled === true
    const scheduledSend = event.type === 'MESSAGE_CREATE' && !event.team && scheduledAuthor !== null
    if (scheduleOnly ? scheduledAuthor === null : scheduledAuthor !== null && !scheduledSend) {
      return failure(400, 'INVALID_DASHBOARD_INVALIDATION', 'Invalid scheduled message audience', SCHEDULED_AUTHOR_HEADER)
    }
    // A stay, booking or task write is announced this way (a booking's in its guest conversation); the organization's jobs follow it.
    if (event.type === 'stay.changed' || event.type === 'business.changed' || ((event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE') && !event.team)) await this.wakeJobs(organizationId)

    const accounts = !scheduleOnly && !('team' in event && event.team) ? await guestAudience(this.env, event) : []
    const namespace = this.env.GUEST_INBOX_HUBS
    if (accounts.length && !namespace) return failure(503, 'REALTIME_CONFIGURATION_REQUIRED', 'Guest inbox binding is not configured', 'realtime')
    const guestEvent = event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE' ? { ...event, location_id: null } : event
    const responses = await Promise.all([
      this.broadcastToSockets(event, null, scheduledAuthor),
      ...accounts.map(userId => {
        const binding = namespace!
        const recipient = binding.get(binding.idFromName(guestInboxTarget(null, userId)))
        return recipient.fetch('https://guest-inbox.internal/broadcast', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-krabiclaw-organization-id': organizationId, 'x-krabiclaw-account-user-id': userId },
          body: JSON.stringify(guestEvent),
        })
      }),
    ])
    return responses.find(response => !response.ok) ?? new Response(null, { status: 204 })
  }

  private async broadcastToSockets(event: DashboardInvalidation, accountUserId: string | null, scheduledAuthor: string | null = null): Promise<Response> {
    const organizationId = event.organization_id
    const scheduleOnly = event.type === 'MESSAGE_UPDATE' && event.scheduled === true
    const scheduledSend = event.type === 'MESSAGE_CREATE' && !event.team && scheduledAuthor !== null
    // Every eligible dashboard must receive the event. A socket whose send
    // throws is closed so its client reconnects and reconciles, and the
    // publication fails with its code so the committed write's caller sees it
    // and the idempotent retry repairs it.
    const encoded = JSON.stringify(event)
    const scheduledChange = scheduleOnly || scheduledSend
      ? JSON.stringify({ ...event, type: 'MESSAGE_UPDATE', scheduled: true, message: undefined, location_id: null })
      : encoded
    const scheduleTaskChange = scheduleOnly && scheduledAuthor === '' ? JSON.stringify({
      type: 'business.changed', event_id: event.event_id, organization_id: organizationId, occurred_at: event.occurred_at,
    } satisfies DashboardInvalidation) : null
    let eligible = 0
    const failures: string[] = []
    const sessions = new Map<string, Awaited<ReturnType<typeof socketSession>>>()
    const memberships = new Map<string, ResolvedMembership | null>()
    const deliveries = new Map<string, string | null>()
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue
      const attachment: unknown = socket.deserializeAttachment()
      if (!isSocketAttachment(attachment)) {
        socket.close(1008, 'Authentication required')
        continue
      }
      if (accountUserId === null ? attachment.organizationId !== organizationId : attachment.organizationId !== null || attachment.userId !== accountUserId) continue
      if ((event.type === 'CONVERSATION_LEAVE' || event.type === 'MESSAGE_ACK') && event.user_id !== attachment.userId) continue
      const sessionKey = JSON.stringify([attachment.userId, attachment.sessionId, attachment.sessionToken])
      if (!sessions.has(sessionKey)) sessions.set(sessionKey, await socketSession(this.env, attachment))
      const session = sessions.get(sessionKey)
      if (session && accountUserId === null && !memberships.has(attachment.userId)) {
        memberships.set(attachment.userId, await resolveMembership(this.env, { organizationId, userId: attachment.userId }))
      }
      const membership = session ? memberships.get(attachment.userId) : null
      let eventToSend = encoded
      const revoke = !session || (accountUserId === null && !membership)
      if (membership) {
        if (!deliveries.has(attachment.userId)) {
          const seesConversation = !scheduleOnly || scheduleTaskChange ? await canReceive(this.env, membership, event) : false
          const seesSchedule = (scheduleOnly || !seesConversation) && (scheduledAuthor === ''
            ? await roleAllows({ ...membership, permissions: { operations: ['update'] } }) : scheduledAuthor === attachment.userId)
          deliveries.set(attachment.userId, !scheduleOnly && seesConversation ? encoded
            : seesSchedule ? scheduledChange : seesConversation ? scheduleTaskChange : null)
        }
        const delivery = deliveries.get(attachment.userId)
        if (!delivery) continue
        eventToSend = delivery
      }
      if (socket.readyState !== WebSocket.OPEN) continue
      eligible += 1
      try {
        if (revoke) {
          if (event.type === 'access.changed') socket.send(encoded)
          socket.close(1008, 'Session or conversation access ended')
        } else socket.send(eventToSend)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
        socket.close(1011, 'Dashboard update delivery failed')
      }
    }
    if (failures.length > 0) {
      return Response.json({
        error: `Dashboard invalidation failed for ${failures.length} of ${eligible} connected dashboards: ${failures.join('; ')}`,
        code: 'DASHBOARD_DELIVERY_FAILED',
        field: 'realtime',
        eligible,
        failed: failures.length,
      }, { status: 502 })
    }

    return new Response(null, { status: 204 })
  }
}
