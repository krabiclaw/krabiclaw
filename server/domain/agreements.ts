import { HTTPError } from 'nitro'
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { z } from 'zod'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { appendMessage, findMessageByDedupeKey, messageQueries, type ConversationRow, type MessageRow } from '~/server/domain/conversations'
import { createConversationGuestInvite } from '~/server/domain/conversation-participants'
import { createDeliveryReceipt, deliverGuestThreadEmail, isDeliverySent } from '~/server/domain/guest-threads/deliveries'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { renderNotificationEmail } from '~/server/emails/render'
import { guestThreadStatusMessage } from '~/server/notifications/guest-events'
import { organizationLogo } from '~/server/notifications/hero'
import type { CloudflareEnv } from '~/server/utils/auth'
import { readR2Object } from '~/server/utils/cloudflare-r2'
import { depositQuery, presentDeposit } from '~/server/domain/deposits'
import { getPlatformDomain, platformOrigin } from '~/server/utils/dashboard-notification-links'
import { getEmailDeliveryMode } from '~/server/utils/email-delivery'
import { buildMediaPlacementInsertQuery } from '~/server/utils/media-asset-manager'
import { sniffMediaMimeType } from '~/server/utils/media-mime'
import { sanitizeFilename, uploadPrivateDocument } from '~/server/utils/media-upload'
import { AGREEMENT_EVENTS, agreementDocumentPath, agreementLabel, isAgreementField, type AgreementField, type AgreementSigner, type BookingAgreement } from '~/shared/agreements'
import { PLATFORM_MESSAGE_AUTHOR_KIND, guestConversationPath } from '~/shared/messages-contract'
import type { ProductKind } from '~/shared/product-details'

/** The largest PDF a business may store or send: the same ceiling as a photo. */
export const MAX_AGREEMENT_BYTES = 20 * 1024 * 1024

const signerSchema = z.object({ key: z.string().regex(/^(user:.+|email:[^\s@]+@[^\s@]+\.[^\s@]+)$/), name: z.string().trim().min(1).max(120), role: z.enum(['guest', 'host']) })
const sentSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), signers: z.array(signerSchema).min(1), fields: z.array(z.custom<AgreementField>(isAgreementField)) })
const signedSchema = z.object({
  request_id: z.string().nullable(), signer_key: z.string(), typed_name: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  ip: z.string().nullable(), user_agent: z.string().nullable(),
})
const cancelledSchema = z.object({ request_id: z.string() })

/** The booking an agreement belongs to, as its reader already holds it. */
export interface AgreementBooking {
  conversationId: string
  organizationId: string
  bookingId: string
  productId: string
  productKind: ProductKind
  status: string
  endsAt: string
  /** The account that booked; it signs the listing's agreement under the booking's guest name. */
  bookingUserId: string | null
  guestName: string | null
}

export interface AgreementViewer {
  userId: string
  /** A verified email matches a signer the business invited by email. */
  verifiedEmail: string | null
  canManage: boolean
}

type AgreementRecord = MessageRow & { asset_id: string | null; file_name: string | null; r2_key: string | null; public_url: string | null }
type ListingDocument = { asset_id: string; file_name: string | null; r2_key: string | null; public_url: string | null }

/**
 * The booking an agreement read is for: its ID, and its organization as a SQL
 * value. A caller that batches the booking's own read passes the organization
 * its batch already resolved (`BATCH_VIEWER.organization`), so the agreement
 * rides in that same round trip.
 */
export interface AgreementTarget {
  booking: { sql: string; params: unknown[] }
  organization: { sql: string; params: unknown[] }
}

const BOOKING_CONVERSATION = (target: AgreementTarget) => ({
  sql: `(SELECT id FROM conversations WHERE booking_id = ${target.booking.sql} AND organization_id = ${target.organization.sql} AND kind = 'booking')`,
  params: [...target.booking.params, ...target.organization.params],
})

function recordsQuery(target: AgreementTarget): BatchQuery {
  const conversation = BOOKING_CONVERSATION(target)
  return {
    query: `SELECT m.*, ma.id AS asset_id, ma.file_name, ma.r2_key, ma.public_url
      FROM messages m
      LEFT JOIN media_placements mp ON mp.owner_type = 'message' AND mp.owner_id = m.id AND mp.slot = 'agreement' AND mp.status = 'active'
      LEFT JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id AND ma.status = 'active'
      WHERE m.conversation_id = ${conversation.sql} AND m.event_name IN (${AGREEMENT_EVENTS.map(() => '?').join(', ')})
      ORDER BY m.sequence`,
    params: [...conversation.params, ...AGREEMENT_EVENTS],
  }
}

