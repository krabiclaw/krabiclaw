import { execute, type DbClient } from '~/server/db'
import { publishNotificationInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'

export const NOTIFICATION_EVENT_TYPES = {
  PLATFORM_USER_SIGNUP: 'platform.user_signup',
} as const

export type NotificationScope = 'global' | 'organization'
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'

export interface CreateNotificationInput {
  publishEnv?: GuestInboxPublicationEnv
  scope: NotificationScope
  template: string
  severity?: NotificationSeverity
  organizationId?: string | null
  locationId?: string | null
  sourceEntryId?: string | null
  targetUserId?: string | null
  title: string
  message?: string | null
  /** The guest thread this is about; the dashboard composes its own link to it at read time. */
  threadId?: string | null
  /** A dashboard path or external URL for notifications that are not about a thread. */
  deepLink?: string | null
  /** Stable event identity. Replays reuse the notification instead of adding a second alert. */
  idempotencyKey?: string
}

export interface CanonicalNotificationInsert {
  id: string
  query: string
  params: unknown[]
}

const SENSITIVE_KEY = /(?:authorization|cookie|secret|token|password|webhook|access[_-]?key|api[_-]?key|email|phone|address|message|name)/i

export function redactNotificationPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNotificationPayload)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[redacted]' : redactNotificationPayload(entry),
  ]))
}

export function buildCanonicalNotificationInsert(
  input: CreateNotificationInput,
  id: string = crypto.randomUUID(),
  now = new Date().toISOString(),
): CanonicalNotificationInsert {
  if (input.scope === 'global' && input.organizationId) {
    throw new Error('Platform notifications cannot be organization scoped')
  }
  if (input.scope !== 'global' && !input.organizationId) {
    throw new Error(`${input.scope} notifications require an organization`)
  }
  return {
    id,
    query: `
      INSERT INTO activity_entries
        (id, kind, scope_kind, organization_id, location_id, parent_id, actor_kind, target_user_id, body, event_name, payload_json, dedupe_key, occurred_at, created_at)
      VALUES (?, 'notification', ?, ?, ?, ?, 'system', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `,
    params: [id, input.scope, input.organizationId ?? null,
      input.locationId ?? null, input.sourceEntryId ?? null, input.targetUserId ?? null, input.message ?? null, input.template,
      JSON.stringify({ severity: input.severity ?? 'info', title: input.title, thread_id: input.threadId ?? null, deep_link: input.deepLink ?? null }),
      `notification:${input.idempotencyKey ?? id}`, now, now],
  }
}

export async function createCanonicalNotification(db: DbClient, input: CreateNotificationInput): Promise<string> {
  const statement = buildCanonicalNotificationInsert(input, input.idempotencyKey)
  // The id is the event's identity: a replay inserts nothing and returns the same alert.
  await execute(db, statement.query, statement.params)
  // Publication can fail after the insert commits. A replay must publish the
  // invalidation again; duplicate invalidations only ask readers to refresh.
  if (input.publishEnv && input.organizationId) {
    await publishNotificationInvalidation(input.publishEnv, {
      type: 'notification.created',
      organizationId: input.organizationId,
      locationId: input.locationId ?? null,
      targetUserId: input.targetUserId ?? null,
    })
  }
  return statement.id
}

export async function notifyNewUserSignup(db: DbClient): Promise<void> {
  await createCanonicalNotification(db, {
    scope: 'global',
    template: NOTIFICATION_EVENT_TYPES.PLATFORM_USER_SIGNUP,
    severity: 'info',
    title: 'New user signup',
    message: 'A new KrabiClaw account was created.',
    deepLink: '/dashboard',
  })
}
