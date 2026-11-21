import type { ProductKind } from '~/shared/product-details'
import { isRecord } from '~/utils/api-clients'

/**
 * A booking's agreement, as the server decides it and every client renders it.
 *
 * The record of it is the booking conversation's own messages: a document the
 * business stored or sent for signing is a message with the PDF placed on it,
 * each signature is a message, and a cancelled request is a message. Nothing
 * else holds agreement state.
 */
export const AGREEMENT_EVENTS = ['agreement.stored', 'agreement.sent', 'agreement.signed', 'agreement.cancelled'] as const
export type AgreementEvent = typeof AGREEMENT_EVENTS[number]

/** What each kind of booking calls the document its guests sign. */
const AGREEMENT_LABELS: Partial<Record<ProductKind, string>> = {
  stay: 'Rental agreement',
  service: 'Engagement letter',
  experience: 'Waiver',
  table: 'Event contract',
}

export function agreementLabel(kind: ProductKind, isLongTerm = false): string {
  if (kind === 'stay' && isLongTerm) return 'Lease'
  const label = AGREEMENT_LABELS[kind]
  if (!label) throw new Error(`A ${kind} is not booked, so it has no agreement`)
  return label
}

/** Structured terms for generating leases, engagement letters, and waivers (#2038). */
export interface AgreementTerms {
  term_type: 'fixed' | 'month_to_month'
  start_date: string
  end_date?: string | null
  monthly_rent_minor: number
  deposit_minor: number
  deposit_status?: 'none' | 'pending' | 'held' | 'partially_returned' | 'returned' | 'forfeited'
  deposit_notes?: string
  currency: string
  rules_or_clauses?: string[]
}

/** A single installment period in a monthly payment schedule (#1907). */
export interface MonthlySchedulePeriod {
  period: number
  due_date: string
  start_date: string
  end_date: string
  amount_minor: number
  paid_minor: number
  status: 'paid' | 'partial' | 'due' | 'overdue' | 'upcoming'
}

/**
 * Calculates monthly payment schedule for long-term stays or recurring customer contracts (#1907).
 * Reconciles total recorded payments against installment periods in chronological order.
 */
export function calculateMonthlyPaymentSchedule(
  startsAt: string,
  endsAt: string,
  monthlyRentMinor: number,
  totalPaidMinor: number,
  nowIso = new Date().toISOString(),
): MonthlySchedulePeriod[] {
  if (monthlyRentMinor <= 0) return []
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return []

  const periods: MonthlySchedulePeriod[] = []
  let currentStart = new Date(start)
  let periodNum = 1
  let remainingPaid = Math.max(0, totalPaidMinor)
  const nowDate = nowIso.split('T')[0]!

  while (currentStart < end) {
    const nextStart = new Date(currentStart)
    nextStart.setMonth(nextStart.getMonth() + 1)
    const periodEnd = nextStart > end ? end : nextStart

    const startDateStr = currentStart.toISOString().split('T')[0]!
    const endDateStr = periodEnd.toISOString().split('T')[0]!
    const dueDateStr = startDateStr

    const paidForPeriod = Math.min(monthlyRentMinor, remainingPaid)
    remainingPaid -= paidForPeriod

    let status: MonthlySchedulePeriod['status']
    if (paidForPeriod >= monthlyRentMinor) {
      status = 'paid'
    } else if (paidForPeriod > 0) {
      status = 'partial'
    } else if (dueDateStr < nowDate) {
      status = 'overdue'
    } else if (dueDateStr === nowDate) {
      status = 'due'
    } else {
      status = 'upcoming'
    }

    periods.push({
      period: periodNum++,
      due_date: dueDateStr,
      start_date: startDateStr,
      end_date: endDateStr,
      amount_minor: monthlyRentMinor,
      paid_minor: paidForPeriod,
      status,
    })

    currentStart = nextStart
  }

  return periods
}

/** Where one signer's signature or date goes: fractions of the page, from its top-left corner, on a 1-based page. */
export interface AgreementField {
  signer_key: string
  kind: 'signature' | 'date'
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface AgreementSigner {
  key: string
  name: string
  role: 'guest' | 'host'
  signed_at: string | null
}

export interface BookingAgreement {
  /** The business's word for it: Rental agreement, Engagement letter, Waiver, Event contract. */
  label: string
  /** The listing's agreement every booking signs, or a document for this booking alone. */
  source: 'listing' | 'booking'
  file_name: string
  /** The document as it was stored or sent. */
  url: string
  /** The document with every signature in place and its signature record, once all parties signed. */
  signed_url: string | null
  /** stored: a signed copy the business kept. signing: waiting on someone. signed: all parties signed here. */
  status: 'stored' | 'signing' | 'signed'
  completed_at: string | null
  signers: AgreementSigner[]
  fields: AgreementField[]
  /** The viewer's own place among the signers, when they have one. */
  viewer_signer_key: string | null
  /** The viewer may sign now: they have not, and every guest has before the host. */
  can_sign: boolean
  /** The viewer may store, send, replace or cancel the booking's document. */
  can_manage: boolean
}

const FIELD_KINDS = new Set(['signature', 'date'])

export function isAgreementField(value: unknown): value is AgreementField {
  if (!isRecord(value) || typeof value.signer_key !== 'string' || !FIELD_KINDS.has(value.kind as string)) return false
  const { page, x, y, width, height } = value
  return Number.isSafeInteger(page) && (page as number) >= 1
    && [x, y, width, height].every(part => typeof part === 'number' && Number.isFinite(part) && part >= 0 && part <= 1)
    && (x as number) + (width as number) <= 1 && (y as number) + (height as number) <= 1
    && (width as number) > 0 && (height as number) > 0
}

export function isBookingAgreement(value: unknown): value is BookingAgreement {
  return isRecord(value) && typeof value.label === 'string' && (value.source === 'listing' || value.source === 'booking')
    && typeof value.file_name === 'string' && typeof value.url === 'string' && (value.signed_url === null || typeof value.signed_url === 'string')
    && (value.status === 'stored' || value.status === 'signing' || value.status === 'signed')
    && Array.isArray(value.signers) && Array.isArray(value.fields) && value.fields.every(isAgreementField)
    && typeof value.can_sign === 'boolean' && typeof value.can_manage === 'boolean'
}

/** The URL of a booking conversation's agreement document, read through that conversation's access. */
export function agreementDocumentPath(conversationId: string, messageId: string, signed = false): string {
  return `/api/messages/${encodeURIComponent(conversationId)}/agreements/${encodeURIComponent(messageId)}${signed ? '/signed' : ''}`
}