function listingQuery(target: AgreementTarget): BatchQuery {
  return {
    query: `SELECT ma.id AS asset_id, ma.file_name, ma.r2_key, ma.public_url
      FROM bookings b JOIN media_placements mp ON mp.organization_id = b.organization_id AND mp.owner_type = 'product' AND mp.owner_id = b.product_id AND mp.slot = 'agreement' AND mp.status = 'active'
      JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id AND ma.status = 'active'
      WHERE b.id = ${target.booking.sql} AND b.organization_id = ${target.organization.sql}`,
    params: [...target.booking.params, ...target.organization.params],
  }
}

function bookingQuery(target: AgreementTarget): BatchQuery {
  return {
    query: `SELECT c.id AS conversation_id, b.id AS booking_id, b.organization_id, b.product_id, p.kind, b.status, b.ends_at, b.user_id, COALESCE(json_extract(c.payload_json, '$.guest.name'), u.name) AS guest_name,
        EXISTS (SELECT 1 FROM media_placements tp JOIN media_assets ta ON ta.id = tp.asset_id AND ta.organization_id = tp.organization_id AND ta.status = 'active'
                 WHERE tp.organization_id = b.organization_id AND tp.owner_type = 'product' AND tp.owner_id = b.product_id AND tp.slot = 'agreement_template' AND tp.status = 'active') AS has_template
      FROM bookings b JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
      JOIN conversations c ON c.booking_id = b.id AND c.organization_id = b.organization_id AND c.kind = 'booking'
      LEFT JOIN user u ON u.id = b.user_id
     WHERE b.id = ${target.booking.sql} AND b.organization_id = ${target.organization.sql}`,
    params: [...target.booking.params, ...target.organization.params],
  }
}

function signersQuery(target: AgreementTarget): BatchQuery {
  const conversation = BOOKING_CONVERSATION(target)
  return {
    query: `SELECT p.user_id, u.name, u.isAnonymous AS anonymous, json_extract(c.payload_json, '$.guest.name') AS booked_name, json_extract(c.payload_json, '$.guest.email') AS booked_email
      FROM conversation_participants p JOIN user u ON u.id = p.user_id JOIN conversations c ON c.id = p.conversation_id
     WHERE p.conversation_id = ${conversation.sql} AND p.role = 'guest' ORDER BY p.created_at`,
    params: conversation.params,
  }
}

/**
 * Everything an agreement reads, as statements for one batch: the booking, its
 * conversation's agreement messages with their documents, the listing's
 * agreement and, for the business, the guests it may ask to sign. A reader of
 * the booking appends these to its own batch.
 */
export function agreementQueries(target: AgreementTarget, withSigners = false): BatchQuery[] {
  // The booking's deposit is one of its agreed terms, so it rides in the same read.
  return [bookingQuery(target), recordsQuery(target), listingQuery(target), depositQuery(target), ...(withSigners ? [signersQuery(target)] : [])]
}

type SignerRow = { user_id: string; name: string | null; anonymous: number; booked_name: string | null; booked_email: string | null }

/** The batch results of `agreementQueries`, in their order. */
export function agreementFromResults(results: { results: unknown[] }[]) {
  const [bookingRows, records, listing, deposit, signers] = results
  const row = bookingRows?.results[0] as { conversation_id: string; booking_id: string; organization_id: string; product_id: string; kind: ProductKind; status: string; ends_at: string; user_id: string | null; guest_name: string | null; has_template: number } | undefined
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found', data: { code: 'BOOKING_NOT_FOUND', field: 'booking_id' } })
  const booking: AgreementBooking = {
    conversationId: row.conversation_id, organizationId: row.organization_id, bookingId: row.booking_id,
    productId: row.product_id, productKind: row.kind, status: row.status, endsAt: row.ends_at, bookingUserId: row.user_id, guestName: row.guest_name?.trim() || null,
  }
  return {
    booking,
    records: records!.results as AgreementRecord[],
    listing: (listing!.results[0] as ListingDocument | undefined) ?? null,
    signerRows: signers ? signers.results as SignerRow[] : null,
    deposit: presentDeposit(deposit!.results[0]),
    hasTemplate: row.has_template === 1,
  }
}

function conversationTarget(conversation: Pick<ConversationRow, 'organization_id' | 'booking_id' | 'kind'>): AgreementTarget {
  if (conversation.kind !== 'booking' || !conversation.booking_id) throw new HTTPError({ statusCode: 404, message: 'This conversation has no booking', data: { code: 'BOOKING_NOT_FOUND', field: 'conversation_id' } })
  return { booking: { sql: '?', params: [conversation.booking_id] }, organization: { sql: '?', params: [conversation.organization_id] } }
}

/** One D1 round trip for the agreement and its booking, for a write or a document read. */
async function readAgreement(db: DbClient, conversation: Pick<ConversationRow, 'organization_id' | 'booking_id' | 'kind'>, withSigners = false) {
  return agreementFromResults(await executeBatch(db, agreementQueries(conversationTarget(conversation), withSigners), { operation: 'Read booking agreement' }))
}

