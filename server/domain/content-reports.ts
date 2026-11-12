import { createHash } from 'node:crypto'
import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { createAuth, type CloudflareEnv } from '~/server/utils/auth'
import { platformOperatorEmails } from '~/server/utils/domain-notifications'
import { getPlatformDomain, type DashboardNotificationLinkEnv } from '~/server/utils/dashboard-notification-links'
import { hashEmail, sendEmail } from '~/server/utils/email-delivery'
import { renderNotificationEmail } from '~/server/emails/render'
import { contentReportedMessage } from '~/server/notifications/events'
import { getPlatformOrganization } from '~/server/utils/platform-organization'
import { teamMessageRemovalQueries } from '~/server/domain/team-messages'
import { publishConversationEvent, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'

/**
 * Members report a guest conversation or a message in a team conversation, and block a guest,
 * for App Store guideline 1.2. Every report is emailed to the KrabiClaw
 * operator addresses and waits in Platform reports, where staff remove the
 * content and ban its author's account, or dismiss it, within 24 hours.
 */

/** A guest conversation, or one message of a team conversation. */
export type ContentReportSubject = 'conversation' | 'message'
export type ContentReportEnv = Parameters<typeof sendEmail>[0] & DashboardNotificationLinkEnv & { PLATFORM_OWNER_EMAILS?: string }
export type ContentReportStatus = 'open' | 'removed' | 'dismissed'

export interface ContentReport {
  id: string
  organization_id: string
  organization_name: string
  organization_slug: string
  subject: ContentReportSubject
  conversation_id: string | null
  message_id: string | null
  reporter: { id: string; name: string; email: string } | null
  author: { id: string; name: string; email: string; banned: boolean } | null
  reason: string
  excerpt: string
  blocked: boolean
  status: ContentReportStatus
  resolved_at: string | null
  created_at: string
}

function fail(statusCode: number, code: string, message: string, field: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code, field } })
}

export function reportReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (!reason || reason.length > 1000) fail(422, 'INVALID_REPORT_REASON', 'Say what is wrong in 1 to 1000 characters', 'reason')
  return reason
}

/** One report per reporter and request key, so a retried request finds the report it filed. */
export function contentReportId(reporterUserId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`content-report:${reporterUserId}:${idempotencyKey}`).digest('hex').slice(0, 32)
}

export function contentReportInsert(report: {
  id: string
  organizationId: string
  reporterUserId: string
  subject: ContentReportSubject
  conversationId: string | null
  messageId: string | null
  authorUserId: string | null
  reason: string
  excerpt: string
  blocked: boolean
}): BatchQuery {
  return {
    query: `INSERT INTO content_reports (id, organization_id, reporter_user_id, subject, conversation_id, message_id, author_user_id, reason, excerpt, blocked, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open') ON CONFLICT (id) DO NOTHING`,
    params: [report.id, report.organizationId, report.reporterUserId, report.subject, report.conversationId, report.messageId,
      report.authorUserId, report.reason, report.excerpt, report.blocked ? 1 : 0],
  }
}

/**
 * A key names one report. A retry with the same key and request finds it; the
 * same key sent about different content, or with a different reason, is refused
 * rather than answered with the report it first filed.
 */
export async function assertSameReport(db: DbClient, id: string, expected: {
  subject: ContentReportSubject; conversationId: string | null; messageId: string | null; reason: string; blocked: boolean
}): Promise<void> {
  const filed = await queryFirst<{ subject: string; conversation_id: string | null; message_id: string | null; reason: string; blocked: number }>(db,
    'SELECT subject, conversation_id, message_id, reason, blocked FROM content_reports WHERE id = ?', [id])
  if (!filed) fail(500, 'CONTENT_REPORT_NOT_WRITTEN', 'The report was not saved', 'reportId')
  if (filed.subject !== expected.subject || filed.conversation_id !== expected.conversationId || filed.message_id !== expected.messageId
    || filed.reason !== expected.reason || (filed.blocked === 1) !== expected.blocked) {
    fail(409, 'IDEMPOTENCY_KEY_REUSED', 'This key already filed a different report. Send a new key.', 'idempotencyKey')
  }
}

