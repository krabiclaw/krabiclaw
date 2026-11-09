import { HTTPError } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { getGuestRequest } from '~/server/domain/requests'
import { sendTeamMessage, teamAccessFor } from '~/server/domain/team-messages'
import { assertAssignedBookingAccess, memberAccessPrincipal, resolveOrganizationMembership } from '~/server/utils/member-access'
import { creationRequestHash } from '~/server/utils/organization-events'
import { isDeliverySent } from './deliveries'
import { executeGuestThreadOperation, operationDedupeKey, type ExecuteOperationInput } from './operations'
import type { MessagePhoto } from './attachments'
import type { GuestThreadDeliveryRow } from './types'

/*
  A member answering a conversation from outside the dashboard: by replying to
  their email alert, or by quoting their WhatsApp alert. Both are the dashboard's
  own send, run as that member after the same permission check it makes; this
  file only says what the member is told about it.
*/

export const REPLY_SENT = 'Reply sent.'
/** A reply that failed for a reason the member cannot act on; the error is reported, never shown. */
export const REPLY_FAILED_ALERTED = 'Reply not sent. The team has been alerted.'
/** A reply whose delivery is unknown: it may already be with the guest. */
export const REPLY_UNCERTAIN = 'This reply may have reached the guest. Check the conversation before sending again.'
/** What an owner's WhatsApp message that quotes no alert is answered with. */
export const REPLY_BY_QUOTING = 'To answer a message, reply to it.'

export function replyNotSent(reason: string): string {
  return `Reply not sent: ${reason}`
}

/** What the member reads, whether the reply reached the guest, and an error to report when one occurred. */
export interface MemberReplyOutcome {
  sent: boolean
  notice: string
  report: unknown | null
}

type Outcome = Awaited<ReturnType<typeof executeGuestThreadOperation>>

/**
 * A refusal (4xx) is told in the operation's words, never a reason code; a reply
 * that may already be with the guest says so; any failure (5xx) is reported and
 * never shown raw.
 */
function returnedOutcome(outcome: Outcome): MemberReplyOutcome {
  if (outcome.ok) return { sent: true, notice: REPLY_SENT, report: null }
  const failure = new Error(`Member reply ${outcome.reason}${'code' in outcome ? ` ${outcome.code}` : ''}: ${'message' in outcome ? outcome.message : outcome.status}`)
  if (outcome.reason === 'delivery_failed' && (outcome.code === 'CHANNEL_REPLY_UNCERTAIN' || outcome.code === 'CHANNEL_REPLY_REVIEW_REQUIRED')) {
    return { sent: false, notice: REPLY_UNCERTAIN, report: outcome.status >= 500 ? failure : null }
  }
  if (outcome.status >= 500) return { sent: false, notice: REPLY_FAILED_ALERTED, report: failure }
  switch (outcome.reason) {
    case 'thread_not_found': case 'source_not_found': return { sent: false, notice: replyNotSent('This conversation no longer exists.'), report: null }
    case 'empty_body': return { sent: false, notice: replyNotSent('Write a message before sending it.'), report: null }
    case 'missing_idempotency_key': return { sent: false, notice: REPLY_FAILED_ALERTED, report: failure }
    default: return { sent: false, notice: replyNotSent(outcome.message), report: null }
  }
}

/**
 * The same for an error the operation threw. A reply this key already wrote or
 * handed to a provider may be with the guest whatever failed after. Otherwise
 * only a refusal the operation throws by design (a 4xx with its code) is told as
 * it is; everything else is reported, not shown.
 */
async function thrownOutcome(db: DbClient, error: unknown, threadId: string, idempotencyKey: string): Promise<MemberReplyOutcome> {
  const written = await queryAll<{ id: string; status: string | null; provider_message_id: string | null; channel: string | null; provider: string | null; purpose: string | null; email_message_id: string | null }>(db,
    `SELECT e.id, d.status, d.provider_message_id, d.channel, d.provider, d.purpose, d.email_message_id
       FROM activity_entries e LEFT JOIN guest_thread_deliveries d ON d.entry_id = e.id WHERE e.dedupe_key = ?`,
    [operationDedupeKey({ threadId, idempotencyKey })]).then(rows => ({ rows }), (lookupError: unknown) => ({ lookupError }))
  if ('lookupError' in written) return { sent: false, notice: REPLY_UNCERTAIN, report: new AggregateError([error, written.lookupError], 'The reply failed and whether it was written could not be read', { cause: error }) }
  const handedOver = written.rows.some(row => row.status === null || row.status === 'sending' || row.status === 'uncertain' || row.provider_message_id !== null
    || isDeliverySent(row as unknown as GuestThreadDeliveryRow))
  if (handedOver) return { sent: false, notice: REPLY_UNCERTAIN, report: error }
  if (error instanceof HTTPError && error.status >= 400 && error.status < 500 && typeof (error.data as { code?: unknown } | undefined)?.code === 'string') {
    return { sent: false, notice: replyNotSent(error.message), report: null }
  }
  return { sent: false, notice: REPLY_FAILED_ALERTED, report: error }
}

