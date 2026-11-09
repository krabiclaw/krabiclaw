import { isRecord } from '~/utils/api-clients'

/** A move or its undo answers with the stay and whether its guest was messaged the new address. */
export function isMovedStayResponse(value: unknown): value is { stay: { guest_notified: boolean } } {
  return isRecord(value) && isRecord(value.stay) && typeof value.stay.guest_notified === 'boolean'
}

/** Shown when the guest could not be messaged because the stay has no conversation here. */
export const GUEST_NOT_MESSAGED_WARNING = { color: 'warning', title: 'Guest not messaged', description: 'This stay has no conversation here yet. Send the new address and entry details on the booking site.' } as const
