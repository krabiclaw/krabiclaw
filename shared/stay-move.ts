import { isRecord } from '~/utils/api-clients'

/** The move returns the outbox message that will deliver the new address. */
export function isMovedStayResponse(value: unknown): value is { booking: { scheduled_message_id: string } } {
  return isRecord(value) && isRecord(value.booking) && typeof value.booking.scheduled_message_id === 'string' && value.booking.scheduled_message_id.length > 0
}

export const STAY_MOVE_MESSAGE_QUEUED = { color: 'success', title: 'Guest message queued', description: 'The guest’s new address and check-in instructions are in the scheduled messages outbox.' } as const
