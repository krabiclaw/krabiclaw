import { HTTPError } from 'nitro'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { executeBatch, queryFirst, type DbClient } from '~/server/db'
import { isWinAnsi, notoFontFor } from '~/server/domain/agreements'
import type { ConversationRow } from '~/server/domain/conversations'
import type { CloudflareEnv } from '~/server/utils/auth'
import { formatBookingPolicySummary, parseBookingPolicy } from '~/server/utils/booking-policy-summary'
import { readR2Object } from '~/server/utils/cloudflare-r2'
import { buildMediaPlacementReplacementQueries } from '~/server/utils/media-asset-manager'
import { uploadPrivateDocument } from '~/server/utils/media-upload'
import { agreementLabel, type AgreementField } from '~/shared/agreements'
import { AGREEMENT_TEMPLATE_FIELDS, MAX_AGREEMENT_TEMPLATE_LENGTH, agreementTemplateFieldLabel, agreementTemplateFields, fillAgreementTemplate, type AgreementTemplateField } from '~/shared/agreement-templates'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount } from '~/shared/prices'
import type { ProductKind } from '~/shared/product-details'
import { STAY_BOOKED_POLICIES, bookedPolicyTerms, type StayBookedPolicy } from '~/shared/stay-cancellation'
import { formatPostalAddress, parsePostalAddress } from '~/utils/postal-address'

/**
 * A business's own agreement template (#2038): private text on the listing's
 * `agreement_template` slot, filled from one booking's records into a PDF that
 * the ordinary send path then sends to sign. Blawby supplies no wording.
 */

const TEMPLATE_PLACEMENT = (productId: string) => ({ owner_type: 'product', owner_id: productId, slot: 'agreement_template' })

function fail(statusCode: number, code: string, message: string, field: string, extra: Record<string, unknown> = {}): never {
  throw new HTTPError({ statusCode, message, data: { code, field, ...extra } })
}

const templateQuery = `SELECT ma.r2_key FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id AND ma.status = 'active'
  WHERE mp.organization_id = ? AND mp.owner_type = 'product' AND mp.owner_id = ? AND mp.slot = 'agreement_template' AND mp.status = 'active'`

async function templateText(env: CloudflareEnv, r2Key: string): Promise<string> {
  const bytes = await readR2Object(env, r2Key)
  if (!bytes) throw new Error('The agreement template file is missing from storage')
  return new TextDecoder().decode(bytes)
}

/** The listing's template text, or null when it has none. */
export async function readAgreementTemplate(env: CloudflareEnv, db: DbClient, organizationId: string, productId: string): Promise<string | null> {
  const row = await queryFirst<{ r2_key: string | null }>(db, templateQuery, [organizationId, productId])
  if (!row) return null
  if (!row.r2_key) throw new Error('The agreement template has no stored file')
  return templateText(env, row.r2_key)
}

/** Save the listing's template; the file and its placement commit together. Null removes it. */
export async function saveAgreementTemplate(env: CloudflareEnv, db: DbClient, input: { organizationId: string; userId: string; productId: string; kind: ProductKind; text: unknown }): Promise<void> {
  if (input.text === null) {
    await executeBatch(db, buildMediaPlacementReplacementQueries({ organizationId: input.organizationId, placement: TEMPLATE_PLACEMENT(input.productId), media: [] }), { operation: 'Remove agreement template' })
    return
  }
  if (typeof input.text !== 'string' || !input.text.trim()) fail(422, 'VALIDATION_ERROR', 'Write the template, or remove it', 'text')
  if (input.text.length > MAX_AGREEMENT_TEMPLATE_LENGTH) fail(422, 'VALIDATION_ERROR', `The template is longer than ${MAX_AGREEMENT_TEMPLATE_LENGTH.toLocaleString('en-US')} characters`, 'text')
  const { unknown } = agreementTemplateFields(input.text)
  if (unknown) fail(422, 'UNKNOWN_TEMPLATE_FIELD', `{{${unknown}}} is not a booking field. Use one of: ${AGREEMENT_TEMPLATE_FIELDS.join(', ')}`, 'text')
  await uploadPrivateDocument({
    db, env, organizationId: input.organizationId, userId: input.userId, contentType: 'text/markdown',
    buffer: new TextEncoder().encode(input.text) as Uint8Array<ArrayBuffer>, filename: `${agreementLabel(input.kind)}.md`,
    queries: assetId => buildMediaPlacementReplacementQueries({ organizationId: input.organizationId, placement: TEMPLATE_PLACEMENT(input.productId), media: [{ asset_id: assetId }] }),
  })
}

