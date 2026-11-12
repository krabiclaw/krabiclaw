import type { BookingStatus } from '../../../shared/bookings.ts'

/**
 * A booking put straight into a status, as an imported or historical booking
 * already stands, for tests about what reads bookings rather than about the
 * operation that changes one (executeGuestThreadOperation owns that).
 */
export async function setBookingStatus(db: D1Database, input: { organizationId: string; bookingId: string; status: BookingStatus; reason?: string | null }): Promise<void> {
  const now = new Date().toISOString()
  const written = await db.prepare(`UPDATE bookings SET status = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, ?) END,
      cancellation_reason = CASE WHEN ? = 'cancelled' THEN ? END, version = version + 1, updated_at = ?
    WHERE organization_id = ? AND id = ?`)
    .bind(input.status, input.status, now, input.status, input.reason ?? null, now, input.organizationId, input.bookingId).run()
  if (written.meta.changes !== 1) throw new Error(`Booking ${input.bookingId} is not in ${input.organizationId}`)
}

/** The booking a conversation written before it (a checkout, an inquiry) is about, as the paid conversion names it. */
export async function nameConversationBooking(db: D1Database, conversationId: string, bookingId: string): Promise<void> {
  const written = await db.prepare("UPDATE conversations SET booking_id = ? WHERE id = ? AND kind = 'booking' AND booking_id IS NULL").bind(bookingId, conversationId).run()
  if (written.meta.changes !== 1) throw new Error(`Conversation ${conversationId} could not name booking ${bookingId}`)
}
