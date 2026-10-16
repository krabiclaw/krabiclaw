import { REQUEST_CURRENT_BUYER_SQL } from '~/server/domain/requests'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import type { GuestThreadActorKind, GuestThreadChannel, GuestThreadEntryKind, GuestThreadEntryRow } from './types'

export class GuestThreadEntryDedupeConflictError extends Error {}
export class GuestThreadEntryOwnershipError extends Error {}

export interface AppendEntryInput {
  threadId: string
  kind: GuestThreadEntryKind
  actorKind: GuestThreadActorKind
  actorUserId?: string | null
  buyerUserId?: string
  channel?: GuestThreadChannel | null
  body?: string | null
  eventName?: string | null
  payloadJson?: Record<string, unknown> | null
  dedupeKey?: string
  occurredAt?: string
  id?: string
}

function isUniqueConstraintError(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))
}

function matchingDedupeEntry(
  entry: GuestThreadEntryRow,
  input: AppendEntryInput,
  payloadJson: string | null,
): GuestThreadEntryRow {
  const buyerWebReplay = !!input.buyerUserId && input.kind === 'message' && input.actorKind === 'guest' && input.channel === 'web'
  const matches = entry.request_id === input.threadId
    && entry.kind === input.kind
    && entry.actor_kind === input.actorKind
    && (buyerWebReplay || entry.actor_user_id === (input.actorUserId ?? null))
    && entry.channel === (input.channel ?? null)
    && entry.body === (input.body ?? null)
    && entry.event_name === (input.eventName ?? null)
    && entry.payload_json === payloadJson

  if (!matches) {
    throw new GuestThreadEntryDedupeConflictError('Guest thread entry dedupe key belongs to a different ledger fact')
  }
  return entry
}

/**
 * Appends one immutable fact to the canonical guest-thread ledger. Entries are never
 * updated in place — corrections are new entries (issue #442 Locked Decision #2).
 *
 * When `dedupeKey` is provided and already exists, returns the existing entry instead
 * of inserting a duplicate (idempotent inbound ingestion — e.g. inbound email Message-Id,
 * WhatsApp message id). Retries return the original fact so callers can safely resume
 * the remaining idempotent work.
 */
