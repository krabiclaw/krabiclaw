export const LODGING_CONFIRMATION_MODES = ['instant', 'review'] as const
export type LodgingConfirmationMode = typeof LODGING_CONFIRMATION_MODES[number]

export interface LodgingBookingPolicy {
  confirmation_mode: LodgingConfirmationMode
  online_payment_required: true
}

export interface LodgingBookingChoice {
  value: LodgingConfirmationMode
  label: string
  description: string
  icon: string
}

export const LODGING_BOOKING_CHOICES: LodgingBookingChoice[] = [
  { value: 'review', label: 'Approve requests', description: 'Guests pay online after you approve their request.', icon: 'i-lucide-calendar-check' },
  { value: 'instant', label: 'Instant Book', description: 'Guests pay online and book automatically.', icon: 'i-lucide-zap' },
]

export function isLodgingConfirmationMode(value: unknown): value is LodgingConfirmationMode {
  return value === 'instant' || value === 'review'
}
