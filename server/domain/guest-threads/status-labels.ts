import type { GuestThreadSubmissionType } from './types'

const OPERATIONAL_STATUS_LABELS: Record<GuestThreadSubmissionType, Record<string, string>> = {
  contact: {},
  reservation: {
    pending: 'Pending',
    confirmed: 'Confirmed',
    completed: 'Completed',
    cancelled: 'Cancelled',
  },
  booking: {
    pending: 'Pending',
    confirmed: 'Confirmed',
    completed: 'Completed',
    cancelled: 'Cancelled',
  },
  stay: {
    pending: 'Pending',
    confirmed: 'Confirmed',
    cancelled: 'Cancelled',
  },
}

export function formatOperationalStatusLabel(type: GuestThreadSubmissionType, status: string): string {
  return OPERATIONAL_STATUS_LABELS[type][status]
    ?? status
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
}

/**
 * The instant, in the zone the guest booked it in.
 *
 * Every surface that prints a booking time goes through here: the inbox list
 * used to concatenate the raw UTC instant in SQL while the detail pane
 * formatted the same row in its own timezone, so the two disagreed about when
 * the guest was coming.
 */
export function formatThreadWhenLabel(startsAt: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(startsAt))
}