export async function appendEntry(db: DbClient, input: AppendEntryInput): Promise<GuestThreadEntryRow> {
  const ownerWhere=`EXISTS(SELECT 1 FROM requests r WHERE r.id=? AND r.user_id=? AND ${REQUEST_CURRENT_BUYER_SQL})`
  if(input.buyerUserId&&!await queryFirst(db,`SELECT 1 WHERE ${ownerWhere}`,[input.threadId,input.buyerUserId]))throw new GuestThreadEntryOwnershipError('Conversation is not owned by this buyer')
  const payloadJson = JSON.stringify(input.payloadJson ?? {})
  if (input.dedupeKey) {
    const existing = await findEntryByDedupeKey(db, input.dedupeKey)
    if (existing) return matchingDedupeEntry(existing, input, payloadJson)
  }

  const id = input.id ?? crypto.randomUUID()
  const dedupeKey = input.dedupeKey ?? `entry:${id}`
  const occurredAt = input.occurredAt ?? new Date().toISOString()
  const createdAt = new Date().toISOString()

  try {
    const result = await execute(db, `
      INSERT INTO activity_entries
        (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, body, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
      SELECT ?, ?, ?, 'request', ?, ?, ?, ?, ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?
      FROM activity_entries
      WHERE request_id = ?
      ${input.buyerUserId?`HAVING ${ownerWhere}`:''}
      ON CONFLICT DO NOTHING
    `, [
      id,
      input.threadId,
      input.kind,
      input.actorKind,
      input.actorUserId ?? null,
      input.channel ?? null,
      input.body ?? null,
      input.eventName ?? null,
      payloadJson,
      dedupeKey,
      occurredAt,
      createdAt,
      input.threadId,
      ...(input.buyerUserId?[input.threadId,input.buyerUserId]:[]),
    ])

    if (Number(result?.meta?.changes ?? 0) === 0) {
      if(input.buyerUserId&&!await queryFirst(db,`SELECT 1 WHERE ${ownerWhere}`,[input.threadId,input.buyerUserId]))throw new GuestThreadEntryOwnershipError('Conversation is not owned by this buyer')
      const duplicate = await findEntryByDedupeKey(db, dedupeKey)
      if (duplicate) return matchingDedupeEntry(duplicate, input, payloadJson)
      throw new Error('Guest thread entry conflicted with an existing ledger fact')
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const concurrent = await findEntryByDedupeKey(db, dedupeKey)
      if (concurrent) return matchingDedupeEntry(concurrent, input, payloadJson)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw error instanceof Error ? error : new Error(message)
  }

  const created = await queryFirst<GuestThreadEntryRow>(db, `SELECT * FROM activity_entries WHERE id = ? LIMIT 1`, [id])
  if (!created) throw new Error('Failed to load appended guest thread entry')
  return created
}

export async function findEntryByDedupeKey(db: DbClient, dedupeKey: string): Promise<GuestThreadEntryRow | null> {
  return await queryFirst<GuestThreadEntryRow>(db, `
    SELECT * FROM activity_entries WHERE dedupe_key = ? LIMIT 1
  `, [dedupeKey])
}

export async function getEntryById(db: DbClient, id: string): Promise<GuestThreadEntryRow | null> {
  return await queryFirst<GuestThreadEntryRow>(db, `SELECT * FROM activity_entries WHERE id = ? LIMIT 1`, [id])
}

export async function listThreadEntries(db: DbClient, threadId: string): Promise<GuestThreadEntryRow[]> {
  const rows = await queryAll<GuestThreadEntryRow>(db, `
    SELECT * FROM activity_entries
    WHERE request_id = ? AND sequence IS NOT NULL
    ORDER BY sequence ASC, occurred_at ASC, id ASC
  `, [threadId])
  return rows ?? []
}

export async function getLatestEntry(db: DbClient, threadId: string): Promise<GuestThreadEntryRow | null> {
  return await queryFirst<GuestThreadEntryRow>(db, `
    SELECT * FROM activity_entries
    WHERE request_id = ? AND sequence IS NOT NULL
    ORDER BY sequence DESC, occurred_at DESC, id DESC
    LIMIT 1
  `, [threadId])
}

export async function getLatestEntryByKind(
  db: DbClient,
  threadId: string,
  kinds: GuestThreadEntryKind[],
): Promise<GuestThreadEntryRow | null> {
  return await queryFirst<GuestThreadEntryRow>(db, `
    SELECT * FROM activity_entries
    WHERE request_id = ? AND kind IN (SELECT value FROM json_each(?))
    ORDER BY sequence DESC, occurred_at DESC, id DESC
    LIMIT 1
  `, [threadId, d1JsonStringSet(kinds)])
}

// An absent payload is a real state; a payload_json that will not parse is a
// corrupt row, and answering null for both read the guest's message as empty.
export function parseEntryPayload(entry: GuestThreadEntryRow): Record<string, unknown> | null {
  if (!entry.payload_json) return null
  return JSON.parse(entry.payload_json) as Record<string, unknown>
}

export const BUYER_OPERATION_EVENTS = [
 'booking.confirm','booking.reject','booking.cancel','reservation.confirm','reservation.reject','reservation.cancel',
 'booking_change.requested','booking_change.accepted','booking_change.declined',
 'payment.payment_captured','payment.payment_failed','payment.refund_pending','payment.refund_succeeded','payment.refund_failed','payment.refund_canceled',
] as const
/** Guest-visible facts; staff diagnostics and financial disputes have no buyer audience. */
export function isBuyerVisibleThreadEntry(entry:GuestThreadEntryRow):boolean {
 return entry.kind==='submission'
  || (entry.kind==='message'&&((entry.actor_kind==='guest'&&['web','email','whatsapp'].includes(entry.channel??''))||(entry.actor_kind==='member'&&entry.event_name==='thread.member_reply')||(entry.actor_kind==='system'&&entry.event_name==='thread.scheduled_message')))
  || (entry.kind==='operation'&&(BUYER_OPERATION_EVENTS as readonly string[]).includes(entry.event_name??''))
}
/** The same public activity vocabulary, with per-user canonical acknowledgement rows. */
export const BUYER_UNREAD_THREAD_SQL = `EXISTS (
 SELECT 1 FROM activity_entries e WHERE e.request_id=gt.id
  AND (e.actor_user_id IS NULL OR e.actor_user_id<>?)
  AND ((e.kind='message' AND ((e.actor_kind='member' AND e.event_name='thread.member_reply') OR (e.actor_kind='system' AND e.event_name='thread.scheduled_message')))
    OR (e.kind='operation' AND e.event_name IN (SELECT value FROM json_each(?))))
  AND NOT EXISTS(SELECT 1 FROM activity_entries a WHERE a.kind='acknowledgement' AND a.parent_id=e.id AND a.actor_user_id=?)
)`

export function buyerUnreadThreadParams(userId:string):[string,string,string] {
 return [userId,d1JsonStringSet(BUYER_OPERATION_EVENTS),userId]
}
