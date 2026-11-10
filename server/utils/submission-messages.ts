import { queryFirst, type DbClient } from '~/server/db'
import type { GuestRequestKind } from '~/server/domain/requests'

export type SubmissionType = GuestRequestKind

export interface ReplyEmailEnv {
  EMAIL_REPLY_SECRET?: string
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
  EMAIL_DELIVERY_MODE?: string
}

export interface SubmissionMatch {
  submissionType: SubmissionType
  submissionId: string
  organizationId: string
}

export async function findSubmissionByPhone(db: DbClient, phone: string, organizationId?: string): Promise<SubmissionMatch | null> {
  // Cancellation is the booking's, not the thread's: requests has no status of its own.
  return queryFirst<SubmissionMatch>(db, `SELECT r.kind AS submissionType, r.id AS submissionId, r.organization_id AS organizationId FROM requests r
    WHERE r.kind = 'booking' AND trim(json_extract(r.payload_json, '$.guest.phone')) = ?
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = r.id AND b.status = 'cancelled')
    ${organizationId ? 'AND r.organization_id = ?' : ''}
    ORDER BY r.created_at DESC LIMIT 1`, [phone, ...(organizationId ? [organizationId] : [])])
}