/** The guest's latest words in a conversation: what a report of it is about. */
export async function guestThreadExcerpt(db: DbClient, conversationId: string): Promise<string> {
  const rows = await queryAll<{ body: string }>(db, `
    SELECT body FROM messages WHERE conversation_id = ? AND author_kind = 'guest' AND body IS NOT NULL AND trim(body) <> ''
     ORDER BY sequence DESC LIMIT 3`, [conversationId])
  return rows.map(row => row.body).reverse().join('\n\n').slice(0, 2000) || 'The guest has sent no text.'
}

const REPORT_SELECT = `
  SELECT r.*, o.name AS organization_name, o.slug AS organization_slug,
    rep.name AS reporter_name, rep.email AS reporter_email,
    au.name AS author_name, au.email AS author_email, au.banned AS author_banned
  FROM content_reports r
  JOIN organization o ON o.id = r.organization_id
  LEFT JOIN user rep ON rep.id = r.reporter_user_id
  LEFT JOIN user au ON au.id = r.author_user_id`

interface ReportRow {
  id: string; organization_id: string; organization_name: string; organization_slug: string
  subject: ContentReportSubject; conversation_id: string | null; message_id: string | null
  reporter_user_id: string | null; reporter_name: string | null; reporter_email: string | null
  author_user_id: string | null; author_name: string | null; author_email: string | null; author_banned: number | null
  reason: string; excerpt: string; blocked: number; status: ContentReportStatus; resolved_at: string | null; created_at: string
}

function toReport(row: ReportRow): ContentReport {
  return {
    id: row.id,
    organization_id: row.organization_id,
    organization_name: row.organization_name,
    organization_slug: row.organization_slug,
    subject: row.subject,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    reporter: row.reporter_user_id ? { id: row.reporter_user_id, name: row.reporter_name ?? '', email: row.reporter_email ?? '' } : null,
    author: row.author_user_id ? { id: row.author_user_id, name: row.author_name ?? '', email: row.author_email ?? '', banned: row.author_banned === 1 } : null,
    reason: row.reason,
    excerpt: row.excerpt,
    blocked: row.blocked === 1,
    status: row.status,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
  }
}

async function readReport(db: DbClient, id: string): Promise<ContentReport> {
  const row = await queryFirst<ReportRow>(db, `${REPORT_SELECT} WHERE r.id = ?`, [id])
  if (!row) fail(404, 'CONTENT_REPORT_NOT_FOUND', 'That report does not exist', 'report_id')
  return toReport(row)
}

/**
 * Tells the operators. The report is not filed until they have been told: a
 * failed send fails the request, and the retry with the same key re-sends under
 * the same Resend idempotency key without filing a second report.
 */
export async function announceContentReport(env: ContentReportEnv, db: DbClient, reportId: string): Promise<ContentReport> {
  const report = await readReport(db, reportId)
  const recipients = platformOperatorEmails(env).filter((email, index, all) => all.findIndex(other => hashEmail(other) === hashEmail(email)) === index)
  if (!recipients.length) throw new Error('PLATFORM_OWNER_EMAILS is not configured')
  const platform = await queryFirst<{ slug: string }>(db, 'SELECT slug FROM organization WHERE id = ?', [(await getPlatformOrganization(db)).id])
  if (!platform) throw new Error('The platform organization has no slug')
  const platformDomain = getPlatformDomain(env)
  const message = contentReportedMessage({
    organizationName: report.organization_name,
    reporter: report.reporter ? `${report.reporter.name} (${report.reporter.email})` : 'A deleted account',
    subject: report.subject,
    blocked: report.blocked,
    reason: report.reason,
    excerpt: report.excerpt,
    reviewUrl: `https://${platformDomain}/dashboard/${platform.slug}/platform-reports`,
  })
  const email = await renderNotificationEmail(message, { platformDomain })
  const results = await Promise.all(recipients.map(to => sendEmail(env, {
    to, subject: message.title, ...email, idempotencyKey: `content-report:${report.id}:${hashEmail(to)}`,
  })))
  const failures = results.flatMap(result => result.status === 'sent' ? [] : [result.error])
  if (failures.length) {
    throw new HTTPError({ statusCode: 502, statusMessage: `The report was saved, but KrabiClaw could not be told: ${failures.join('; ')}. Retry with the same request.`,
      data: { code: 'CONTENT_REPORT_EMAIL_FAILED', field: 'email', committed: true, report_id: report.id } })
  }
  return report
}

