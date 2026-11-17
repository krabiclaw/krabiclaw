import { HTTPError } from 'nitro'
import { queryFirst, type DbClient } from '~/server/db'
import { isLodgingConfirmationMode, type LodgingBookingPolicy } from '~/shared/lodging-booking'

export const LODGING_BOOKING_POLICY_COLUMNS = `json_type(settings_json, '$.lodging_booking') AS policy_type,
           json_extract(settings_json, '$.lodging_booking.confirmation_mode') AS confirmation_mode`

export async function readLodgingBookingPolicy(db: DbClient, organizationId: string): Promise<LodgingBookingPolicy> {
  const row = await queryFirst<{ policy_type: string | null; confirmation_mode: unknown }>(db, `
    SELECT ${LODGING_BOOKING_POLICY_COLUMNS}
    FROM organization WHERE id = ?
  `, [organizationId])
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  return lodgingBookingPolicy(organizationId, row)
}

export function lodgingBookingPolicy(organizationId: string, row: { policy_type: string | null; confirmation_mode: unknown }): LodgingBookingPolicy {
  // Businesses created before the selector have always used Instant Book.
  if (row.policy_type === null) return { confirmation_mode: 'instant', online_payment_required: true }
  if (row.policy_type !== 'object' || !isLodgingConfirmationMode(row.confirmation_mode)) {
    throw new Error(`Invalid lodging booking settings for organization ${organizationId}`)
  }
  return { confirmation_mode: row.confirmation_mode, online_payment_required: true }
}
