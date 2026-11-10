import { queryFirst, type DbClient } from '~/server/db'
import { BOOKED_RECORDS_SQL } from '~/server/domain/requests'
import type { GuestThreadSubmissionType } from '~/server/domain/guest-threads/types'

export type SubmissionType = GuestThreadSubmissionType

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
  // Cancellation is the booking's, reservation's or stay's, not the thread's:
  // requests has no status of its own.
  return queryFirst<SubmissionMatch>(db, `SELECT r.kind AS submissionType, r.id AS submissionId, r.organization_id AS organizationId FROM requests r
    WHERE r.kind IN ('reservation', 'booking', 'stay')
      AND CASE WHEN r.kind = 'stay' THEN
        EXISTS (SELECT 1 FROM stays current_stay WHERE current_stay.request_id = r.id AND current_stay.organization_id = r.organization_id AND trim(current_stay.guest_phone) = ?)
        ELSE json_extract(r.payload_json, '$.guest.phone') = ? END
      AND NOT EXISTS (SELECT 1 FROM ${BOOKED_RECORDS_SQL} br WHERE br.request_id = r.id AND br.organization_id = r.organization_id AND br.status = 'cancelled')
    ${organizationId ? 'AND r.organization_id = ?' : ''}
    ORDER BY r.created_at DESC LIMIT 1`, [phone, phone, ...(organizationId ? [organizationId] : [])])
}