function payload(record: Pick<MessageRow, 'payload_json'>): unknown {
  return JSON.parse(record.payload_json)
}

function viewerSigns(signer: { key: string }, viewer: AgreementViewer | null, signers?: SignerRow[] | null, bookerUserId?: string | null): boolean {
  if (!viewer) return false
  if (signer.key === `user:${viewer.userId}`) return true
  if (viewer.verifiedEmail !== null && signer.key === `email:${viewer.verifiedEmail.toLowerCase()}`) return true
  if (signer.key.startsWith('email:') && viewer.userId === bookerUserId && signers?.some(row => row.user_id === viewer.userId && row.booked_email && signer.key === `email:${row.booked_email.trim().toLowerCase()}`)) return true
  return false
}

/** What the agreement is now: the current request and its signatures, or the listing's agreement and the booker's. */
interface AgreementState {
  request: AgreementRecord | null
  listing: ListingDocument | null
  listingSignature: AgreementRecord | null
  signers: (z.infer<typeof signerSchema> & { signature: AgreementRecord | null })[]
  fields: AgreementField[]
}

function agreementState(records: AgreementRecord[], listing: ListingDocument | null, booking: AgreementBooking, now: string): AgreementState | null {
  const cancelled = new Set(records.filter(record => record.event_name === 'agreement.cancelled').map(record => cancelledSchema.parse(payload(record)).request_id))
  const latestRequest = [...records].reverse().find(record => record.event_name === 'agreement.stored' || record.event_name === 'agreement.sent') ?? null
  const request = latestRequest && !cancelled.has(latestRequest.id) ? latestRequest : null
  const signatures = records.filter(record => record.event_name === 'agreement.signed').map(record => ({ record, signed: signedSchema.parse(payload(record)) }))
  if (request) {
    if (!request.asset_id) throw new Error(`Agreement message ${request.id} has no document`)
    if (request.event_name === 'agreement.stored') return { request, listing: null, listingSignature: null, signers: [], fields: [] }
    const sent = sentSchema.parse(payload(request))
    return {
      request, listing: null, listingSignature: null, fields: sent.fields,
      signers: sent.signers.map(signer => ({ ...signer, signature: signatures.find(({ signed }) => signed.request_id === request.id && signed.signer_key === signer.key)?.record ?? null })),
    }
  }
  // The listing's agreement: the booker signs it, once, and that signature keeps the document it signed.
  const listingSignature = signatures.find(({ signed }) => signed.request_id === null)?.record ?? null
  if (listingSignature) {
    if (!listingSignature.asset_id) throw new Error(`Agreement signature ${listingSignature.id} has no document`)
    const signed = signedSchema.parse(payload(listingSignature))
    return { request: null, listing: null, listingSignature, fields: [], signers: [{ key: signed.signer_key, name: signed.typed_name, role: 'guest', signature: listingSignature }] }
  }
  const open = (booking.status === 'pending' || booking.status === 'confirmed') && booking.endsAt > now
  // A booking with no guest named has no one to sign the listing's agreement.
  if (!listing || !open || !booking.bookingUserId || !booking.guestName) return null
  return { request: null, listing, listingSignature: null, fields: [], signers: [{ key: `user:${booking.bookingUserId}`, name: booking.guestName, role: 'guest', signature: null }] }
}

function presentAgreement(state: AgreementState, booking: AgreementBooking, viewer: AgreementViewer | null, signersRows?: SignerRow[] | null): BookingAgreement {
  const signers: AgreementSigner[] = state.signers.map(signer => ({ key: signer.key, name: signer.name, role: signer.role, signed_at: signer.signature?.occurred_at ?? null }))
  const complete = signers.length > 0 && signers.every(signer => signer.signed_at !== null)
  const own = state.signers.find(signer => viewerSigns(signer, viewer, signersRows, booking.bookingUserId)) ?? null
  const guestsSigned = signers.every(signer => signer.role === 'host' || signer.signed_at !== null)
  const document = state.request ?? state.listingSignature
  const base = { label: agreementLabel(booking.productKind), fields: state.fields, viewer_signer_key: own?.key ?? null, can_manage: viewer?.canManage === true }
  if (state.request?.event_name === 'agreement.stored') {
    const url = agreementDocumentPath(booking.conversationId, state.request.id)
    return { ...base, source: 'booking', file_name: state.request.file_name ?? 'Agreement.pdf', url, signed_url: url, status: 'stored', completed_at: state.request.occurred_at, signers, can_sign: false }
  }
  const completedAt = complete ? signers.map(signer => signer.signed_at!).sort().at(-1)! : null
  if (document) {
    return {
      ...base, source: state.request ? 'booking' : 'listing', file_name: document.file_name ?? 'Agreement.pdf',
      url: agreementDocumentPath(booking.conversationId, document.id),
      signed_url: complete ? agreementDocumentPath(booking.conversationId, document.id, true) : null,
      status: complete ? 'signed' : 'signing', completed_at: completedAt, signers,
      can_sign: own !== null && own.signature === null && (own.role === 'guest' || guestsSigned),
    }
  }
  const listing = state.listing!
  if (!listing.public_url) throw new Error(`The listing agreement ${listing.asset_id} has no public URL`)
  return {
    ...base, source: 'listing', file_name: listing.file_name ?? 'Agreement.pdf', url: listing.public_url, signed_url: null,
    status: 'signing', completed_at: null, signers, can_sign: own !== null,
  }
}

