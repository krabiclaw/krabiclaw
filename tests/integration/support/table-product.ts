import { createProduct } from '../../../server/utils/product-management.ts'
import type { CloudflareEnv } from '../../../server/utils/auth.ts'
import type { Product } from '../../../server/types/products.ts'
import type { PaymentBasis } from '../../../server/utils/availability.ts'

/**
 * A location's tables, set up the way the dashboard and MCP set them up: one
 * `table` product at the location, published, through the one product writer
 * and its booking setup. A table is seated through its location's opening
 * hours, so the premise is written first: the location opens at `open` on
 * each weekday named and closes when a table seated at `lastSeating` is done.
 * The seatings a test asserts afterwards are what the writer made of those
 * hours: one every `intervalMinutes` from `open` through `lastSeating`.
 */
export async function createTables(db: D1Database, env: CloudflareEnv, input: {
  organizationId: string
  locationId: string
  actorId: string
  /** The member who handles this location's table bookings. */
  memberId: string
  name: string
  durationMinutes: number
  /** Seats per seating; null is unlimited. */
  seats: number | null
  weekdays?: number[]
  open: string
  lastSeating: string
  intervalMinutes?: number
  currency?: string
  /** The deposit charged once per booking, in minor units; omitted is a free table. */
  deposit?: { amount: number; minPartySize: number | null; taxBehavior?: 'inclusive' | 'exclusive' }
  advanceNoticeMinutes?: number | null
  partySizeMax?: number | null
  minimumGuestAge?: number | null
  idempotencyKey?: string
}): Promise<Product> {
  const interval = input.intervalMinutes ?? 30
  const weekdays = input.weekdays ?? [0, 1, 2, 3, 4, 5, 6]
  const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
  const point = (weekday: number, at: number) => ({ day: (weekday + Math.floor(at / 1440)) % 7, hour: Math.floor(at % 1440 / 60), minute: at % 60 })
  const periods = weekdays.map(weekday => ({ open: point(weekday, minute(input.open)), close: point(weekday, minute(input.lastSeating) + input.durationMinutes) }))
  await db.prepare('UPDATE business_locations SET opening_hours = ? WHERE organization_id = ? AND id = ?').bind(JSON.stringify({ periods }), input.organizationId, input.locationId).run()
  return createProduct(db, {
    env, organizationId: input.organizationId, actor: { actorId: input.actorId }, publication: { published: true },
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    product: {
      kind: 'table', name: input.name,
      variants: [{ name: 'Table', prices: [{ unit_amount: input.deposit?.amount ?? 0, currency: input.currency ?? 'USD', type: 'one_time', ...(input.deposit?.taxBehavior ? { tax_behavior: input.deposit.taxBehavior } : {}) }] }],
    },
    booking: { env, data: {
      location_id: input.locationId, duration_minutes: input.durationMinutes, seating_interval_minutes: interval, default_capacity: input.seats,
      confirmation_mode: 'instant', scheduling_mode: 'business', assigned_member_id: input.memberId,
      ...(input.deposit ? { online_payment_required: true, payment_basis: 'per_booking' as PaymentBasis, payment_min_party_size: input.deposit.minPartySize } : {}),
      ...(input.advanceNoticeMinutes !== undefined ? { advance_notice_minutes: input.advanceNoticeMinutes } : {}),
      ...(input.partySizeMax !== undefined ? { party_size_max: input.partySizeMax } : {}),
      ...(input.minimumGuestAge !== undefined ? { minimum_guest_age: input.minimumGuestAge } : {}),
    } },
  })
}