type Facts = {
  kind: ProductKind; offering: string; business_name: string; starts_at: string; ends_at: string; timezone: string
  total_minor: number | null; currency: string | null; deposit_minor: number | null; policy_json: string
  address: string | null; client_name: string | null; client_email: string | null; template_key: string | null
}

/** Everything a template can name, read in one statement with the template's own file. */
const factsQuery = `SELECT p.kind, p.name AS offering, o.name AS business_name, b.starts_at, b.ends_at, b.timezone, b.total_minor, b.currency, b.deposit_minor, b.policy_json,
    l.address, COALESCE(json_extract(c.payload_json, '$.guest.name'), u.name) AS client_name, COALESCE(json_extract(c.payload_json, '$.guest.email'), u.email) AS client_email,
    (${templateQuery.replace('mp.organization_id = ?', 'mp.organization_id = b.organization_id').replace('mp.owner_id = ?', 'mp.owner_id = b.product_id')}) AS template_key
  FROM conversations c JOIN bookings b ON b.id = c.booking_id AND b.organization_id = c.organization_id
  JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
  JOIN organization o ON o.id = b.organization_id
  LEFT JOIN business_locations l ON l.id = b.location_id AND l.organization_id = b.organization_id
  LEFT JOIN user u ON u.id = b.user_id
 WHERE c.id = ? AND c.organization_id = ? AND c.kind = 'booking'`