/** The booking's agreement as this viewer reads it, from `agreementFromResults`, or null when it has none. */
export function presentBookingAgreement(read: Pick<ReturnType<typeof agreementFromResults>, 'booking' | 'records' | 'listing' | 'signerRows'>, viewer: AgreementViewer | null): BookingAgreement | null {
  const state = agreementState(read.records, read.listing, read.booking, new Date().toISOString())
  return state ? presentAgreement(state, read.booking, viewer, read.signerRows) : null
}

/** The agreement as a booking read presents it, from the rows its batch read with `agreementQueries`. */
export function bookingAgreementFromRows(rows: { results: unknown[] }[], viewer: AgreementViewer, actor: AgreementActor | null) {
  const read = agreementFromResults(rows)
  return {
    agreement: presentBookingAgreement(read, viewer),
    deposit: read.deposit,
    ...(viewer.canManage && read.signerRows && actor ? { agreement_signers: availableSigners(read.signerRows, actor), agreement_template: read.hasTemplate } : {}),
  }
}

/** The agreement, and for the business who it may ask to sign, in one D1 round trip. */
export async function readBookingAgreement(db: DbClient, conversation: Pick<ConversationRow, 'id' | 'organization_id' | 'booking_id' | 'kind'>, viewer: AgreementViewer, actor: AgreementActor) {
  const read = await readAgreement(db, conversation, viewer.canManage)
  return { agreement: presentBookingAgreement(read, viewer), deposit: read.deposit, available_signers: read.signerRows ? availableSigners(read.signerRows, actor) : null }
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function documentBytes(env: CloudflareEnv, r2Key: string | null, label: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!r2Key) throw new Error(`The ${label} has no stored file`)
  const bytes = await readR2Object(env, r2Key)
  if (!bytes) throw new Error(`The ${label} file is missing from storage`)
  return bytes
}

