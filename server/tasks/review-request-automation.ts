import type { D1Database } from '@cloudflare/workers-types'
import { queryAllPages } from '~/server/db'
import { getReviewBookingContext, reviewInvitationDue, REVIEW_REQUEST_DELAY_HOURS, REVIEW_REQUEST_TTL_DAYS, type ReviewBookingType } from '~/server/utils/review-requests'
import { sendReviewRequestForBooking } from '~/server/utils/review-request-delivery'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { filterEntitledRows } from '~/server/utils/billing-access'
import type { CloudflareEnv } from '~/server/utils/auth'
import { wantsCategoryEmailSql } from '~/server/domain/notification-preferences'

interface ReviewRequestTaskContext {
  cloudflare?: { env?: ApiRecord }
}


interface SendDueRow {
  id: string
  organization_id: string
  booking_type: ReviewBookingType
}

interface TaskResult {
  sent: number
  failed: number
  skipped?: string
}

async function sendDue(db: D1Database, env: ApiRecord): Promise<{ sent: number; failures: string[] }> {
  const wantsReviewRequests = wantsCategoryEmailSql('r.user_id', 'review_requests')
  // A day after the visit ended and within the request window, read off the
  // record that holds it. A stay ends at its checkout in its home's zone, which
  // SQL cannot place; its earliest possible instant (midnight at UTC+14)
  // admits it here, and reviewInvitationDue decides on the exact one.
  const candidates = await queryAllPages<SendDueRow>(db, `
      SELECT r.id, r.organization_id, r.kind AS booking_type
        FROM requests r
        JOIN (
          SELECT b.request_id, b.status, b.no_show_at, ps.ends_at FROM bookings b JOIN product_sessions ps ON ps.id = b.product_session_id
          UNION ALL
          SELECT request_id, status, no_show_at, ends_at FROM reservations
          UNION ALL
          SELECT request_id, status, no_show_at, datetime(check_out_date, '-14 hours') FROM stays WHERE channel = 'direct'
        ) record ON record.request_id = r.id
       WHERE r.kind IN ('reservation', 'booking', 'stay') AND record.status = 'confirmed' AND record.no_show_at IS NULL
         AND datetime(record.ends_at) <= datetime('now', '-${REVIEW_REQUEST_DELAY_HOURS} hours')
         AND datetime(record.ends_at) > datetime('now', '-${REVIEW_REQUEST_TTL_DAYS + 2} days')
         AND r.review_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM review_requests rr WHERE rr.booking_type = r.kind AND rr.booking_id = r.id AND rr.first_sent_at IS NOT NULL)
         AND r.user_id IS NOT NULL
         AND ${wantsReviewRequests.sql}
       ORDER BY booking_type, r.id
    `, wantsReviewRequests.params)
  const rows = await filterEntitledRows(env as CloudflareEnv, candidates, 'review_requests')

  let sent = 0
  const failures: string[] = []
  for (const row of rows) {
    const context = await getReviewBookingContext(db, row.booking_type, row.id)
    if (!context || !reviewInvitationDue(context) || !context.guest_email) continue
    const result = await sendReviewRequestForBooking(env as CloudflareEnv, db, row.booking_type, row.id).catch((error) => ({
      sent: false,
      requestId: '',
      error: error instanceof Error ? error.message : String(error),
    }))
    if (result.sent) sent += 1
    else failures.push(`${row.booking_type}/${row.id}: ${result.error ?? 'not sent'}`)
  }
  return { sent, failures }
}

export default defineScheduledTask({
  meta: {
    name: 'review-request-automation',
    description: 'Invites guests to review their ended visits',
  },
  async run({ context }): Promise<{ result: TaskResult }> {
    const taskContext = context as ReviewRequestTaskContext | undefined
    const env = taskContext?.cloudflare?.env ?? {}
    const db = env.DB as D1Database | undefined

    if (!db && import.meta.dev) {
      return { result: { sent: 0, failed: 0, skipped: 'DB unavailable in local scheduled task context' } }
    }
    if (!db) throw new Error('DB is required')

    const { sent, failures } = await sendDue(db, env)

    if (failures.length) throw new Error(`${failures.length} review requests were not sent: ${failures.join('; ')}`)
    return { result: { sent, failed: 0 } }
  },
})
