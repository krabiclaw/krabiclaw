import type { SessionAvailability } from '~/server/utils/availability'
import { PRODUCT_SESSION_STATUSES } from '~/shared/bookings'
import { isRecord } from '~/utils/api-clients'

export function isSessionAvailability(value: unknown): value is SessionAvailability {
  return isRecord(value)
    && ['id', 'organization_id', 'product_id', 'timezone', 'starts_at', 'ends_at', 'created_at', 'updated_at'].every(field => typeof value[field] === 'string')
    && ['location_id', 'availability_rule_id', 'source_occurrence_key', 'assigned_member_id'].every(field => value[field] === null || typeof value[field] === 'string')
    && typeof value.status === 'string' && (PRODUCT_SESSION_STATUSES as readonly string[]).includes(value.status)
    && (value.capacity === null || Number.isSafeInteger(value.capacity))
    && (value.remaining === null || Number.isSafeInteger(value.remaining))
    && Number.isSafeInteger(value.claimed) && typeof value.is_full === 'boolean'
}

export function isSessionResponse(value: unknown): value is { success: true; session: SessionAvailability } {
  return isRecord(value) && value.success === true && isSessionAvailability(value.session)
}

export function isSessionsResponse(value: unknown): value is { success: true; sessions: SessionAvailability[] } {
  return isRecord(value) && value.success === true && Array.isArray(value.sessions) && value.sessions.every(isSessionAvailability)
}