/** A PDF the business uploaded: its bytes, a stored name and its page count. */
async function readUploadedPdf(file: File): Promise<{ bytes: Uint8Array<ArrayBuffer>; filename: string; pages: number }> {
  if (file.size > MAX_AGREEMENT_BYTES) throw new HTTPError({ statusCode: 413, message: 'The PDF is larger than 20 MB', data: { code: 'UPLOAD_TOO_LARGE', field: 'file' } })
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (sniffMediaMimeType(bytes) !== 'application/pdf') throw new HTTPError({ statusCode: 415, message: 'Upload a PDF', data: { code: 'UNSUPPORTED_MEDIA_TYPE', field: 'file' } })
  const pdf = await PDFDocument.load(bytes).catch((cause: unknown) => {
    throw new HTTPError({ statusCode: 422, message: 'This PDF could not be read. Encrypted PDFs cannot be signed here.', data: { code: 'INVALID_PDF', field: 'file' }, cause })
  })
  const name = sanitizeFilename(file.name)
  return { bytes, filename: name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`, pages: pdf.getPageCount() }
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

export interface AgreementActor { userId: string; name: string }

/** A signed copy the business keeps on the booking. */
export async function storeAgreement(env: CloudflareEnv, conversation: ConversationRow, actor: AgreementActor, file: File) {
  const { booking } = await readAgreement(env.DB, conversation)
  const pdf = await readUploadedPdf(file)
  const label = agreementLabel(booking.productKind).toLowerCase()
  const writer = messageQueries({ conversationId: conversation.id, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: actor.userId, eventName: 'agreement.stored', body: `Added the signed ${label}`, payload: { sha256: await sha256(pdf.bytes) } })
  await uploadPrivateDocument({
    db: env.DB, env, organizationId: conversation.organization_id, userId: actor.userId, buffer: pdf.bytes, filename: pdf.filename,
    queries: assetId => [...writer.queries, buildMediaPlacementInsertQuery({ organizationId: conversation.organization_id, ownerType: 'message', ownerId: writer.id, slot: 'agreement', assetId, sortOrder: 0 })],
  })
  await publishConversationEvent(env, env.DB, { conversationId: conversation.id, type: 'MESSAGE_CREATE' })
}

export interface SendAgreementInput {
  file: File
  signers: { key: string; name: string; role: 'guest' | 'host' }[]
  fields: AgreementField[]
}

/** The business sends a document for its guests, and itself last, to sign; each guest is emailed a link to it. */
export async function sendAgreement(env: CloudflareEnv, conversation: ConversationRow, actor: AgreementActor, input: SendAgreementInput) {
  const { booking, signerRows } = await readAgreement(env.DB, conversation, true)
  const pdf = await readUploadedPdf(input.file)
  const signers = z.array(signerSchema).min(1).parse(input.signers)
  if (new Set(signers.map(signer => signer.key)).size !== signers.length) throw new HTTPError({ statusCode: 422, message: 'Each signer appears once', data: { code: 'DUPLICATE_SIGNER', field: 'signers' } })
  if (!signers.some(signer => signer.role === 'guest')) throw new HTTPError({ statusCode: 422, message: 'Add at least one guest to sign', data: { code: 'NO_GUEST_SIGNER', field: 'signers' } })
  const hosts = signers.filter(signer => signer.role === 'host')
  if (hosts.length > 1 || hosts.some(signer => signer.key !== `user:${actor.userId}`)) throw new HTTPError({ statusCode: 422, message: 'Only you can sign for the business', data: { code: 'INVALID_HOST_SIGNER', field: 'signers' } })
  // A guest signer with an account is a guest in this conversation; anyone else is invited by email.
  const seated = new Set(availableSigners(signerRows!, actor).map(signer => signer.key))
  if (signers.some(signer => signer.role === 'guest' && signer.key.startsWith('user:') && !seated.has(signer.key))) {
    throw new HTTPError({ statusCode: 422, message: 'A signer is not a guest on this booking', data: { code: 'SIGNER_NOT_GUEST', field: 'signers' } })
  }
  for (const field of input.fields) {
    if (!isAgreementField(field) || field.page > pdf.pages || !signers.some(signer => signer.key === field.signer_key)) {
      throw new HTTPError({ statusCode: 422, message: 'A field is off the document or names no signer', data: { code: 'INVALID_FIELD', field: 'fields' } })
    }
  }
  const unplaced = signers.find(signer => !input.fields.some(field => field.signer_key === signer.key && field.kind === 'signature'))
  if (unplaced) throw new HTTPError({ statusCode: 422, message: `Place a signature for ${unplaced.name}`, data: { code: 'SIGNATURE_UNPLACED', field: 'fields' } })
  const label = agreementLabel(booking.productKind).toLowerCase()
  const guests = signers.filter(signer => signer.role === 'guest')
  const writer = messageQueries({
    conversationId: conversation.id, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: actor.userId, eventName: 'agreement.sent',
    body: `Asked ${joinNames(guests.map(signer => signer.name))} to sign the ${label}`,
    payload: { sha256: await sha256(pdf.bytes), signers, fields: input.fields },
  })
  await uploadPrivateDocument({
    db: env.DB, env, organizationId: conversation.organization_id, userId: actor.userId, buffer: pdf.bytes, filename: pdf.filename,
    queries: assetId => [...writer.queries, buildMediaPlacementInsertQuery({ organizationId: conversation.organization_id, ownerType: 'message', ownerId: writer.id, slot: 'agreement', assetId, sortOrder: 0 })],
  })
  await publishConversationEvent(env, env.DB, { conversationId: conversation.id, type: 'MESSAGE_CREATE' })
  const sent = await findMessageByDedupeKey(env.DB, writer.dedupeKey)
  if (!sent) throw new Error('The agreement request was not saved')
  await emailSigners(env, conversation, booking, actor, sent, guests)
}

async function emailSigners(env: CloudflareEnv, conversation: ConversationRow, booking: AgreementBooking, actor: AgreementActor, sent: MessageRow, guests: { key: string; name: string }[]) {
  const organization = await queryFirst<{ name: string }>(env.DB, 'SELECT name FROM organization WHERE id = ?', [conversation.organization_id])
  if (!organization) throw new Error('The agreement has no organization')
  const label = agreementLabel(booking.productKind).toLowerCase()
  const logo = await organizationLogo(env.DB, conversation.organization_id)
  const origin = platformOrigin(env)
  for (const signer of guests) {
    const email = signer.key.startsWith('email:') ? signer.key.slice(6)
      : (await queryFirst<{ email: string }>(env.DB, 'SELECT email FROM user WHERE id = ?', [signer.key.slice(5)]))?.email
    if (!email) throw new HTTPError({ statusCode: 409, message: `${signer.name} has no email to send the ${label} to`, data: { code: 'SIGNER_EMAIL_MISSING', field: 'signers' } })
    let link: URL
    if (signer.key.startsWith('email:')) {
      const invite = await createConversationGuestInvite(env.DB, { organizationId: conversation.organization_id, userId: actor.userId }, { conversationId: conversation.id, email })
      link = new URL('/messages/invite', origin)
      link.searchParams.set('token', invite.token)
    } else {
      link = new URL(guestConversationPath('account', conversation.id), origin)
    }
    const delivery = await createDeliveryReceipt(env.DB, {
      subject: { messageId: sent.id }, channel: 'email', provider: getEmailDeliveryMode(env) === 'provider' ? 'resend' : 'log_only',
      purpose: 'status_update', idempotencyKey: `agreement-sent:${sent.id}:${signer.key}`,
    })
    const heading = `${organization.name} asked you to sign the ${label}`
    const delivered = await deliverGuestThreadEmail(env.DB, {
      delivery, env, to: email, fromName: organization.name, subject: heading, conversationId: conversation.id,
      email: await renderNotificationEmail(guestThreadStatusMessage({
        organizationName: organization.name, organizationLogoUrl: logo, heading,
        body: `${actor.name} sent you the ${label} for your booking. Read it and sign with your name.`,
        actionUrl: link.href, actionLabel: `Sign the ${label}`,
      }), { platformDomain: getPlatformDomain(env) }),
    })
    if (!isDeliverySent(delivered)) throw new HTTPError({ statusCode: 502, message: delivered.error || `The email to ${signer.name} was not confirmed`, data: { code: 'DELIVERY_INCOMPLETE', field: 'delivery', delivery_id: delivered.id } })
  }
}

/** The business withdraws the document it stored or sent; its record stays in the conversation. */
export async function cancelAgreement(env: CloudflareEnv, conversation: ConversationRow, actor: AgreementActor) {
  const { booking, records, listing } = await readAgreement(env.DB, conversation)
  const state = agreementState(records, listing, booking, new Date().toISOString())
  if (!state?.request) throw new HTTPError({ statusCode: 409, message: 'This booking has no document to cancel', data: { code: 'NO_AGREEMENT_REQUEST', field: 'request_id' } })
  if (state.signers.length && state.signers.every(signer => signer.signature)) throw new HTTPError({ statusCode: 409, message: 'Everyone signed this document', data: { code: 'AGREEMENT_SIGNED', field: 'request_id' } })
  await appendMessage(env.DB, {
    conversationId: conversation.id, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: actor.userId, eventName: 'agreement.cancelled',
    body: `Withdrew the ${agreementLabel(booking.productKind).toLowerCase()}`, payload: { request_id: state.request.id }, dedupeKey: `agreement-cancelled:${state.request.id}`,
  })
  await publishConversationEvent(env, env.DB, { conversationId: conversation.id, type: 'MESSAGE_CREATE' })
}

export interface SignAgreementInput {
  typedName: string
  consent: boolean
  ip: string | null
  userAgent: string | null
}

/** The viewer signs: their consent, the name they typed and the exact document's fingerprint, as a message in the booking's conversation. */
export async function signAgreement(env: CloudflareEnv, conversation: ConversationRow, viewer: AgreementViewer, input: SignAgreementInput) {
  if (!input.consent) throw new HTTPError({ statusCode: 422, message: 'Agree to sign electronically', data: { code: 'CONSENT_REQUIRED', field: 'consent' } })
  const typedName = input.typedName.trim()
  if (typedName.length < 2 || typedName.length > 120) throw new HTTPError({ statusCode: 422, message: 'Type your full name', data: { code: 'NAME_REQUIRED', field: 'typed_name' } })
  const { booking, records, listing, signerRows } = await readAgreement(env.DB, conversation, true)
  const state = agreementState(records, listing, booking, new Date().toISOString())
  const agreement = state ? presentAgreement(state, booking, viewer, signerRows) : null
  if (!state || !agreement?.can_sign || !agreement.viewer_signer_key) throw new HTTPError({ statusCode: 409, message: 'There is nothing for you to sign on this booking', data: { code: 'NOTHING_TO_SIGN', field: 'conversation_id' } })
  const document = state.request ?? state.listing!
  const label = agreement.label.toLowerCase()
  const fingerprint = await sha256(await documentBytes(env, document.r2_key, label))
  if (state.request && fingerprint !== sentSchema.parse(payload(state.request)).sha256) throw new Error(`The ${label} changed in storage after it was sent`)
  const requestId = state.request?.id ?? null
  const writer = messageQueries({
    conversationId: conversation.id, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: viewer.userId, eventName: 'agreement.signed', body: `Signed the ${label}`,
    payload: { request_id: requestId, signer_key: agreement.viewer_signer_key, typed_name: typedName, sha256: fingerprint, ip: input.ip, user_agent: input.userAgent },
    dedupeKey: `agreement-signed:${requestId ?? `listing:${booking.bookingId}`}:${agreement.viewer_signer_key}`,
  })
  await executeBatch(env.DB, [
    ...writer.queries,
    // A listing agreement may change; the signature keeps the document it signed.
    ...requestId ? [] : [buildMediaPlacementInsertQuery({ organizationId: conversation.organization_id, ownerType: 'message', ownerId: writer.id, slot: 'agreement', assetId: state.listing!.asset_id, sortOrder: 0 })],
  ], { operation: 'Sign agreement' })
  await publishConversationEvent(env, env.DB, { conversationId: conversation.id, type: 'MESSAGE_CREATE' })
}

/** The document an agreement message holds, for someone who can read its conversation. */
export async function agreementDocument(env: CloudflareEnv, conversation: ConversationRow, messageId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; fileName: string }> {
  const record = (await readAgreement(env.DB, conversation)).records.find(entry => entry.id === messageId)
  if (!record?.asset_id) throw new HTTPError({ statusCode: 404, message: 'Document not found', data: { code: 'DOCUMENT_NOT_FOUND', field: 'message_id' } })
  return { bytes: await documentBytes(env, record.r2_key, 'agreement'), fileName: record.file_name ?? 'Agreement.pdf' }
}

const SIGNATURE_COLOR = rgb(0.09, 0.09, 0.11)

const NOTO_FONT_FILES = {
  thai: 'NotoSansThai-Regular.ttf',
  kr: 'NotoSansKR-Regular.ttf',
  jp: 'NotoSansJP-Regular.ttf',
  sc: 'NotoSansSC-Regular.ttf',
  tc: 'NotoSansTC-Regular.ttf',
  latin: 'NotoSans-Regular.ttf',
} as const
type NotoFontKey = keyof typeof NOTO_FONT_FILES

const WIN_ANSI_REGEX = /^[\u0020-\u007E\u00A0-\u00FF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]*$/

export function isWinAnsi(text: string): boolean {
  return WIN_ANSI_REGEX.test(text)
}

/**
 * A Noto font from the Worker's static assets, read once per document and
 * never kept between requests: the CJK files are 9–18 MB and the isolate has 128 MB.
 */
async function loadFontAssetBytes(env: CloudflareEnv, fileName: string, loaded: Map<string, Uint8Array>): Promise<Uint8Array> {
  const held = loaded.get(fileName)
  if (held) return held
  if (!env.ASSETS) throw new Error('The Worker has no ASSETS binding to read signature fonts from')
  const response = await env.ASSETS.fetch(new Request(`http://assets/fonts/${fileName}`))
  if (!response.ok) throw new Error(`Could not load font asset ${fileName}: ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  loaded.set(fileName, bytes)
  return bytes
}

/**
 * The one font a non-WinAnsi line needs, chosen by its script. Kana is
 * Japanese and Hangul Korean; Han text is Simplified Chinese unless the SC
 * font lacks one of its characters, when it is Traditional.
 */
export async function notoFontFor(env: CloudflareEnv, text: string, loaded: Map<string, Uint8Array>): Promise<{ key: NotoFontKey; bytes: Uint8Array }> {
  const chars = [...text]
  const key: NotoFontKey = chars.some(c => /\p{Script=Thai}/u.test(c)) ? 'thai'
    : chars.some(c => /\p{Script=Hangul}/u.test(c)) ? 'kr'
      : chars.some(c => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(c)) ? 'jp'
        : chars.some(c => /\p{Script=Han}/u.test(c)) ? 'sc' : 'latin'
  const bytes = await loadFontAssetBytes(env, NOTO_FONT_FILES[key], loaded)
  if (key !== 'sc') return { key, bytes }
  const sc = fontkit.create(bytes)
  if (chars.every(c => !/\p{Script=Han}/u.test(c) || sc.hasGlyphForCodePoint(c.codePointAt(0)!))) return { key, bytes }
  return { key: 'tc', bytes: await loadFontAssetBytes(env, NOTO_FONT_FILES.tc, loaded) }
}

/** The document with every signature where it was placed and a closing page that records who signed, when and how. */
export async function signedAgreementDocument(env: CloudflareEnv, conversation: ConversationRow, messageId: string, viewer: AgreementViewer): Promise<{ bytes: Uint8Array<ArrayBuffer>; fileName: string }> {
  const { booking, records, listing, signerRows } = await readAgreement(env.DB, conversation, true)
  const state = agreementState(records, listing, booking, new Date().toISOString())
  const agreement = state ? presentAgreement(state, booking, viewer, signerRows) : null
  const document = state?.request ?? state?.listingSignature
  if (!state || !agreement || !document || document.id !== messageId || agreement.status !== 'signed') {
    throw new HTTPError({ statusCode: 404, message: 'This document is not signed by everyone yet', data: { code: 'NOT_SIGNED', field: 'message_id' } })
  }
  const original = await documentBytes(env, document.r2_key, agreement.label.toLowerCase())
  const fingerprint = await sha256(original)
  const signatures = state.signers.map(signer => ({ signer, signed: signedSchema.parse(payload(signer.signature!)), at: signer.signature!.occurred_at }))
  if (signatures.some(({ signed }) => signed.sha256 !== fingerprint)) throw new Error(`The ${agreement.label.toLowerCase()} in storage is not the one that was signed`)
  const pdf = await PDFDocument.load(original)
  pdf.registerFontkit(fontkit)
  const [script, regular, bold] = await Promise.all([pdf.embedFont(StandardFonts.TimesRomanItalic), pdf.embedFont(StandardFonts.Helvetica), pdf.embedFont(StandardFonts.HelveticaBold)])

  const embeddedNotoFonts = new Map<NotoFontKey, PDFFont>()
  const loadedFonts = new Map<string, Uint8Array>()
  async function resolveFont(text: string, defaultFont: PDFFont): Promise<PDFFont> {
    if (isWinAnsi(text)) return defaultFont
    const { key, bytes } = await notoFontFor(env, text, loadedFonts)
    const embedded = embeddedNotoFonts.get(key)
    if (embedded) return embedded
    const font = await pdf.embedFont(bytes, { subset: true })
    embeddedNotoFonts.set(key, font)
    return font
  }

  const day = (at: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(at))
  for (const field of state.fields) {
    const page = pdf.getPage(field.page - 1)
    const { width, height } = page.getSize()
    const signature = signatures.find(({ signer }) => signer.key === field.signer_key)!
    const text = field.kind === 'signature' ? signature.signed.typed_name : day(signature.at)
    const defaultFont = field.kind === 'signature' ? script : regular
    const font = await resolveFont(text, defaultFont)
    const box = { x: field.x * width, y: height - (field.y + field.height) * height, w: field.width * width, h: field.height * height }
    const size = Math.min(box.h * (field.kind === 'signature' ? 0.8 : 0.6), field.kind === 'signature' ? 28 : 12)
    page.drawText(text, { x: box.x + 2, y: box.y + (box.h - size) / 2 + size * 0.2, size, font, color: SIGNATURE_COLOR, maxWidth: box.w - 4 })
  }
  // The signature record: what was signed, by whom, when and from where.
  const page = pdf.addPage([612, 792])
  let y = 740
  const line = async (text: string, size = 10, defaultFont = regular) => {
    const font = await resolveFont(text, defaultFont)
    page.drawText(text, { x: 54, y, size, font, color: SIGNATURE_COLOR, maxWidth: 504 })
    y -= size + 8
  }
  await line('Signature record', 16, bold)
  await line(`${agreement.label} · ${agreement.file_name}`)
  await line(`Document fingerprint (SHA-256): ${fingerprint}`, 8)
  y -= 8
  for (const { signer, signed, at } of signatures) {
    await line(`${signer.name} (${signer.role === 'host' ? 'business' : 'guest'})`, 11, bold)
    await line(`Signed as “${signed.typed_name}” on ${new Date(at).toUTCString()}`)
    await line(`Agreed to sign electronically. IP address ${signed.ip ?? 'not recorded'}.`, 9)
    y -= 6
  }
  if (state.request) await line(`Sent ${new Date(state.request.occurred_at).toUTCString()}. Completed ${new Date(agreement.completed_at!).toUTCString()}.`, 9)
  await line('Signed through Blawby.', 9)
  return { bytes: new Uint8Array(await pdf.save({ updateFieldAppearances: false })), fileName: agreement.file_name.replace(/\.pdf$/i, '') + '-signed.pdf' }
}

/** Who the business may ask to sign: the booking's guests in its conversation, and the business's own signer last. */
function availableSigners(guests: SignerRow[], actor: AgreementActor): { key: string; name: string; role: 'guest' | 'host' }[] {
  // A guest with an account signs as it; one who booked without one is invited by the email they booked with.
  return [
    ...guests.flatMap(guest => {
      if (guest.anonymous) {
        const email = guest.booked_email?.trim().toLowerCase()
        return email && guest.booked_name?.trim() ? [{ key: `email:${email}`, name: guest.booked_name.trim(), role: 'guest' as const }] : []
      }
      return guest.name?.trim() ? [{ key: `user:${guest.user_id}`, name: guest.name.trim(), role: 'guest' as const }] : []
    }),
    { key: `user:${actor.userId}`, name: actor.name, role: 'host' as const },
  ]
}
