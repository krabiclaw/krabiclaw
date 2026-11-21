import type { ProductKind } from '~/shared/product-details'

/**
 * A business's own agreement template (#2038): its text, with `{{field}}`
 * placeholders filled from the booking's records when it is sent. Blawby
 * supplies no legal wording. Headings are lines starting `# `; everything else
 * is paragraphs separated by a blank line.
 */
export const AGREEMENT_TEMPLATE_FIELDS = [
  'business_name', 'client_name', 'client_email', 'host_name', 'offering', 'address',
  'start_date', 'end_date', 'price', 'deposit', 'cancellation_policy', 'today',
] as const
export type AgreementTemplateField = typeof AGREEMENT_TEMPLATE_FIELDS[number]

export const MAX_AGREEMENT_TEMPLATE_LENGTH = 20_000

const COMMON_LABELS: Record<AgreementTemplateField, string> = {
  business_name: 'Business name', client_name: 'Guest name', client_email: 'Guest email', host_name: 'Host',
  offering: 'Listing', address: 'Address', start_date: 'Start date', end_date: 'End date', price: 'Price',
  deposit: 'Security deposit', cancellation_policy: 'Cancellation policy', today: 'Today’s date',
}
const KIND_LABELS: Partial<Record<ProductKind, Partial<Record<AgreementTemplateField, string>>>> = {
  stay: { client_name: 'Tenant name', client_email: 'Tenant email', host_name: 'Landlord', offering: 'Home', address: 'Property address', start_date: 'Move-in date', end_date: 'Move-out date', price: 'Rent total' },
  service: { business_name: 'Firm name', client_name: 'Client name', client_email: 'Client email', host_name: 'Attorney', offering: 'Practice area', address: 'Office address', start_date: 'Consultation date', end_date: 'Consultation ends', price: 'Fee', deposit: 'Retainer in trust' },
  experience: { client_name: 'Participant name', client_email: 'Participant email', offering: 'Experience', start_date: 'Date', end_date: 'Ends' },
  table: { client_name: 'Guest name', offering: 'Reservation', start_date: 'Date', end_date: 'Ends' },
}

/** The field's name as this kind of business says it. */
export function agreementTemplateFieldLabel(kind: ProductKind, field: AgreementTemplateField): string {
  return KIND_LABELS[kind]?.[field] ?? COMMON_LABELS[field]
}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g

/** The template's fields, or the first unknown one, which is refused rather than left in the document. */
export function agreementTemplateFields(text: string): { fields: AgreementTemplateField[]; unknown: string | null } {
  const fields = new Set<AgreementTemplateField>()
  for (const [, name] of text.matchAll(PLACEHOLDER)) {
    if (!(AGREEMENT_TEMPLATE_FIELDS as readonly string[]).includes(name!)) return { fields: [...fields], unknown: name! }
    fields.add(name as AgreementTemplateField)
  }
  return { fields: [...fields], unknown: null }
}

export type AgreementTemplateBlock = { type: 'heading' | 'paragraph'; text: string }

/** The filled document as headings and paragraphs; every field it uses must have a value. */
export function fillAgreementTemplate(text: string, values: Partial<Record<AgreementTemplateField, string>>): AgreementTemplateBlock[] {
  const filled = text.replace(PLACEHOLDER, (_, name: AgreementTemplateField) => {
    const value = values[name]
    if (value === undefined) throw new Error(`The template field ${name} has no value`)
    return value
  })
  return filled.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(chunk => chunk.trim()).filter(Boolean).flatMap((chunk): AgreementTemplateBlock[] => {
    const lines = chunk.split('\n')
    if (!lines[0]!.startsWith('# ')) return [{ type: 'paragraph', text: lines.join(' ') }]
    const rest = lines.slice(1).join(' ').trim()
    return [{ type: 'heading', text: lines[0]!.slice(2).trim() }, ...(rest ? [{ type: 'paragraph' as const, text: rest }] : [])]
  })
}
