import { createProduct } from '../../../server/utils/product-management.ts'
import type { CloudflareEnv } from '../../../server/utils/auth.ts'
import type { Product } from '../../../server/types/products.ts'
import type { PaymentBasis } from '../../../server/utils/availability.ts'

/**
 * A location's tables, set up the way the dashboard and MCP set them up: one
 * `table` product at the location, published, with a seating every
 * `intervalMinutes` from `open` through `lastSeating` on each weekday named,
 * through the one product writer and its booking setup. Nothing is inserted
 * around it; what a test asserts afterwards is what that writer made.
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
  return createProduct(db, {
    env, organizationId: input.organizationId, actor: { actorId: input.actorId }, publication: { published: true },
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    product: {
      kind: 'table', name: input.name,
      variants: [{ name: 'Table', prices: [{ unit_amount: input.deposit?.amount ?? 0, currency: input.currency ?? 'USD', type: 'one_time', ...(input.deposit?.taxBehavior ? { tax_behavior: input.deposit.taxBehavior } : {}) }] }],
    },
    booking: { env, data: {
      location_id: input.locationId, duration_minutes: input.durationMinutes, default_capacity: input.seats,
      confirmation_mode: 'instant', scheduling_mode: 'business', assigned_member_id: input.memberId,
      ...(input.deposit ? { online_payment_required: true, payment_basis: 'per_booking' as PaymentBasis, payment_min_party_size: input.deposit.minPartySize } : {}),
      ...(input.advanceNoticeMinutes !== undefined ? { advance_notice_minutes: input.advanceNoticeMinutes } : {}),
      ...(input.partySizeMax !== undefined ? { party_size_max: input.partySizeMax } : {}),
      ...(input.minimumGuestAge !== undefined ? { minimum_guest_age: input.minimumGuestAge } : {}),
      weekly_slots: weekdays.map(weekday => input.open === input.lastSeating
        ? { weekday, start_time: input.open }
        : { weekday, start_time: input.open, end_time: input.lastSeating, interval_minutes: interval }),
    } },
  })
}
