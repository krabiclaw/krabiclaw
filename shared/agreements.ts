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
    && Array.isArray(value.signers) && value.signers.every(signer => isRecord(signer) && typeof signer.key === 'string' && typeof signer.name === 'string'
      && (signer.role === 'guest' || signer.role === 'host') && (signer.signed_at === null || typeof signer.signed_at === 'string'))
    && Array.isArray(value.fields) && value.fields.every(isAgreementField)
    && typeof value.can_sign === 'boolean' && typeof value.can_manage === 'boolean'
}

/** The URL of a booking conversation's agreement document, read through that conversation's access. */
export function agreementDocumentPath(conversationId: string, messageId: string, signed = false): string {
  return `/api/messages/${encodeURIComponent(conversationId)}/agreements/${encodeURIComponent(messageId)}${signed ? '/signed' : ''}`
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** One line on where the agreement stands, as every surface states it. */
export function agreementStatusLine(agreement: BookingAgreement): string {
  const day = (at: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(at))
  if (agreement.status === 'stored') return `Signed copy added ${day(agreement.completed_at!)}`
  if (agreement.status === 'signed') return `All parties signed on ${day(agreement.completed_at!)}`
  const waiting = agreement.signers.filter(signer => !signer.signed_at).map(signer => signer.key === agreement.viewer_signer_key ? 'you' : signer.name.split(' ')[0]!)
  return `Waiting on ${joinNames(waiting)}`
}