export async function listContentReports(db: DbClient, status: unknown): Promise<ContentReport[]> {
  if (status !== 'open' && status !== 'removed' && status !== 'dismissed') fail(400, 'INVALID_REPORT_STATUS', 'status must be one of: open, removed, dismissed', 'status')
  const rows = await queryAll<ReportRow>(db, `${REPORT_SELECT} WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`, [status])
  return rows.map(toReport)
}

/**
 * Staff decide an open report. Remove takes the content away — a team message
 * is deleted with its photos' placements, a guest conversation is blocked for
 * its business — and bans the author's KrabiClaw account through Better Auth,
 * which also ends their sessions. An Airbnb guest has no KrabiClaw account to
 * ban; blocking is what KrabiClaw controls.
 */
export async function resolveContentReport(env: CloudflareEnv & GuestInboxPublicationEnv, db: DbClient, input: {
  reportId: string
  staffUserId: string
  decision: unknown
  headers: Headers
}): Promise<ContentReport> {
  if (input.decision !== 'remove' && input.decision !== 'dismiss') fail(422, 'INVALID_REPORT_DECISION', 'decision must be remove or dismiss', 'decision')
  const report = await readReport(db, input.reportId)
  if (report.status !== 'open') fail(409, 'CONTENT_REPORT_RESOLVED', 'This report has already been decided', 'report_id')
  const now = new Date().toISOString()
  // The decision is claimed first, so a concurrent decision by other staff wins
  // or loses here, before anything is removed or anyone banned.
  const [claimed] = await executeBatch(db, [{
    query: `UPDATE content_reports SET status = ?, resolved_by_user_id = ?, resolved_at = ? WHERE id = ? AND status = 'open'`,
    params: [input.decision === 'remove' ? 'removed' : 'dismissed', input.staffUserId, now, report.id],
  }], { operation: 'Decide a content report' })
  if ((claimed?.meta?.changes ?? 0) !== 1) fail(409, 'CONTENT_REPORT_RESOLVED', 'This report has already been decided', 'report_id')
  if (input.decision === 'dismiss') return await readReport(db, report.id)

  // The conversation the removal changes: the message's, or the blocked guest's.
  const changed = report.message_id
    ? (await queryFirst<{ conversation_id: string }>(db, 'SELECT conversation_id FROM messages WHERE organization_id = ? AND id = ?', [report.organization_id, report.message_id]))?.conversation_id ?? null
    : report.conversation_id
  const removal: BatchQuery[] = report.subject === 'message'
    ? report.message_id
      ? teamMessageRemovalQueries(report.organization_id, report.message_id)
      : []
    : [{ query: 'UPDATE conversations SET blocked_at = COALESCE(blocked_at, ?) WHERE organization_id = ? AND id = ?', params: [now, report.organization_id, report.conversation_id] }]
  try {
    // Removal is idempotent and the ban is skipped once it holds, so reopening
    // the report lets staff retry the whole decision.
    if (removal.length) await executeBatch(db, removal, { operation: 'Remove reported content' })
    if (report.author && !report.author.banned) {
      await createAuth(env).api.banUser({
        body: { userId: report.author.id, banReason: `Reported content removed (report ${report.id})` },
        headers: input.headers,
      })
    }
  } catch (cause) {
    await executeBatch(db, [{
      query: `UPDATE content_reports SET status = 'open', resolved_by_user_id = NULL, resolved_at = NULL WHERE id = ? AND status = 'removed'`,
      params: [report.id],
    }], { operation: 'Reopen a content report whose removal failed' })
    throw cause
  }
  // Open inboxes drop the removed message or the blocked conversation now.
  if (changed) await publishConversationEvent(env, db, { conversationId: changed, type: 'MESSAGE_UPDATE' })
  return await readReport(db, report.id)
}
