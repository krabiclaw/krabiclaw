import { HTTPError } from 'nitro'
import { queryFirst } from '~/server/db'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { getGuestRequest } from '~/server/domain/requests'
import { sendTeamMessage, teamAccessFor } from '~/server/domain/team-messages'
import { memberAccessPrincipal, resolveOrganizationMembership } from '~/server/utils/member-access'
import { assertConversationAccess, getMessage } from '~/server/domain/conversations'
import { creationRequestHash } from '~/server/utils/organization-events'
import { executeGuestThreadOperation, type ExecuteOperationInput } from './operations'
import type { MessagePhoto } from './attachments'

/*
  A member answering a conversation from outside the dashboard: by replying to
  their email alert, or by quoting their WhatsApp alert. Both are the dashboard's
  own send, run as that member after the same permission check it makes; this
  file only says what the member is told about it.
*/

export const REPLY_SENT = 'Reply sent.'
/** A reply that failed for a reason the member cannot act on; the error is reported, never shown. */
export const REPLY_FAILED_ALERTED = 'Reply not sent. The team has been alerted.'
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
 * A refusal (4xx) is told in the operation's words, never a reason code; any
 * failure (5xx) is reported and never shown raw.
 */
function returnedOutcome(outcome: Outcome): MemberReplyOutcome {
  if (outcome.ok) return { sent: true, notice: REPLY_SENT, report: null }
  const failure = new Error(`Member reply ${outcome.reason}${'code' in outcome ? ` ${outcome.code}` : ''}: ${'message' in outcome ? outcome.message : outcome.status}`)
  if (outcome.status >= 500) return { sent: false, notice: REPLY_FAILED_ALERTED, report: failure }
  switch (outcome.reason) {
    case 'thread_not_found': case 'source_not_found': return { sent: false, notice: replyNotSent('This conversation no longer exists.'), report: null }
    case 'empty_body': return { sent: false, notice: replyNotSent('Write a message before sending it.'), report: null }
    case 'missing_idempotency_key': return { sent: false, notice: REPLY_FAILED_ALERTED, report: failure }
    default: return { sent: false, notice: replyNotSent(outcome.message), report: null }
  }
}

/**
 * The same for an error the operation threw: it did not send. A refusal the
 * operation throws by design (a 4xx with its code) is told as it is; anything
 * else is reported with its cause and told as not sent.
 */
function thrownOutcome(error: unknown): MemberReplyOutcome {
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
  const allowed = await assertConversationAccess(db, memberAccessPrincipal(membership, { env }), thread.id)
    .then(() => true, (error: unknown) => {
      if (error instanceof HTTPError && (error.status === 403 || error.status === 404)) return false
      throw error
    })
  if (!allowed) return { sent: false, notice: replyNotSent('You no longer have access to this conversation.'), report: null }

  const attempt = await executeGuestThreadOperation(db, {
    threadId: thread.id, organizationId: thread.organization_id, action: 'reply', actorUserId: input.userId,
    body: input.body, photos: input.files, env, idempotencyKey: input.idempotencyKey,
  }).then(outcome => ({ outcome }), (error: unknown) => ({ error }))
  if ('error' in attempt) return thrownOutcome(attempt.error)
  const told = returnedOutcome(attempt.outcome)
  if (!attempt.outcome.ok) return told
  // A reply is not sent until open inboxes show it. A failed refresh fails the email or WhatsApp
  // delivery; its redelivery replays this key, which sends nothing twice and refreshes again.
  await publishConversationEvent(env, db, { conversationId: thread.id, type: 'MESSAGE_CREATE' })
  return told
}

/** Posts to a team conversation as the member, by the operation the dashboard's own send uses. */
async function replyToTeamAsMember(env: ExecuteOperationInput['env'], input: { organizationId: string; threadId: string; userId: string; body: string; files: MessagePhoto[]; idempotencyKey: string }): Promise<MemberReplyOutcome> {
  const membership = await resolveOrganizationMembership(env, { organizationId: input.organizationId, userId: input.userId })
  if (!membership) return { sent: false, notice: replyNotSent('You are no longer a member of this business.'), report: null }
  const user = await queryFirst<{ name: string }>(env.DB, 'SELECT name FROM user WHERE id = ?', [input.userId])
  if (!user) throw new Error(`Member ${input.userId} has no user record`)
  const idempotencyKey = await creationRequestHash(input.idempotencyKey)
  return teamAccessFor(memberAccessPrincipal(membership, { env }), membership.memberId, 'send').then(async access => {
    await sendTeamMessage(env, env.DB, access, input.threadId, { body: input.body, photos: input.files, idempotencyKey, senderName: user.name })
    return { sent: true, notice: REPLY_SENT, report: null }
  }).catch(async (error: unknown) => {
    if (error instanceof HTTPError && error.status >= 400 && error.status < 500) return { sent: false, notice: replyNotSent(error.message), report: null }
    const saved = await queryFirst(env.DB, 'SELECT 1 FROM messages WHERE organization_id = ? AND conversation_id = ? AND dedupe_key = ?', [input.organizationId, input.threadId, `team:${input.threadId}:${idempotencyKey}`])
      .catch((readError: unknown) => { throw new AggregateError([error, readError], 'The team reply failed and whether it saved could not be read', { cause: error }) })
    // A message that saved is not sent until its teammates are told and open apps refresh. The
    // failure fails the email or WhatsApp delivery, and its redelivery replays this key, which
    // finishes that work without writing the message again.
    if (saved) throw error
    return { sent: false, notice: REPLY_FAILED_ALERTED, report: error }
  })
}

/** Answers the conversation the alerted message belongs to, a guest's or the team's, as the member. */
export async function replyToAlertEntry(env: ExecuteOperationInput['env'], input: { entryId: string; userId: string; body: string; files: MessagePhoto[]; idempotencyKey: string }): Promise<MemberReplyOutcome> {
  const { entryId, ...reply } = input
  const message = await getMessage(env.DB, entryId)
  if (!message) return { sent: false, notice: replyNotSent('This conversation no longer exists.'), report: null }
  const conversation = await queryFirst<{ kind: string }>(env.DB, 'SELECT kind FROM conversations WHERE id = ?', [message.conversation_id])
  if (conversation?.kind === 'team') return await replyToTeamAsMember(env, { ...reply, organizationId: message.organization_id, threadId: message.conversation_id })
  return await replyAsMember(env, { ...reply, threadId: message.conversation_id })
}
