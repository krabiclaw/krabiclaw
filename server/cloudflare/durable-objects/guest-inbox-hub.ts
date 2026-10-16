import { DurableObject } from 'cloudflare:workers'
import { HTTPError } from 'nitro'
import { isDashboardInvalidation, type DashboardInvalidation } from '../../../shared/dashboard-invalidations'
import { queryFirst } from '~/server/db'
import { assertAssignedBookingAccess, assignedHomeSql, memberAccessPrincipal, resolveOrganizationMembership, roleAllows, type ResolvedMembership } from '~/server/utils/member-access'
import { createAuth, type CloudflareEnv } from '~/server/utils/auth'

type GuestInboxHubEnv = CloudflareEnv

interface InboxSocketAttachment {
  organizationId: string
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
    && typeof value.organizationId === 'string'
    && typeof value.userId === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.sessionToken === 'string' && Boolean(value.sessionToken)
}

function failure(status: number, code: string, message: string, field: string): Response {
  return Response.json({ error: message, code, field }, { status })
}

async function socketMembership(env: GuestInboxHubEnv, attachment: InboxSocketAttachment) {
  const headers = new Headers({ authorization: `Bearer ${attachment.sessionToken}` })
  // The open socket must not extend a revoked or expired session through the
  // browser's cookie cache. Better Auth remains the session authority.
  const session = await createAuth(env).api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (!session || session.user.id !== attachment.userId || session.session.id !== attachment.sessionId) return null
  const membership = await resolveOrganizationMembership(env, { organizationId: attachment.organizationId, userId: session.user.id })
  if (!membership || (!await roleAllows({ ...membership, permissions: { operations: ['read'] } })
    && !await roleAllows({ ...membership, permissions: { operations: ['assigned'] } }))) return null
  return membership
}

async function canReceive(env: GuestInboxHubEnv, attachment: InboxSocketAttachment, membership: ResolvedMembership, event: DashboardInvalidation): Promise<boolean> {
  if (attachment.organizationId !== event.organizationId) return false
  if ('targetUserId' in event && event.targetUserId && event.targetUserId !== attachment.userId) return false
  if (await roleAllows({ ...membership, permissions: { operations: ['read'] } })) return true
  if ('targetUserId' in event) return event.targetUserId === attachment.userId
  if ('productId' in event) {
    return Boolean(await queryFirst(env.DB, `SELECT c.product_id FROM product_stay_configs c
      WHERE c.organization_id = ? AND c.product_id = ? AND (${assignedHomeSql('c')})`,
    [attachment.organizationId, event.productId, attachment.userId, attachment.userId]))
  }
  try {
    // The same resource guard used by the canonical inbox handles assigned
    // appointments, stays and channel inquiries. The hub has no second scope.
    await assertAssignedBookingAccess(env.DB, { ...memberAccessPrincipal(membership, { env }), requestId: event.threadId })
    return true
  } catch (error) {
    if (error instanceof HTTPError && error.status === 404) return false
    throw error
  }
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
    const membership = await resolveOrganizationMembership(this.env, { organizationId, userId: session.user.id })
    if (!membership || (!await roleAllows({ ...membership, permissions: { operations: ['read'] } })
      && !await roleAllows({ ...membership, permissions: { operations: ['assigned'] } }))) {
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
    } satisfies InboxSocketAttachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping' || (typeof message === 'string' && message === 'ping')) {
      socket.send('pong')
    }
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason)
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
    if (!organizationId || !isDashboardInvalidation(event) || event.organizationId !== organizationId) {
      return failure(400, 'INVALID_DASHBOARD_INVALIDATION', 'Invalid dashboard invalidation', 'body')
    }

    // Every eligible dashboard must receive the event. A socket whose send
    // throws is closed so its client reconnects and reconciles, and the
    // publication fails with its code so the committed write's caller sees it
    // and the idempotent retry repairs it.
    const encoded = JSON.stringify(event)
    let eligible = 0
    const failures: string[] = []
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment()
      if (!isSocketAttachment(attachment)) {
        socket.close(1008, 'Authentication required')
        continue
      }
      const membership = await socketMembership(this.env, attachment)
      if (!membership) {
        socket.close(1008, 'Session or organization access ended')
        continue
      }
      if (!await canReceive(this.env, attachment, membership, event)) continue
      eligible += 1
      try {
        socket.send(encoded)
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
