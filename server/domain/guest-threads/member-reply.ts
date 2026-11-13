import { HTTPError } from 'nitro'
import { queryFirst } from '~/server/db'
import { findMessageByDedupeKey, resolveConversationAccess } from '~/server/domain/conversations'
import { sendConversationMessage } from '~/server/domain/send-conversation-message'
import { teamMessageKey } from '~/server/domain/team-messages'
import { resolveMembership } from '~/server/utils/member-access'
import { creationRequestHash } from '~/server/utils/organization-events'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { MessagePhoto } from './attachments'

export const REPLY_SENT = 'Reply sent.'
export const REPLY_FAILED_ALERTED = 'Reply not sent. The team has been alerted.'
export const REPLY_BY_QUOTING = 'To answer a message, reply to it.'

export function replyNotSent(reason: string): string {
  return `Reply not sent: ${reason}`
}

/** The provider tells the member the outcome and retries when a failure needs reporting. */
export interface MemberReplyOutcome {
  sent: boolean
  notice: string
  report: unknown | null
}

function refused(reason: string): MemberReplyOutcome {
  return { sent: false, notice: replyNotSent(reason), report: null }
}

/** Route an already verified email or WhatsApp reply through the same command as the inbox. */
export async function replyToAlertEntry(env: CloudflareEnv, input: { entryId: string; userId: string; body: string; files: MessagePhoto[]; idempotencyKey: string }): Promise<MemberReplyOutcome> {
  const { entryId, userId, body, files } = input
  const db = env.DB
  const alert = await queryFirst<{ conversation_id: string; organization_id: string; sender_name: string | null }>(db, `
    SELECT m.conversation_id, m.organization_id, u.name AS sender_name
    FROM messages m LEFT JOIN user u ON u.id = ?
    WHERE m.id = ?`, [userId, entryId])
  if (!alert) return refused('This conversation no longer exists.')
  const access = await resolveConversationAccess(db, userId, alert.conversation_id).catch((error: unknown) => {
    if (error instanceof HTTPError && error.status === 404) return null
    throw error
  })
  if (access?.role !== 'member' || !access.membership) {
    const membership = await resolveMembership(env, { organizationId: alert.organization_id, userId })
    return refused(membership ? 'You no longer have access to this conversation.' : 'You are no longer a member of this business.')
  }
  if (access.conversation.organization_id !== alert.organization_id || alert.sender_name === null) {
    throw new Error('The alert does not match the authorized conversation and sender')
  }
  const { conversation } = access
  const team = conversation.kind === 'team'
  // Keep identities already recorded in each conversation's delivery ledger.
  const idempotencyKey = team ? await creationRequestHash(input.idempotencyKey) : input.idempotencyKey
  try {
    await sendConversationMessage(env, {
      conversation, role: 'member', userId, senderName: alert.sender_name, body, photos: files, idempotencyKey,
      providerReply: true,
    })
    return { sent: true, notice: REPLY_SENT, report: null }
  } catch (error) {
    const code = error instanceof HTTPError ? (error.data as { code?: string } | undefined)?.code : undefined
    if (code === 'DASHBOARD_PUBLICATION_FAILED') throw error
    if (error instanceof HTTPError && error.status >= 400 && error.status < 500 && (team || code) && code !== 'MISSING_IDEMPOTENCY_KEY') {
      if (!team && code === 'EMPTY_MESSAGE') return refused('Write a message before sending it.')
      if (!team && code === 'THREAD_NOT_FOUND') return refused('This conversation no longer exists.')
      return refused(error.message)
    }
    if (team) {
      const saved = await findMessageByDedupeKey(db, teamMessageKey(conversation.id, idempotencyKey)).catch((readError: unknown) => {
        throw new AggregateError([error, readError], 'The team reply failed and whether it saved could not be read', { cause: error })
      })
      if (saved) throw error
    }
    const report = code && error instanceof HTTPError ? new Error(`Member reply ${code}: ${error.message}`, { cause: error }) : error
    return { sent: false, notice: REPLY_FAILED_ALERTED, report }
  }
}
