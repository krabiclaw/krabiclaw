import { DurableObject } from 'cloudflare:workers'
import { HTTPError } from 'nitro'
import { isDashboardInvalidation, type DashboardInvalidation } from '../../../shared/dashboard-invalidations'
import { queryFirst } from '~/server/db'
import { assignedMemberSql, memberAccessPrincipal, resolveMembership, roleAllows, type ResolvedMembership } from '~/server/utils/member-access'
import { assertConversationAccess, guestVisibleSql, participantGuard, resolveConversationAccess, type ParticipantRole } from '~/server/domain/conversations'
import { createAuth, type CloudflareEnv } from '~/server/utils/auth'
import { runOrganizationJobs } from '~/server/domain/cleaner-jobs'
import { SCHEDULED_AUTHOR_HEADER } from '~/server/cloudflare/guest-inbox-events'

type GuestInboxHubEnv = CloudflareEnv

const JOBS_ORGANIZATION = 'jobs:organization'

interface InboxSocketAttachment {
  organizationId: string
  userId: string
  sessionId: string
  /** Better Auth's opaque session credential, private across hibernation. */
  sessionToken: string
  scope?: { conversationId: string; role: ParticipantRole }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSocketAttachment(value: unknown): value is InboxSocketAttachment {
  return isRecord(value)
    && typeof value.organizationId === 'string'
    && typeof value.userId === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.sessionToken === 'string' && Boolean(value.sessionToken)
    && (value.scope === undefined || (isRecord(value.scope) && typeof value.scope.conversationId === 'string'
      && (value.scope.role === 'guest' || value.scope.role === 'member')))
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

async function canReceive(env: GuestInboxHubEnv, attachment: InboxSocketAttachment, membership: ResolvedMembership, event: DashboardInvalidation): Promise<boolean> {
  if (attachment.organizationId !== event.organization_id) return false
  // Scope changes carry no resource or person identity. Former assignees must
  // learn to re-read too, even though resource events no longer reach them.
  if (event.type === 'access.changed' || event.type === 'business.changed') return true
  // A read position or archive moved: the reader's own apps alone.
  if (event.type === 'MESSAGE_ACK') return true
  if (event.type === 'CONVERSATION_LEAVE') {
    // An old keyed retry must not evict someone who has since been added again.
    return !await queryFirst(env.DB, 'SELECT 1 FROM conversation_participants WHERE organization_id = ? AND conversation_id = ? AND user_id = ?',
      [attachment.organizationId, event.conversation_id, attachment.userId])
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
    [attachment.organizationId, event.product_id, attachment.userId]))
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

    const organizationId = request.headers.get('x-krabiclaw-organization-id')
    if (!organizationId) return failure(400, 'ORGANIZATION_REQUIRED', 'An explicit organization is required', 'org')
    const auth = createAuth(this.env)
    const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
    if (!session) return failure(401, 'UNAUTHORIZED', 'Authentication required', 'session')
    const conversationId = request.headers.get('x-krabiclaw-conversation-id')
    let scope: InboxSocketAttachment['scope']
    if (conversationId) {
      try {
        const { conversation, role } = await resolveConversationAccess(this.env.DB, session.user.id, conversationId)
        if (conversation.organization_id !== organizationId) return failure(404, 'THREAD_NOT_FOUND', 'Conversation not found', 'conversation_id')
        scope = { conversationId, role }
      } catch (error) {
        if (error instanceof HTTPError && error.status === 404) return failure(404, 'THREAD_NOT_FOUND', 'Conversation not found', 'conversation_id')
        throw error
      }
    } else if (!await resolveMembership(this.env, { organizationId, userId: session.user.id })) {
      return failure(403, 'FORBIDDEN', 'Access denied', 'permissions')
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    if (!client || !server) return failure(500, 'WEBSOCKET_UNAVAILABLE', 'WebSocket pair unavailable', 'realtime')
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({
      organizationId,
      userId: session.user.id,
      sessionId: session.session.id,
      sessionToken: session.session.token,
      ...(scope && { scope }),
    } satisfies InboxSocketAttachment)
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
    const scheduledAuthor = request.headers.get(SCHEDULED_AUTHOR_HEADER)
    const scheduleOnly = event.type === 'MESSAGE_UPDATE' && event.scheduled === true
    const scheduledSend = event.type === 'MESSAGE_CREATE' && !event.team && scheduledAuthor !== null
    if (scheduleOnly ? scheduledAuthor === null : scheduledAuthor !== null && !scheduledSend) {
      return failure(400, 'INVALID_DASHBOARD_INVALIDATION', 'Invalid scheduled message audience', SCHEDULED_AUTHOR_HEADER)
    }
    // A stay, booking or task write is announced this way (a booking's in its guest conversation); the organization's jobs follow it.
    if (event.type === 'stay.changed' || event.type === 'business.changed' || ((event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE') && !event.team)) await this.wakeJobs(organizationId)

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
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue
      const attachment: unknown = socket.deserializeAttachment()
      if (!isSocketAttachment(attachment)) {
        socket.close(1008, 'Authentication required')
        continue
      }
      if (attachment.organizationId !== organizationId) continue
      const scope = attachment.scope
      if (scope && scheduleOnly) continue
      if (scope && event.type !== 'access.changed' && (!('conversation_id' in event) || event.conversation_id !== scope.conversationId)) continue
      if ((event.type === 'CONVERSATION_LEAVE' || event.type === 'MESSAGE_ACK') && event.user_id !== attachment.userId) continue
      const session = await socketSession(this.env, attachment)
      const membership = session && !scope ? await resolveMembership(this.env, { organizationId, userId: attachment.userId }) : null
      let eventToSend = encoded
      let revoke = !session || (!scope && !membership)
      if (scope && session) {
        const access = participantGuard('c', attachment.userId, scope.role)
        const visibleMessage = scope.role === 'guest' && (event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE') ? event.message : undefined
        const visible = visibleMessage ? `EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.id = ? AND ${guestVisibleSql('m', 'c.user_id = ?')})` : '1'
        const permission = await queryFirst<{ can_see_message: number }>(this.env.DB, `SELECT ${visible} AS can_see_message
          FROM conversations c WHERE c.id = ? AND c.organization_id = ? AND ${access.sql}`, [
          ...(visibleMessage ? [visibleMessage.id, attachment.userId] : []), scope.conversationId, organizationId, ...access.params,
        ])
        revoke = !permission
        if (permission && (!permission.can_see_message || event.type === 'access.changed' || event.type === 'CONVERSATION_LEAVE')) continue
        if (scope.role === 'guest' && (event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE')) eventToSend = JSON.stringify({ ...event, location_id: null })
      } else if (membership) {
        if (scheduleOnly || !await canReceive(this.env, attachment, membership, event)) {
          const seesSchedule = scheduledAuthor === '' ? await roleAllows({ ...membership, permissions: { operations: ['update'] } }) : scheduledAuthor === attachment.userId
          if (seesSchedule) eventToSend = scheduledChange
          else if (scheduleTaskChange && await canReceive(this.env, attachment, membership, event)) eventToSend = scheduleTaskChange
          else continue
        }
      }
      if (socket.readyState !== WebSocket.OPEN) continue
      eligible += 1
      try {
        if (revoke) {
          if (scope) socket.send(JSON.stringify({ type: 'CONVERSATION_LEAVE', event_id: event.event_id,
            organization_id: organizationId, conversation_id: scope.conversationId, user_id: attachment.userId, occurred_at: event.occurred_at }))
          else if (event.type === 'access.changed') socket.send(encoded)
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