function day(at: string, timezone: string): string {
  // A nights booking holds local days; a timed one holds instants read in its own clock.
  if (at.length === 10) return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${at}T00:00:00Z`))
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: timezone }).format(new Date(at))
}

function cancellationText(facts: Facts): string {
  const policy = parseBookingPolicy(facts.policy_json)
  if (facts.kind === 'stay') {
    if (!policy.cancellation || !(STAY_BOOKED_POLICIES as readonly string[]).includes(policy.cancellation)) throw new Error('A stay was booked without a cancellation policy')
    const terms = bookedPolicyTerms(policy.cancellation as StayBookedPolicy)
    return [`${terms.label}.`, terms.summary, 'detail' in terms ? terms.detail : null].filter(Boolean).join(' ')
  }
  const item = formatBookingPolicySummary(policy, 'en', facts.kind).items.find(entry => entry.id === 'cancellation')
  if (!item) throw new Error('A booking policy has no cancellation term')
  return item.text
}

/** What each field reads from this booking; a field the booking cannot fill has no entry. */
function fieldValues(facts: Facts, hostName: string): Partial<Record<AgreementTemplateField, string>> {
  const money = (minor: number | null) => minor !== null && isCurrencyCode(facts.currency) ? formatMinorAmount(minor, facts.currency) : undefined
  const address = formatPostalAddress(parsePostalAddress(facts.address ? JSON.parse(facts.address) : null))
  const values: Partial<Record<AgreementTemplateField, string | undefined>> = {
    business_name: facts.business_name, client_name: facts.client_name?.trim() || undefined, client_email: facts.client_email?.trim() || undefined,
    host_name: hostName.trim() || undefined, offering: facts.offering, address: address || undefined,
    start_date: day(facts.starts_at, facts.timezone), end_date: day(facts.ends_at, facts.timezone),
    price: money(facts.total_minor), deposit: money(facts.deposit_minor), cancellation_policy: cancellationText(facts),
    today: new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: facts.timezone }).format(new Date()),
  }
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<Record<AgreementTemplateField, string>>
}

const PAGE = { width: 612, height: 792, margin: 72 }
const INK = rgb(0.09, 0.09, 0.11)

/** Words, and for text without spaces (Thai, Chinese, Japanese) characters, that fit the line. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = []
  let line = ''
  const tokens = text.split(/(\s+)/).flatMap(token => font.widthOfTextAtSize(token, size) > width ? [...token] : [token])
  for (const token of tokens) {
    const next = line + token
    if (line && font.widthOfTextAtSize(next.trimEnd(), size) > width) {
      lines.push(line.trimEnd())
      line = token.trimStart()
    } else {
      line = next
    }
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines
}

/**
 * Fill the listing's template from this booking and lay it out as a PDF, with
 * each signer's signature and date lines after the text. A field the booking
 * cannot fill refuses the document and names it.
 */
export async function generateAgreementFromTemplate(env: CloudflareEnv, conversation: ConversationRow, actor: { name: string }, signers: { key: string; name: string; role: 'guest' | 'host' }[]) {
  const facts = await queryFirst<Facts>(env.DB, factsQuery, [conversation.id, conversation.organization_id])
  if (!facts) fail(404, 'BOOKING_NOT_FOUND', 'This conversation has no booking', 'conversation_id')
  if (!facts.template_key) fail(409, 'NO_AGREEMENT_TEMPLATE', 'This listing has no agreement template', 'template')
  if (!signers.length || !signers.some(signer => signer.role === 'guest')) fail(422, 'NO_GUEST_SIGNER', 'Add at least one guest to sign', 'signers')
  const text = await templateText(env, facts.template_key)
  const values = fieldValues(facts, actor.name)
  const missing = agreementTemplateFields(text).fields.filter(field => values[field] === undefined)
  if (missing.length) {
    fail(422, 'TEMPLATE_FIELD_MISSING', `This booking has no ${missing.map(field => agreementTemplateFieldLabel(facts.kind, field).toLowerCase()).join(', ')} to fill the template with`, 'template', { fields: missing })
  }
  const blocks = fillAgreementTemplate(text, values)

  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const [regular, bold] = await Promise.all([pdf.embedFont(StandardFonts.Helvetica), pdf.embedFont(StandardFonts.HelveticaBold)])
  const loaded = new Map<string, Uint8Array>()
  const embedded = new Map<string, PDFFont>()
  const fontFor = async (value: string, fallback: PDFFont) => {
    if (isWinAnsi(value)) return fallback
    const { key, bytes } = await notoFontFor(env, value, loaded)
    const held = embedded.get(key)
    if (held) return held
    const font = await pdf.embedFont(bytes, { subset: true })
    embedded.set(key, font)
    return font
  }
  const width = PAGE.width - 2 * PAGE.margin
  let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height])
  let y = PAGE.height - PAGE.margin
  const room = (needed: number) => {
    if (y - needed >= PAGE.margin) return
    page = pdf.addPage([PAGE.width, PAGE.height])
    y = PAGE.height - PAGE.margin
  }
  for (const block of blocks) {
    const heading = block.type === 'heading'
    const size = heading ? 14 : 11
    const font = await fontFor(block.text, heading ? bold : regular)
    const lines = wrap(block.text, font, size, width)
    y -= heading ? 10 : 0
    for (const line of lines) {
      room(size + 6)
      page.drawText(line, { x: PAGE.margin, y: y - size, size, font, color: INK })
      y -= size + 6
    }
    y -= heading ? 4 : 10
  }

  // The signature lines: every guest, then the business, each with its signature and date.
  const ordered = [...signers.filter(signer => signer.role === 'guest'), ...signers.filter(signer => signer.role === 'host')]
  const fields: AgreementField[] = []
  const box = { signature: { width: 260, height: 34 }, date: { width: 140, height: 34 } }
  for (const signer of ordered) {
    room(72)
    const label = await fontFor(signer.name, regular)
    page.drawText(signer.name, { x: PAGE.margin, y: y - 10, size: 10, font: label, color: INK })
    const top = y - 16
    const lineY = top - box.signature.height
    page.drawLine({ start: { x: PAGE.margin, y: lineY }, end: { x: PAGE.margin + box.signature.width, y: lineY }, thickness: 0.8, color: INK })
    page.drawLine({ start: { x: PAGE.margin + 300, y: lineY }, end: { x: PAGE.margin + 300 + box.date.width, y: lineY }, thickness: 0.8, color: INK })
    page.drawText('Signature', { x: PAGE.margin, y: lineY - 11, size: 8, font: regular, color: INK })
    page.drawText('Date', { x: PAGE.margin + 300, y: lineY - 11, size: 8, font: regular, color: INK })
    const pageNumber = pdf.getPageCount()
    const fraction = (x: number, w: number) => ({ x: x / PAGE.width, y: (PAGE.height - top) / PAGE.height, width: w / PAGE.width, height: box.signature.height / PAGE.height })
    fields.push({ signer_key: signer.key, kind: 'signature', page: pageNumber, ...fraction(PAGE.margin, box.signature.width) })
    fields.push({ signer_key: signer.key, kind: 'date', page: pageNumber, ...fraction(PAGE.margin + 300, box.date.width) })
    y = lineY - 28
  }
  return { bytes: await pdf.save(), file_name: `${agreementLabel(facts.kind)}.pdf`, fields }
}
