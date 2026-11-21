import type { ProductKind } from '~/shared/product-details'
import { isRecord } from '~/utils/api-clients'

/**
 * A booking's refundable deposit (#1908), as the server states it and every
 * client renders it. Blawby moves no money here: the business records what it
 * received, returned and kept, and none of it counts as revenue except what
 * it kept.
 */
export const DEPOSIT_ENTRY_KINDS = ['received', 'returned', 'withheld'] as const
export type DepositEntryKind = typeof DEPOSIT_ENTRY_KINDS[number]
export const DEPOSIT_METHODS = ['cash', 'bank_transfer', 'card_external', 'other'] as const
export type DepositMethod = typeof DEPOSIT_METHODS[number]

export interface DepositEntry {
  id: string
  kind: DepositEntryKind
  /** Always positive; `kind` says which way it went. */
  amount_minor: number
  method: DepositMethod
  paid_on: string
  reference: string | null
  note: string | null
}

export interface BookingDeposit {
  /** The business's word for it: Security deposit, Retainer in trust. */
  label: string
  currency: string
  /** What the business asks for; null when it asks for none. */
  required_minor: number | null
  /** Received less returned and withheld: what the business holds now. */
  held_minor: number
  returned_minor: number
  withheld_minor: number
  entries: DepositEntry[]
}

const DEPOSIT_LABELS: Partial<Record<ProductKind, string>> = {
  stay: 'Security deposit',
  service: 'Retainer in trust',
  experience: 'Security deposit',
  table: 'Security deposit',
}

export function depositLabel(kind: ProductKind): string {
  const label = DEPOSIT_LABELS[kind]
  if (!label) throw new Error(`A ${kind} is not booked, so it has no deposit`)
  return label
}

/** One line on where the deposit stands. */
export function depositStatusLine(deposit: BookingDeposit, format: (minor: number) => string): string {
  if (deposit.held_minor > 0) return `${format(deposit.held_minor)} held`
  if (deposit.entries.length) return deposit.withheld_minor > 0 ? `${format(deposit.withheld_minor)} kept, the rest returned` : 'Returned'
  return deposit.required_minor === null ? 'None' : `${format(deposit.required_minor)} not received yet`
}

export function isBookingDeposit(value: unknown): value is BookingDeposit {
  return isRecord(value) && typeof value.label === 'string' && typeof value.currency === 'string'
    && (value.required_minor === null || Number.isSafeInteger(value.required_minor))
    && [value.held_minor, value.returned_minor, value.withheld_minor].every(Number.isSafeInteger)
    && Array.isArray(value.entries) && value.entries.every(entry => isRecord(entry) && typeof entry.id === 'string'
      && DEPOSIT_ENTRY_KINDS.includes(entry.kind as DepositEntryKind) && Number.isSafeInteger(entry.amount_minor))
}