/**
 * Sends `body` and `files` to the guest of `threadId` as the member `userId`.
 * The member must still belong to the conversation's organization and be
 * allowed to reply to it, by the check the dashboard inbox makes. The key names
 * this one reply, so a redelivered email or WhatsApp message sends nothing twice.
 */
async function replyAsMember(env: ExecuteOperationInput['env'], input: { threadId: string; userId: string; body: string; files: MessagePhoto[]; idempotencyKey: string }): Promise<MemberReplyOutcome> {
  const db = env.DB
  const thread = await getGuestRequest(db, input.threadId)
  if (!thread) return { sent: false, notice: replyNotSent('This conversation no longer exists.'), report: null }
  const membership = await resolveOrganizationMembership(env, { organizationId: thread.organization_id, userId: input.userId })
  if (!membership) return { sent: false, notice: replyNotSent('You are no longer a member of this business.'), report: null }
  const allowed = await assertAssignedBookingAccess(db, { ...memberAccessPrincipal(membership, { env }), requestId: thread.id })
    .then(() => true, (error: unknown) => {
      if (error instanceof HTTPError && (error.status === 403 || error.status === 404)) return false
      throw error
    })
  if (!allowed) return { sent: false, notice: replyNotSent('You no longer have access to this conversation.'), report: null }

  const attempt = await executeGuestThreadOperation(db, {
    threadId: thread.id, organizationId: thread.organization_id, action: 'reply', actorUserId: input.userId,
    body: input.body, photos: input.files, env, idempotencyKey: input.idempotencyKey,
  }).then(outcome => ({ outcome }), (error: unknown) => ({ error }))
  if ('error' in attempt) return await thrownOutcome(db, attempt.error, thread.id, input.idempotencyKey)
  const told = returnedOutcome(attempt.outcome)
  if (!attempt.outcome.ok) return told
  // The reply has gone: the member is told so even when refreshing open inboxes fails, and that failure is reported.
  const refresh = await publishGuestInboxThreadEvent(env, db, { threadId: thread.id, type: 'thread.changed' }).then(() => null, (error: unknown) => error)
  return { ...told, report: refresh }
}

/** Posts to a team conversation as the member, by the operation the dashboard's own send uses. */
async function replyToTeamAsMember(env: ExecuteOperationInput['env'], input: { organizationId: string; threadId: string; userId: string; body: string; files: MessagePhoto[]; idempotencyKey: string }): Promise<MemberReplyOutcome> {
  const membership = await resolveOrganizationMembership(env, { organizationId: input.organizationId, userId: input.userId })
  if (!membership) return { sent: false, notice: replyNotSent('You are no longer a member of this business.'), report: null }
  const user = await queryFirst<{ name: string }>(env.DB, 'SELECT name FROM user WHERE id = ?', [input.userId])
  if (!user) throw new Error(`Member ${input.userId} has no user record`)
  return teamAccessFor(memberAccessPrincipal(membership, { env }), membership.memberId, 'send').then(async access => {
    await sendTeamMessage(env, env.DB, access, input.threadId, { body: input.body, photos: input.files, idempotencyKey: await creationRequestHash(input.idempotencyKey), senderName: user.name })
    return { sent: true, notice: REPLY_SENT, report: null }
  }).catch((error: unknown) => error instanceof HTTPError && error.status >= 400 && error.status < 500
    ? { sent: false, notice: replyNotSent(error.message), report: null }
    : { sent: false, notice: REPLY_FAILED_ALERTED, report: error })
}

/** Answers the conversation an alert's entry belongs to, a guest's or the team's, as the member. */
export async function replyToAlertEntry(env: ExecuteOperationInput['env'], input: { entryId: string; userId: string; body: string; files: MessagePhoto[]; idempotencyKey: string }): Promise<MemberReplyOutcome> {
  const { entryId, ...reply } = input
  const entry = await queryFirst<{ request_id: string | null; organization_id: string | null; team_thread_id: string | null }>(env.DB, `
    SELECT e.request_id, e.organization_id, t.thread_id AS team_thread_id
      FROM activity_entries e LEFT JOIN team_messages t ON t.organization_id = e.organization_id AND e.dedupe_key = 'team-message:' || t.id
     WHERE e.id = ?`, [entryId])
  if (entry?.organization_id && entry.team_thread_id) return await replyToTeamAsMember(env, { ...reply, organizationId: entry.organization_id, threadId: entry.team_thread_id })
  if (entry?.request_id) return await replyAsMember(env, { ...reply, threadId: entry.request_id })
  return { sent: false, notice: replyNotSent('This conversation no longer exists.'), report: null }
}
