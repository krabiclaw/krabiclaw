import { queryFirst, type BatchQuery, type DbClient } from '~/server/db'

export type OrganizationEventType =
  | 'post.created' | 'post.published' | 'post.deleted' | 'post.channel_deleted' | 'article.created'
  | 'product.created' | 'product.updated' | 'product.deleted' | 'product.reordered'
  | 'product.category_created' | 'product.category_renamed' | 'product.category_deleted'
  | 'content.updated' | 'content.published' | 'media.uploaded' | 'media.deleted'
  | 'review.received' | 'review.replied'
  | 'location.created' | 'location.updated'
  | 'experience.created'
  | 'stay.created' | 'stay.updated' | 'stay.cancelled' | 'stay.payment_recorded' | 'stay.payment_deleted' | 'stay.nights_changed' | 'stay.nights_imported' | 'stay.homes_assigned'
  | 'team.message_sent'
  | 'message_template.created' | 'message_template.updated' | 'message_template.deleted' | 'scheduled_message.cancelled' | 'stay.instructions_updated'
  | 'domain.connected' | 'domain.verified' | 'domain.failed'
  | 'canonical_domain_changed' | 'cloudflare_create_failed' | 'cloudflare_delete_failed'
  | 'domain_added' | 'domain_deleted' | 'domain_state_changed'
  | 'member.invited' | 'member.role_changed' | 'member.removed' | 'member.access_scope_revoked'

export interface OrganizationEvent {
  organizationId: string
  locationId?: string | null
  actorId?: string | null
  eventType: OrganizationEventType
  entityType?: string
  entityId?: string
  metadata?: unknown
  actorType?: 'owner' | 'admin' | 'system' | 'cloudflare'
  message?: string
  beforeState?: unknown
  afterState?: unknown
  /**
   * Record the event only when the statement just before it in the batch
   * changed exactly one row. A compare-and-set write that lost its guard
   * changed nothing, and an audit row for it would describe a change that
   * never happened. A guarded event that is skipped changes no rows itself,
   * so a second guarded event after it is skipped too.
   */
  onlyIfPreviousChangedOneRow?: boolean
  /**
   * The row's unique key, when the event is also the record that a request
   * already happened: a creation with an idempotency key writes
   * `creationDedupeKey(...)` here, so a repeat of the same request finds it and
   * a concurrent duplicate fails on the unique index inside the same batch.
   */
  dedupeKey?: string
}

/**
 * The audit row for a write, as a statement for that write's own batch.
 *
 * It is a statement rather than a function that runs it so that it commits
 * with the change it describes: neither exists without the other. Written
 * separately, an audit that failed after the change committed left a change
 * with no record and an error for a caller whose write had in fact landed.
 */
export function organizationEventQuery(event: OrganizationEvent): BatchQuery {
  const { organizationId, locationId, actorId, eventType, entityType, entityId, metadata, actorType, message, beforeState, afterState } = event
  const id = crypto.randomUUID()
  const actorKind = actorType === 'cloudflare' ? 'cloudflare' : actorId ? 'member' : 'system'
  const now = new Date().toISOString()
  return {
    query: `
      INSERT INTO activity_entries
        (id, kind, scope_kind, organization_id, location_id, actor_kind, actor_user_id,
         event_name, body, payload_json, occurred_at, created_at, dedupe_key)
      SELECT ?, 'audit', 'organization', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      ${event.onlyIfPreviousChangedOneRow ? 'WHERE changes() = 1' : ''}
    `,
    params: [id, organizationId, locationId ?? null,
      actorKind, actorId ?? null, eventType, message ?? null,
      JSON.stringify({ entityType: entityType ?? null, entityId: entityId ?? null, actorType: actorType ?? actorKind,
        beforeState: beforeState ?? null, afterState: afterState ?? null, metadata: metadata ?? null }),
      now, now, event.dedupeKey ?? 'audit:' + id],
  }
}

/** The scoped key a creation's audit row carries for its caller's idempotency key. */
export function creationDedupeKey(kind: 'social_post' | 'article' | 'product' | 'location', organizationId: string, idempotencyKey: string): string {
  return `create:${kind}:${organizationId}:${idempotencyKey}`
}

/** True when a batch failed because its creation record's key was already taken: the same request committed concurrently. */
export function isUniqueDedupeConflict(error: unknown): boolean {
  return /UNIQUE constraint failed: activity_entries\.dedupe_key/.test(error instanceof Error ? error.message : String(error))
}

/** A canonical hash of what a creation request asked for, to tell a retry from a different request under one key. */
export async function creationRequestHash(request: unknown): Promise<string> {
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
      : value
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(request))))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * What an earlier creation under this key recorded: its request hash and the
 * entity it made. Null when the key is new.
 */
export async function readCreationRecord(db: DbClient, dedupeKey: string): Promise<{ requestHash: string; entityId: string; metadata: Record<string, unknown> } | null> {
  const row = await queryFirst<{ payload_json: string }>(db, 'SELECT payload_json FROM activity_entries WHERE dedupe_key = ? LIMIT 1', [dedupeKey])
  if (!row) return null
  const payload = JSON.parse(row.payload_json) as { entityId?: unknown; metadata?: Record<string, unknown> }
  if (typeof payload.entityId !== 'string' || typeof payload.metadata?.request_hash !== 'string') {
    throw new Error(`Creation record ${dedupeKey} does not name its entity and request`)
  }
  return { requestHash: payload.metadata.request_hash, entityId: payload.entityId, metadata: payload.metadata }
}
