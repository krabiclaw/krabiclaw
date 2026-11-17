import { listingGrantSql } from '~/server/domain/listing-access'
import { assignedOperationsRoles, roleMatchesSql, workspaceManagementRoles } from '~/utils/organization-access'
import { publishEvent } from '~/server/events'
import { bookingReviewDueAt } from '~/server/utils/review-requests'
import { publishConversationEvent, scheduleBusinessWake } from '~/server/cloudflare/guest-inbox-events'
import { planSourceMessages } from '~/server/domain/scheduled-guest-messages'
import { bookingSessionFrom, CapacityUnavailableError, claimSessionCapacity, paidQuantity, partyPaysOnline, partySizeRefusal, savedBookingOpeningQuery, sessionAllocationPredicate, type SavedBookingOpening } from '~/server/utils/availability'
import { cloudflareEnv, cleanString } from '~/server/utils/api-response'
import { isReservedTestDomain, shouldSendRealEmail } from '~/server/utils/email-delivery'
import { notifyBookingCreated, raiseSettledFailures } from '~/server/utils/notifications'
import { measurementOutcome, readPageEventId, readWebsiteSource, recordOrganizationConversionEvent } from '~/server/utils/organization-conversions'
import { resolveLocationContact } from '~/server/utils/contact-resolution'
import { toE164 } from '~/utils/phone'
import { addLocalDays } from '~/utils/timezone'
import { execute, executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { bookingPolicy, formatBookingPolicySummary } from '~/server/utils/booking-policy-summary'
import { timedBookingPriceFrom, timedBookingPricesQuery } from '~/server/domain/bookings'
import type { Price } from '~/shared/prices'
import { isCurrencyCode } from '~/shared/currencies'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguage, requireSourceLocale } from '~/server/utils/localization'
import { formatTenantLocalePath } from '~/utils/tenant-locale-path'
import { buildOwnerThreadInboxUrl } from '~/server/utils/dashboard-notification-links'
import { createReplayableReservationCancelToken, hashReservationCancelToken } from '~/server/utils/reservation-cancel-token'
import { ensureInteractionUser, getAuthSession, type CloudflareEnv } from '~/server/utils/auth'
import { bookingDay, getGuestRequest, getThreadOperationalRecord, requestInsertQueries, stayRequestProgress, threadPayloadForGuest, type BookingOperator } from '~/server/domain/requests'
import { conversationTaskQueries } from '~/server/domain/guest-threads/repository'
import { GUEST_NOTE_EVENT, openingSentence } from '~/server/domain/guest-threads/opening'
import { DEFAULT_IP_HOURLY_LIMIT as IP_HOURLY_LIMIT, getClientIp, hashClientIp, hashIdentifier, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { HTTPError, type H3Event } from 'nitro'
import { checkoutAttemptQuery, createPaymentCheckout, type CheckoutAttempt } from '~/server/domain/payments/checkout'
import { paidOnline } from '~/server/domain/payments'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { isRecord } from '~/server/utils/type-guards'
import { createStay, createStayRequest, publicStayHomeFrom, publicStayHomeQueries, publishStayRequest, quoteStayAvailability, stayAccessFor, stayCheckoutPolicy, stayQuoteNightQueries } from '~/server/domain/stays'
import { LODGING_BOOKING_POLICY_COLUMNS, lodgingBookingPolicy } from '~/server/utils/lodging-booking-policy'
import { requireStripeCheckoutAcceptance } from '~/server/utils/stripe-connect'
import { accountActivityPath } from '~/shared/account-activity'
import { localizeStoredFormQuestions, validateFormAnswers } from '~/server/domain/form-questions'
import { formAnswerSnapshotsSchema, formAnswersFingerprint } from '~/shared/form-questions'
import type { ProductKind } from '~/shared/product-details'
import { assertCanOperateBookingProduct, assignedMemberSql, BATCH_VIEWER, memberAccessPrincipal, withViewer, type MemberAccessPrincipal, type ViewerTerms } from '~/server/utils/member-access'
import type { dashboardMemberQuery } from '~/server/utils/dashboard-context'
import { conversationMemberSql, CURRENT_GUEST_SQL } from '~/server/domain/conversations'
import { MEMBER_NAME_SQL } from '~/shared/member-scheduling'

export interface BookingCreationContext {
  organizationId: string
  slug: string
  productId?: string
  body: Record<string, unknown>
  financialWritesAllowed?: boolean
  operator?: BookingOperator
}

function creationResult(body: Record<string, unknown>, options: { status: number }) { return { body, status: options.status } }

interface BookingContact {
  name: string
  email: string
  phone: string | null
  notes: string | null
  locale: string
  idempotencyKey: string
}

async function bookingRateLimit(db: DbClient, env: CloudflareEnv, ipHash: string): Promise<string | null> {
  if (import.meta.dev || env.E2E_ALLOW_DEV_ROUTES === 'true') return null
  const hourWindow = Math.floor(Date.now() / 3_600_000)
  if (!await incrementHourlyRateLimit(db, `rate:book:ip:${ipHash}:${hourWindow}`, IP_HOURLY_LIMIT, 3_600_000)) {
    return 'Too many requests. Please try again later.'
  }
  return null
}

function readTimedSelection(input: { product_session_id?: unknown; product_variant_id?: unknown; party_size?: unknown }) {
  const sessionId = cleanString(input.product_session_id, 64)
  const requestedVariantId = cleanString(input.product_variant_id, 64)
  const partySize = typeof input.party_size === 'number' || typeof input.party_size === 'string' ? Number(input.party_size) : Number.NaN
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 99) {
    return { failure: creationResult({ error: 'Party size must be a whole number between 1 and 99.' }, { status: 400 }) }
  }
  if (!sessionId) return { failure: creationResult({ error: 'A session is required' }, { status: 400 }) }
  return { sessionId, requestedVariantId, partySize }
}

interface BookingOffering {
  id: string
  slug: string
  name: string
  kind: ProductKind
  order_url: string | null
  tax_code: string | null
  unit: 'slot' | 'nights' | null
  on_sale: number
}

function bookingParameter(value: string): BatchQuery {
  return { query: '?', params: [value] }
}

function bookingOfferingQuery(organization: BatchQuery, selector: { slug?: string; productId?: string }): BatchQuery {
  const { slug, productId } = selector
  return { query: `
    SELECT p.id, p.slug, p.name, p.kind, p.order_url, p.tax_code, cfg.unit,
      p.active AND EXISTS (SELECT 1 FROM product_publications pub
        WHERE pub.organization_id=p.organization_id AND pub.product_id=p.id AND pub.published=1) AS on_sale
    FROM products p LEFT JOIN product_booking_configs cfg ON cfg.product_id=p.id AND cfg.organization_id=p.organization_id
    WHERE p.organization_id=${organization.query} AND ${productId === undefined ? 'p.slug=?' : 'p.id=?'} AND (? IS NULL OR p.slug=?)
  `, params: [...organization.params ?? [], productId ?? slug, slug ?? null, slug ?? null] }
}

function timedBookingQueries(organization: BatchQuery, product: BatchQuery, input: { sessionId: string; requestedVariantId: string }): BatchQuery[] {
  const variants = { query: `SELECT id,name FROM product_variants WHERE organization_id=${organization.query} AND product_id=${product.query} AND active=1`,
    params: [...organization.params ?? [], ...product.params ?? []] }
  return [savedBookingOpeningQuery(organization, product, input.sessionId), variants, timedBookingPricesQuery(organization, {
    query: `SELECT id FROM (${variants.query}) WHERE (? = '' OR id=?) LIMIT 1`,
    params: [...variants.params, input.requestedVariantId, input.requestedVariantId],
  })]
}

function timedBookingFrom([opening, variants, prices]: Awaited<ReturnType<typeof executeBatch>>) {
  return {
    opening: opening!.results[0] as SavedBookingOpening | undefined,
    variants: variants!.results as Array<{ id: string; name: string }>,
    prices: prices!.results as unknown as Price[],
  }
}

async function timedBookingTerms(db: DbClient, env: CloudflareEnv, input: {
  organizationId: string; productId: string; sessionId: string; requestedVariantId: string
  partySize: number; currency: string; actorId: string; now: string
}, facts: ReturnType<typeof timedBookingFrom>) {
  const { requestedVariantId, partySize } = input
  const { opening, variants, prices } = facts
  const resolved = await bookingSessionFrom(db, { ...input, env }, opening)
  if (!variants.length) return { failure: creationResult({ error: 'This product has no bookable option' }, { status: 409 }) }
  if (!requestedVariantId && variants.length > 1) return { failure: creationResult({ error: 'Choose an option before booking' }, { status: 400 }) }
  const variant = requestedVariantId ? variants.find(candidate => candidate.id === requestedVariantId) : variants[0]
  if (!variant) return { failure: creationResult({ error: 'That option is not available for this product' }, { status: 400 }) }
  const { config } = resolved
  const partyRefusal = partySizeRefusal(config, partySize)
  if (partyRefusal) return { failure: creationResult({ error: partyRefusal, code: 'party_size_unavailable' }, { status: 400 }) }
  if (!isCurrencyCode(input.currency)) throw new Error(`Unsupported organization currency: ${input.currency}`)
  const price = timedBookingPriceFrom(prices, { variantId: variant.id, currency: input.currency, locationId: resolved.session.location_id, now: input.now })
  if (!price) return { failure: creationResult({ error: 'A current one-time price is required for this offering', code: 'price_unavailable' }, { status: 409 }) }
  const requiresPayment = partyPaysOnline(config, partySize) && price.unit_amount > 0
  return { resolved, config, variant, price, requiresPayment, policy: bookingPolicy(config, price) }
}

function throwQuoteFailure(failure: ReturnType<typeof creationResult>): never {
  const { error, ...data } = failure.body
  if (typeof error !== 'string') throw new Error('Booking quote failure has no message')
  throw new HTTPError({ statusCode: failure.status, message: error, data })
}

/** Read the same terms a timed booking will use, without claiming inventory. */
export async function quoteTimedBooking(db: DbClient, env: CloudflareEnv, input: {
  organizationId: string; slug: string; product_session_id?: unknown; product_variant_id?: unknown; party_size?: unknown
}) {
  const selection = readTimedSelection(input)
  if (selection.failure) throwQuoteFailure(selection.failure)
  const offeringQuery = bookingOfferingQuery(bookingParameter(input.organizationId), input)
  const [offering, organization] = await Promise.all([
    queryFirst<BookingOffering>(db, offeringQuery.query, offeringQuery.params),
    queryFirst<{ default_currency: string }>(db, "SELECT default_currency FROM organization WHERE id=? AND status='active'", [input.organizationId]),
  ])
  if (!offering || offering.unit !== 'slot' || offering.on_sale !== 1 || !organization) throw new HTTPError({ statusCode: 404, message: 'Product not found' })
  if (offering.order_url) throw new HTTPError({ statusCode: 409, message: 'Book this product on its configured external website.', data: { external_url: offering.order_url } })
  const now = new Date().toISOString()
  const facts = await executeBatch(db, timedBookingQueries(bookingParameter(input.organizationId), bookingParameter(offering.id), selection), { operation: 'Read booking quote terms' })
  const terms = await timedBookingTerms(db, env, { ...selection, organizationId: input.organizationId, productId: offering.id, currency: organization.default_currency, actorId: 'system', now }, timedBookingFrom(facts))
  if (terms.failure) throwQuoteFailure(terms.failure)
  const { resolved, config, variant, price, requiresPayment, policy } = terms
  const allocation = await sessionAllocationPredicate(db, { env, organizationId: input.organizationId, productId: offering.id, sessionId: resolved.session.id, partySize: selection.partySize, now, resolved, preview: true })
  if (!await queryFirst(db, `SELECT 1 WHERE ${allocation.query}`, allocation.params)) {
    throw new HTTPError({ statusCode: 409, message: 'This time no longer has capacity for your party', data: { code: 'capacity_unavailable' } })
  }
  if (requiresPayment && !await hasOrganizationEntitlement(env, input.organizationId, 'payments')) {
    throw new HTTPError({ statusCode: 409, message: 'Payments entitlement is required to collect online payment', data: { code: 'payment_required' } })
  }
  const { id, location_id, starts_at, ends_at, timezone } = resolved.session
  return { unit: 'slot' as const, product_id: offering.id, product_variant_id: variant.id, product_session_id: id, party_size: selection.partySize,
    location_id, starts_at, ends_at, timezone, currency: price.currency, tax_behavior: price.tax_behavior,
    total_minor: requiresPayment ? price.unit_amount * paidQuantity(config, selection.partySize) : 0, payment_required: requiresPayment, policy }
}

/** Creation delivery is shared by ordinary claims and authenticated Checkout conversion. */
export async function notifyProductBookingCreated(env: CloudflareEnv, db: DbClient, organizationId: string, requestId: string) {
  const [request, record, organization] = await Promise.all([
    getGuestRequest(db, requestId, organizationId, 'booking'),
    getThreadOperationalRecord(db, requestId),
    queryFirst<{ name: string | null; vertical: string | null; public_url: string | null }>(db, `SELECT name, vertical, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active') AS public_url FROM organization WHERE id = ?`, [organizationId]),
  ])
  if (!request || request.kind !== 'booking' || !record || record.organization_id !== organizationId || !organization) throw new Error('Booking creation delivery requires its canonical tenant, request and offering')
  const { name: guestName, email: guestEmail } = request.payload.guest
  if (guestName === null || guestEmail === null) throw new Error('A booking made on the site or by its operator has its guest\'s name and email')
  // The status the booking was created in, recorded on its conversation in the batch that claimed it.
  const creation = { status: request.payload.provenance?.creation_status }
  if (creation.status !== 'pending' && creation.status !== 'confirmed') throw new Error('Booking creation status is missing or invalid')
  if (request.payload.provenance?.followups_completed === true) return creation.status
  const sourceLocale = await getSourceLocale(db, organizationId)
  const locale = request.payload.guest.locale ?? sourceLocale
  // The guest's note is their message in the conversation.
  const note = await queryFirst<{ body: string | null }>(db, 'SELECT body FROM messages WHERE conversation_id = ? AND event_name = ?', [requestId, GUEST_NOTE_EVENT])
  const { token } = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', requestId)
  const tokenMatches = await hashReservationCancelToken(token) === request.payload.cancellation.token_hash
  const receiptUrl = tokenMatches && organization.public_url
    ? `${organization.public_url.replace(/\/$/, '')}${formatTenantLocalePath('/bookings/confirmed', locale, sourceLocale)}?id=${requestId}#${token}`
    : null
  const [{ contactPhone, contactEmail }, ownerInboxUrl, paid, booking] = await Promise.all([
    resolveLocationContact(db, organizationId, record.location_id),
    buildOwnerThreadInboxUrl(env, db, { organizationId, locationId: record.location_id ?? undefined, threadId: requestId }),
    paidOnline(db, organizationId, record.id),
    queryFirst<{ answers: string }>(db, 'SELECT answers FROM bookings WHERE organization_id = ? AND id = ?', [organizationId, record.id]),
  ])
  if (!booking) throw new Error(`Booking ${record.id} could not be read for its creation delivery`)
  // Its automatic messages are planned before the new conversation is announced, so it opens with them.
  await planSourceMessages(db, organizationId, record.id)
  if (record.unit === 'slot' && record.status === 'confirmed') {
    const dueAt = bookingReviewDueAt(record.ends_at)
    if (dueAt !== null) await scheduleBusinessWake(env, organizationId, 'reviews', dueAt)
  }
  const results = await Promise.allSettled([
    publishConversationEvent(env, db, { conversationId: requestId, type: 'MESSAGE_CREATE' }),
    notifyBookingCreated(env, db, {
      organizationId, organizationName: organization.name, vertical: organization.vertical, locationId: record.location_id,
      guestAcknowledgement: request.payload.provenance?.guest_acknowledgement ?? true,
      bookingId: requestId, bookingRecordId: record.id, status: creation.status, guestName,
      email: guestEmail, guestPhone: request.payload.guest.phone,
      productId: record.product_id, productKind: record.product_kind, productTitle: record.product_name, startsAt: record.starts_at,
      timezone: record.timezone, partySize: record.party_size, partySizeIsMinimum: record.party_size_is_minimum, notes: note?.body ?? null,
      ...(record.unit === 'nights' ? { stayDates: { checkIn: bookingDay(record.starts_at, record.timezone), checkOut: bookingDay(record.ends_at, record.timezone) } } : {}),
      receiptUrl, paid, contactPhone, contactEmail, ownerInboxUrl, locale, answers: formAnswerSnapshotsSchema.parse(JSON.parse(booking.answers)),
    }),
  ])
  raiseSettledFailures('booking creation delivery', `bookingId ${requestId}`, results, ['publishConversationEvent', 'notifyBookingCreated'])
  await execute(db, `UPDATE conversations SET payload_json = json_set(payload_json, '$.provenance.followups_completed', json('true'))
    WHERE id = ? AND organization_id = ? AND booking_id = ?`, [requestId, organizationId, record.id])
  return creation.status
}

type BookingOrganization = { id: string; slug: string; default_currency: string; vertical: string | null; source_locale: string | null;
  locale_status: string | null; policy_type: string | null; confirmation_mode: unknown }

async function readBookingCreation(db: DbClient, organization: BatchQuery, input: {
  slug?: string; productId?: string; body: Record<string, unknown>; idempotencyKey: string
}, membership: BatchQuery | null) {
  const offeringQuery = bookingOfferingQuery(organization, input)
  const organizationQuery: BatchQuery = { query: `
    SELECT o.id, o.slug, o.default_currency, o.vertical, source.locale AS source_locale, source.status AS locale_status,
      ${LODGING_BOOKING_POLICY_COLUMNS}
    FROM organization o LEFT JOIN organization_locales source ON source.organization_id=o.id AND source.is_source=1
    WHERE o.id=${organization.query} AND o.status='active'`, params: organization.params }
  const selection = readTimedSelection(input.body)
  const product = input.productId === undefined
    ? { query: `(SELECT id FROM (${offeringQuery.query}))`, params: offeringQuery.params }
    : bookingParameter(input.productId)
  const reads = [organizationQuery, offeringQuery]
  if (!selection.failure) reads.push(checkoutAttemptQuery(organization, input.idempotencyKey), ...timedBookingQueries(organization, product, selection))
  const results = await executeBatch(db, membership ? [membership, ...reads.map(read => withViewer(membership, read))] : reads,
    { operation: 'Read booking creation facts' })
  const member = membership ? results.shift()!.results[0] : undefined
  const [orgRows, offeringRows, attempts, ...timed] = results
  return {
    member, organization: orgRows!.results[0] as BookingOrganization | undefined, offering: offeringRows!.results[0] as BookingOffering | undefined,
    checkoutAttempt: attempts?.results[0] as CheckoutAttempt | undefined, timed: selection.failure ? null : timedBookingFrom(timed),
  }
}

/** The authenticated member creates a booking through the selected offering's inventory. */
export async function createMemberBooking(event: H3Event, input: {
  body: Record<string, unknown>; operator: Omit<BookingOperator, 'userId'>; financialWritesAllowed?: boolean
} & ({ dashboard: Awaited<ReturnType<typeof dashboardMemberQuery>>; principal?: never; productId: string; slug?: never }
  | { principal: MemberAccessPrincipal; dashboard?: never; slug: string; productId?: never })) {
  const { body, operator } = input
  const env = input.dashboard ? input.dashboard.env : input.principal.env
  const db = env.DB
  const facts = await readBookingCreation(db, input.dashboard ? { query: BATCH_VIEWER.organization } : bookingParameter(input.principal.organizationId),
    { ...input, idempotencyKey: operator.idempotencyKey }, input.dashboard?.membership ?? null)
  const principal = input.dashboard ? memberAccessPrincipal(input.dashboard.organizationFrom(facts.member), { env, event }) : input.principal
  const { organizationId, userId } = principal
  const product = facts.offering
  if (!product?.unit) throw new HTTPError({ statusCode: 404, message: 'Bookable offering not found' })
  const productId = product.id
  if (product.unit === 'nights') {
    const access = await stayAccessFor(principal)
    const stay = await createStay(db, env, access, { ...body, product_id: productId, idempotency_key: operator.idempotencyKey })
    return { kind: 'stay' as const, stay, status: 201 as const }
  }
  await assertCanOperateBookingProduct(db, principal, productId)
  const result = await createBookingFrom(event, env, {
    organizationId, slug: product.slug, productId, body,
    financialWritesAllowed: input.financialWritesAllowed, operator: { ...operator, userId },
  }, facts)
  return { kind: 'booking' as const, ...result }
}

/** Create a booking or checkout using the offering's canonical inventory unit. */
export async function createProductBooking(event: H3Event, context: BookingCreationContext) {
  const { organizationId, slug, body } = context
  if (!organizationId || !slug) return creationResult({ error: 'Organization and slug are required' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return creationResult({ error: 'Database not available' }, { status: 500 })

  const idempotencyKey = context.operator?.idempotencyKey ?? (typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '')
  const facts = await readBookingCreation(db, bookingParameter(organizationId), { ...context, idempotencyKey }, null)
  return createBookingFrom(event, env, context, facts)
}

async function createBookingFrom(event: H3Event, env: CloudflareEnv, context: BookingCreationContext, facts: Awaited<ReturnType<typeof readBookingCreation>>) {
  const { organizationId, slug, body, operator } = context
  const { organization, offering, checkoutAttempt } = facts
  const db = env.DB
  const nights = offering?.kind === 'stay'
  if (!organization) {
    if (nights) stayBookingError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found', 'organization_id')
    return creationResult({ error: 'Organization not found' }, { status: 404 })
  }
  const sourceLocale = requireSourceLocale(organizationId, organization.source_locale, organization.locale_status)
  const locale = body.locale === undefined ? sourceLocale : assertExactCanonicalLocale(body.locale)
  const usesSourceLocale = locale === sourceLocale
  const guestName = cleanString(body.guest_name, 100)
  const guestEmail = cleanString(body.guest_email, 254)
  const guestPhone = cleanString(body.guest_phone, 30)
  const normalizedGuestPhone = guestPhone ? toE164(guestPhone) : null
  const notes = cleanString(body.notes, 1000)
  const idempotencyKey = operator?.idempotencyKey ?? (typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '')
  const invalid = (code: string, message: string, field: string, slotStatus = 400) => {
    if (nights) stayBookingError(422, code, message, field)
    return creationResult({ error: message }, { status: slotStatus })
  }
  if (!guestName) return invalid('GUEST_NAME_REQUIRED', 'Name is required', 'guest_name')
  if (!guestEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) return invalid('GUEST_EMAIL_INVALID', 'A valid email address is required', 'guest_email')
  // Reserved test domains hard-bounce where the environment sends real email.
  if (shouldSendRealEmail(env) && isReservedTestDomain(guestEmail)) return invalid('GUEST_EMAIL_INVALID', 'Please enter a real email address.', 'guest_email', 422)
  if (guestPhone && !normalizedGuestPhone) return invalid('GUEST_PHONE_INVALID', 'A valid phone number is required.', 'guest_phone')
  if (!idempotencyKey || idempotencyKey.length > 200) return invalid('IDEMPOTENCY_KEY_REQUIRED', 'A stable booking request key is required', 'idempotency_key')

  if (nights) {
    if (operator || context.financialWritesAllowed === false) {
      throw new HTTPError({ statusCode: 409, statusMessage: 'Book these nights through the business’s payment workflow', data: { code: 'financial_action_required' } })
    }
    return createNightBooking(event, env, db, context, offering.id, { name: guestName, email: guestEmail, phone: normalizedGuestPhone, notes, locale, idempotencyKey }, organization, sourceLocale)
  }

  const selection = readTimedSelection(body)
  if (selection.failure) return selection.failure
  const { sessionId, requestedVariantId, partySize } = selection
  const pageEventId = readPageEventId(body.page_event_id)

  const threadId = await hashIdentifier(JSON.stringify(operator ? [organizationId, idempotencyKey] : ['website-booking', organizationId, idempotencyKey]))
  const fingerprint = await hashIdentifier(JSON.stringify({ slug, sessionId, requestedVariantId, partySize, guestName, guestEmail, phone: normalizedGuestPhone, notes, answers: formAnswersFingerprint(body.answers), source: operator?.source ?? 'website', externalReference: operator?.externalReference ?? null, guestAcknowledgement: operator?.guestAcknowledgement ?? true }))
  const replay = async () => {
    const existing = await queryFirst<{ id: string; status: string; fingerprint: string | null; completed: number | null; creation_status: string | null; product_session_id: string; product_variant_id: string; party_size: number }>(db, `SELECT b.id, b.status, b.product_session_id, b.product_variant_id, b.party_size, json_extract(r.payload_json, '$.provenance.fingerprint') AS fingerprint, json_extract(r.payload_json, '$.provenance.followups_completed') AS completed, json_extract(r.payload_json, '$.provenance.creation_status') AS creation_status FROM conversations r JOIN bookings b ON b.id = r.booking_id AND b.organization_id = r.organization_id WHERE b.organization_id = ? AND r.id = ?`, [organizationId, threadId])
    if (!existing) return null
    if (existing.fingerprint !== fingerprint) return creationResult({ error: 'Idempotency key was reused with different booking details', code: 'idempotency_conflict' }, { status: 409 })
    if (!existing.completed) {
      if (existing.status !== existing.creation_status || existing.product_session_id !== sessionId || (requestedVariantId && existing.product_variant_id !== requestedVariantId) || existing.party_size !== partySize) {
        return creationResult({ error: 'Booking changed before creation notifications completed. Read the current booking before continuing.', code: 'booking_changed', booking_id: existing.id, conversation_id: threadId, status: existing.status }, { status: 409 })
      }
      await publishEvent(env, { type: 'booking.created', organization_id: organizationId, conversation_id: threadId })
    }
    const record = await getThreadOperationalRecord(db, threadId)
    if (!record || record.organization_id !== organizationId || record.id !== existing.id) throw new Error('Committed booking is missing its operational receipt')
    if (!operator) {
      if (record.status !== 'pending' && record.status !== 'confirmed') return creationResult({ error: 'This booking has already been cancelled', code: 'booking_cancelled', booking_id: record.id, conversation_id: threadId }, { status: 409 })
      const cancellation = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', threadId)
      const request = await getGuestRequest(db, threadId, organizationId, 'booking')
      if (!request || request.kind !== 'booking' || await hashReservationCancelToken(cancellation.token) !== request.payload.cancellation.token_hash) throw new Error('Booking receipt is missing its cancellation capability')
      return creationResult({ success: true, conversation_id: threadId, booking_id: record.id, status: record.status, replayed: true,
        starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone, cancellation_token: cancellation.token,
        message: record.status === 'pending' ? 'Your booking request is awaiting review.' : 'Your booking is confirmed.',
      }, { status: 200 })
    }
    return creationResult({ success: true, conversation_id: threadId, booking_id: record.id, status: record.status, replayed: true,
      starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone,
    }, { status: 200 })
  }
  const existing = await replay()
  if (existing) return existing

  if (checkoutAttempt?.hold_conversation_id === threadId) {
    if (checkoutAttempt.hold_fingerprint !== fingerprint) return creationResult({ error: 'This key already identifies a different checkout request. Read its purchase before continuing.', code: 'idempotency_conflict' }, { status: 409 })
    const snapshot: unknown = JSON.parse(checkoutAttempt.price_snapshot_json)
    if (!isRecord(snapshot) || typeof snapshot.product_id !== 'string' || typeof snapshot.variant_id !== 'string'
      || snapshot.session_id !== sessionId || checkoutAttempt.hold_quantity !== partySize || requestedVariantId && snapshot.variant_id !== requestedVariantId) {
      return creationResult({ error: 'Checkout retry does not match its saved purchase', code: 'idempotency_conflict' }, { status: 409 })
    }
    if (context.financialWritesAllowed === false) throw new HTTPError({ statusCode: 409, statusMessage: 'Continue this purchase through the business’s payment workflow', data: { code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(organization.slug)}/products/${encodeURIComponent(snapshot.product_id)}/booking` } })
    const buyer = operator ? null : await ensureInteractionUser(event, env)
    const checkout = await createPaymentCheckout(db, env, {
      // A retry is held to the answers its purchase froze; it does not read them again.
      unit: 'slot', organizationId, buyerUserId: buyer?.id ?? null, buyer, productId: snapshot.product_id, variantId: snapshot.variant_id,
      sessionId, answers: null, requestId: threadId, requestFingerprint: await hashIdentifier(JSON.stringify({ guestName, guestEmail, phone: normalizedGuestPhone, notes })), quantity: partySize,
      idempotencyKey, previous: checkoutAttempt, following: () => [], origin: operator ? null : { request: event.req, pageEventId },
    })
    return creationResult({ success: true, status: 'checkout', replayed: true, ...checkout }, { status: 200 })
  }

  const translatedLocale = usesSourceLocale || (await assertPublicOrganizationLanguage(db, organizationId, locale)).source ? null : locale
  const product = offering
  if (!product || product.unit !== 'slot' || product.on_sale !== 1) return creationResult({ error: 'Product not found' }, { status: 404 })
  if (!operator && product.order_url) return creationResult({ error: 'Book this product on its configured external website.', external_url: product.order_url }, { status: 409 })
  // A restaurant calls a table's guest when plans change, so a table booking needs a phone number.
  if (product.kind === 'table' && !normalizedGuestPhone) return creationResult({ error: 'Please enter your phone number.' }, { status: 400 })

  const now = new Date().toISOString()
  if (!facts.timed) throw new Error('Validated timed selection is missing its booking facts')
  const terms = await timedBookingTerms(db, env, {
    ...selection, organizationId, productId: product.id, currency: organization.default_currency, actorId: operator?.userId ?? 'system', now,
  }, facts.timed)
  if (terms.failure) return terms.failure
  const { resolved, variant, config, price, requiresPayment, policy } = terms
  // Freeze the wording the guest answered before any seat claim or checkout.
  const questions = await localizeStoredFormQuestions(db, { kind: 'booking', organizationId, productId: product.id }, translatedLocale, config)
  const answers = validateFormAnswers(questions, { answers: body.answers, questionsRevision: body.questions_revision, revisionRequired: false })
  const session = resolved.session
  const productVariantId = variant.id
  const presentation = resolveBookingPresentation(product.kind, organization.vertical)
  if (requiresPayment && context.financialWritesAllowed === false) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'This booking requires online payment. Review the offering in the dashboard and complete its payment workflow before a booking can be created.', data: {
      code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(organization.slug)}/products/${encodeURIComponent(product.id)}/booking`,
    } })
  }

  const ipHash = await hashClientIp(getClientIp(event))
  const limited = !operator && await bookingRateLimit(db, env, ipHash)
  if (limited) return creationResult({ error: limited }, { status: 429 })

  const cancellation = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', threadId)
  const cancellationTokenHash = await hashReservationCancelToken(cancellation.token)
  // The person is the Better Auth user; what they typed stays on the thread as
  // this booking's guest snapshot and is never copied onto that user.
  const buyer = operator ? null : await ensureInteractionUser(event, env)
  const userId = buyer?.id ?? null

  const payload = threadPayloadForGuest({ name: guestName, email: guestEmail, phone: normalizedGuestPhone, locale, ipHash })
  // The booking's own message opens its conversation, stated where and when it is.
  if (!organization.vertical) throw new Error('The organization has no vertical')
  const opening = { note: notes, opening: openingSentence({ kind: 'booking', vertical: organization.vertical, productKind: product.kind, productTitle: product.name, partySizeIsMinimum: false, guestName, guestPhone: payload.guest.phone,
    answers, partySize, startsAt: session.starts_at, timezone: session.timezone, placeTitle: resolved.locationTitle }) }
  payload.provenance = { source: operator?.source ?? 'website', external_reference: operator?.externalReference ?? null, actor_user_id: operator?.userId ?? null,
    idempotency_key: idempotencyKey, fingerprint, guest_acknowledgement: operator?.guestAcknowledgement ?? true,
    creation_kind: requiresPayment ? 'checkout' : 'ordinary', creation_status: config.confirmation_mode === 'review' ? 'pending' : 'confirmed', followups_completed: false }
  payload.cancellation = { token_hash: cancellationTokenHash, expires_at: cancellation.expiresAt, used_at: null }

  if (requiresPayment) {
    const checkoutKey = idempotencyKey
    // Contact stays on the guest thread. A checkout thread waits on the guest;
    // the payment authorization saves its operational booking and activity.
    const checkout = await createPaymentCheckout(db, env, {
      unit: 'slot', organizationId, buyerUserId: userId, buyer, productId: product.id, variantId: productVariantId,
      sessionId: session.id, terms: { resolved, price, title: product.name, taxCode: product.tax_code }, answers, requestId: threadId, requestFingerprint: await hashIdentifier(JSON.stringify({ guestName, guestEmail, phone: normalizedGuestPhone, notes })), quantity: partySize, idempotencyKey: checkoutKey,
      previous: checkoutAttempt,
      origin: operator ? null : { request: event.req, pageEventId },
      following: paymentId => requestInsertQueries({
        kind: 'booking', id: threadId, organization_id: organizationId, location_id: session.location_id,
        user_id: userId, booking_id: null, payload, created_at: now,
      }, { query: "SELECT 1 FROM payment_checkout_holds WHERE payment_id = ? AND status = 'active'", params: [paymentId] }, opening),
    })
    return creationResult({ success: true, status: 'checkout', ...checkout }, { status: 201 })
  }

  let claim: Awaited<ReturnType<typeof claimSessionCapacity>>
  try {
    // The seat is claimed first, and the conversation is written only where
    // that claim landed: a claim that finds the session full inserts nothing
    // and raises nothing, so a conversation written ahead of it would commit
    // on its own. The conversation names the booking it is about.
    claim = await claimSessionCapacity(db, {
      env,
      organizationId: organization.id, productId: product.id, sessionId: session.id,
      productVariantId, partySize, userId, policyJson: JSON.stringify(policy), answers, resolved,
      // A guest's booking on the website keeps how they arrived; one a member makes has no source.
      websiteSource: operator ? null : await readWebsiteSource(db, organization.id, event.req, pageEventId),
      following: bookingId => [
        ...requestInsertQueries({
          kind: 'booking', id: threadId, organization_id: organization.id,
          location_id: session.location_id, user_id: userId, booking_id: bookingId,
          payload, created_at: now,
        }, { query: 'SELECT 1 FROM bookings WHERE id = ?', params: [bookingId] }, opening),
        {
          query: `UPDATE conversations SET payload_json = json_set(payload_json, '$.provenance.creation_status',
                    (SELECT status FROM bookings WHERE id = ?))
                  WHERE id = ? AND booking_id = ?`,
          params: [bookingId, threadId, bookingId],
        },
        // A booking that waits for the business's approval is its review task.
        ...conversationTaskQueries(threadId, now),
      ],
    })
  } catch (error) {
    // Nothing to roll back: the batch either applied whole or not at all.
    const existing = await replay()
    if (existing) return existing
    if (!(error instanceof CapacityUnavailableError)) throw error
    return creationResult({ error: 'This session just filled up. Please pick another time.', code: 'capacity_unavailable' }, { status: 409 })
  }

  const { bookingId: operationalBookingId, booking: record } = claim
  // One instant, one zone: the message the guest reads and the record the
  // host sees are formatted from the same session row.
  // Telling the owner and recording the conversion are independent, so both are
  // attempted before either failure is raised: running the notification first
  // meant a failed dispatch silently cost the tenant the conversion record too.
  // The measurement of a committed booking, quote included. The value the guest is shown is
  // snapshotted here, after the commit: a later price edit never revalues this booking or a retried
  // event, and a quote that cannot be resolved is a measurement failure reported beside the
  // committed booking, never a reason the booking was not made. Seats are priced per person, as the
  // product page states, so the quoted amount is unit price x seats. A variant with no offer has an
  // unknown value, not a zero one. A table booking is the provider-side 'reservation_submit'
  // conversion restaurants' Google Ads and GA4 already count, which carries no value.
  const recordBookingMeasurement = async () => {
    if (product.kind === 'table') {
      const recorded = await recordOrganizationConversionEvent(db, event.req, {
        organizationId: organization.id, eventName: 'reservation_submit', stage: 'submitted', surface: 'website',
        locationId: session.location_id, entityType: 'request', entityId: threadId, productId: product.id, variantId: productVariantId,
        pageType: 'reservations', routePath: '/reservations', originEventId: pageEventId,
      })
      return { ...recorded, quotedValue: null }
    }
    const quotedValue = {
      basis: 'quoted' as const,
      amount_minor: price.unit_amount * partySize,
      currency: price.currency,
      items: [{ item_id: product.id, item_name: product.name, item_variant: variant.name, amount_minor: price.unit_amount * partySize, quantity: partySize }],
    }
    const recorded = await recordOrganizationConversionEvent(db, event.req, {
      organizationId: organization.id, eventName: 'booking_submit', stage: 'submitted', surface: 'website',
      locationId: session.location_id, entityType: 'request', entityId: threadId,
      productId: product.id, variantId: productVariantId,
      pageType: 'product', routePath: `/products/${slug}`, value: quotedValue, originEventId: pageEventId,
    })
    return { ...recorded, quotedValue }
  }

  const followUps = await Promise.allSettled([
    publishEvent(env, { type: 'booking.created', organization_id: organization.id, conversation_id: threadId }),
    operator ? Promise.resolve({ recorded: false, reason: 'operator_creation', quotedValue: null })
      // A preview is the host looking at their own site, not a guest's conversion.
      : event.context.previewAuthorized === true ? Promise.resolve({ recorded: false, reason: 'preview', quotedValue: null })
      : recordBookingMeasurement(),
  ])
  // Only the owner notification can fail the request. Measurement is reported beside the
  // committed result: a guest told a confirmed submission failed would submit again.
  raiseSettledFailures('booking follow-up', `bookingId ${threadId}`, followUps.slice(0, 1),
    ['enqueue booking creation delivery'])
  const whenLabel = new Intl.DateTimeFormat(locale, { timeZone: record.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.starts_at)) + (record.location_id === null ? ` (${record.timezone})` : '')
  const measurement = measurementOutcome(followUps[1]!)
  const quotedValueOf = (result: PromiseSettledResult<unknown>) => result.status === 'fulfilled' ? (result.value as { quotedValue: unknown }).quotedValue : null

  return creationResult({
    success: true, conversation_id: threadId, booking_id: operationalBookingId, status: record.status, replayed: false, starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone, presentation, ...(operator ? {} : { cancellation_token: cancellation.token, quoted_value: quotedValueOf(followUps[1]!), measurement }),
    message: record.status === 'pending' ? `Your request for ${product.name} on ${whenLabel} is awaiting review.` : `Your ${presentation.noun} for ${product.name} on ${whenLabel} is confirmed.`,
    policy_summary: formatBookingPolicySummary(policy, locale, product.kind),
  }, { status: 201 })
}

function stayBookingError(statusCode: number, code: string, message: string, field: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code, field } })
}

/** Price an instant stay checkout or submit a request for the host to approve. */
async function createNightBooking(event: H3Event, env: CloudflareEnv, db: DbClient, context: BookingCreationContext, productId: string, contact: BookingContact,
  organization: Parameters<typeof lodgingBookingPolicy>[1], sourceLocale: string) {
  const { organizationId, slug, body } = context
  const { name, email, phone, notes, locale, idempotencyKey } = contact

  type SavedRequest = { id: string; conversation_id: string; user_id: string | null; fingerprint: string; followups_completed: number }
  const savedRequestQuery = {
    query: `SELECT b.id, r.id AS conversation_id, b.user_id, json_extract(r.payload_json, '$.provenance.fingerprint') AS fingerprint,
             json_extract(r.payload_json, '$.provenance.followups_completed') AS followups_completed
        FROM bookings b JOIN conversations r ON r.booking_id=b.id AND r.organization_id=b.organization_id AND r.kind='booking' AND r.user_id=b.user_id
       WHERE b.organization_id=? AND b.idempotency_key=? AND json_type(b.policy_json, '$.stay_request')='object'`,
    params: [organizationId, idempotencyKey],
  }
  const dates = { check_in_date: body.check_in_date, check_out_date: body.check_out_date }
  const currentPolicy = lodgingBookingPolicy(organizationId, organization)
  const quoteOptions = { checkInventory: currentPolicy.confirmation_mode === 'review' }
  const [homes, prices, saved, attempts, ...nights] = await executeBatch(db, [
    ...publicStayHomeQueries(organizationId, productId), savedRequestQuery, checkoutAttemptQuery(organizationId, idempotencyKey),
    ...stayQuoteNightQueries(organizationId, productId, dates, quoteOptions),
  ], { operation: 'Read stay checkout terms and saved purchase' })
  const home = publicStayHomeFrom(homes!, prices!)
  const request = { product_id: home.product_id, ...dates, adults: body.adults, children: body.children ?? 0, infants: body.infants ?? 0 }
  const fingerprint = await hashIdentifier(JSON.stringify({ slug, ...request, guest: { name, email, phone, notes }, answers: formAnswersFingerprint(body.answers) }))

  const requestResult = async (bookingId: string, conversationId: string, followupsCompleted: boolean, replayed: boolean) => {
    const current = await getThreadOperationalRecord(db, conversationId)
    if (!current || current.organization_id !== organizationId || current.id !== bookingId || !current.respond_by) {
      throw new Error('The stay request has no operational receipt')
    }
    const progress = stayRequestProgress(current)
    if (!followupsCompleted && progress.request_status === 'awaiting_approval') {
      await publishEvent(env, { type: 'booking.created', organization_id: organizationId, conversation_id: conversationId })
    }
    const message = current.status === 'cancelled' ? 'This stay request was cancelled.'
      : current.status === 'confirmed' ? 'Your stay is confirmed.'
        : progress.request_status === 'awaiting_payment' ? 'The host approved your request. Pay to confirm your stay.'
          : 'Your request was sent to the host.'
    return creationResult({
      success: true, status: current.status, booking_id: bookingId, conversation_id: conversationId, ...progress,
      activity_path: accountActivityPath('stay', conversationId), message, ...(replayed ? { replayed } : {}),
    }, { status: replayed ? 200 : 201 })
  }
  const replayRequest = async (saved: SavedRequest | undefined, buyerUserId?: string) => {
    if (!saved) return null
    const currentUserId = buyerUserId ?? (await getAuthSession(event, env))?.user.id
    if (!currentUserId || saved.user_id !== currentUserId || saved.fingerprint !== fingerprint) {
      stayBookingError(409, 'IDEMPOTENCY_CONFLICT', 'This request key belongs to a different stay request.', 'idempotency_key')
    }
    if (!saved.followups_completed) await publishStayRequest(db, env, organizationId, saved.id)
    return requestResult(saved.id, saved.conversation_id, saved.followups_completed === 1, true)
  }
  const existing = await replayRequest(saved!.results[0] as SavedRequest | undefined)
  if (existing) return existing
  const retrying = attempts!.results[0] as CheckoutAttempt | undefined
  const policy = retrying ? null : currentPolicy
  if (policy && (body.confirmation_mode !== undefined || policy.confirmation_mode === 'review') && body.confirmation_mode !== policy.confirmation_mode) {
    stayBookingError(409, 'STAY_BOOKING_MODE_CHANGED', 'Refresh this listing to see the host’s current booking settings.', 'confirmation_mode')
  }
  // A new checkout checks and freezes the answers with the purchase; a retry is
  // held to the purchase it froze, answers included, and does not read the
  // questions again (createPaymentCheckout reads `guest` only for a new checkout).
  const translatedLocale = !retrying && home.questions.length && locale !== sourceLocale ? locale : null
  const questions = retrying ? null : await localizeStoredFormQuestions(db, { kind: 'booking', organizationId, productId }, translatedLocale, home)
  const answers = questions ? validateFormAnswers(questions, { answers: body.answers, questionsRevision: body.questions_revision, revisionRequired: false }) : []
  const guest = { name, email, phone, notes, answers }
  // The quote's refusals name the rule a guest's choice breaks; they come before rate limits and payment setup.
  let priced: Awaited<ReturnType<typeof quoteStayAvailability>> | null = null
  let buyerUserId: string | undefined
  try {
    if (!retrying) priced = quoteStayAvailability(organizationId, home, request, nights, quoteOptions)
    const limited = !retrying && await bookingRateLimit(db, env, await hashClientIp(getClientIp(event)))
    if (limited) stayBookingError(429, 'RATE_LIMITED', limited, 'guest_email')
    if (policy?.confirmation_mode === 'review') {
      if (!priced?.channelAvailability) throw new Error('A new stay request needs its availability quote')
      const { quote, channelAvailability } = priced
      await requireStripeCheckoutAcceptance(db, env, organizationId)
      buyerUserId = (await ensureInteractionUser(event, env)).id
      const stay = await createStayRequest(db, env, {
        organizationId, buyerUserId, key: idempotencyKey, fingerprint,
        home, quote, policy: stayCheckoutPolicy(home.guestTerms, quote), channelAvailability, guest, locale, ipHash: await hashClientIp(getClientIp(event)),
        websiteSource: await readWebsiteSource(db, organizationId, event.req, readPageEventId(body.page_event_id)),
      })
      return requestResult(stay.id, stay.conversation_id, false, false)
    }
  } catch (error) {
    if (policy?.confirmation_mode === 'review' && error instanceof HTTPError && isRecord(error.data) && error.data.code === 'STAY_NIGHTS_UNAVAILABLE') {
      const raced = await replayRequest(await queryFirst<SavedRequest>(db, savedRequestQuery.query, savedRequestQuery.params), buyerUserId)
      if (raced) return raced
    }
    throw error
  }
  const stay = priced?.quote ?? { product_id: home.product_id, check_in_date: String(request.check_in_date), check_out_date: String(request.check_out_date), adults: Number(request.adults), children: Number(request.children), infants: Number(request.infants) }
  const buyer = await ensureInteractionUser(event, env)
  const checkout = await createPaymentCheckout(db, env, {
    unit: 'nights', organizationId, buyerUserId: buyer.id, buyer, requestId: null, requestFingerprint: fingerprint,
    quantity: stay.adults + stay.children, idempotencyKey, previous: retrying, following: () => [],
    origin: { request: event.req, pageEventId: readPageEventId(body.page_event_id) },
    stay, guest, ...(priced ? { terms: { ...priced, policy: stayCheckoutPolicy(home.guestTerms, priced.quote), taxCode: home.tax_code } } : {}),
  })
  return { body: { success: true, status: 'checkout', replayed: Boolean(retrying), ...checkout }, status: retrying ? 200 : 201 }
}

/** One booked record as `bookedRecordsInRange` reads it, with what was paid and whether the viewer has a seat in its guest conversation. */
export interface BookedRecordInRange {
  id: string
  organization_id: string
  organization_name: string
  vertical: string
  status: 'pending' | 'confirmed' | 'cancelled'
  unit: 'slot' | 'nights'
  product_id: string
  product_kind: ProductKind
  /** A home's own name (internal) for its business, its public name for its guest; an offering's name. */
  product_name: string
  product_session_id: string | null
  location_id: string | null
  location_title: string | null
  starts_at: string
  ends_at: string
  timezone: string
  party_size: number
  /** A stay's adults and children; a visit's are null. */
  adults: number | null
  children: number | null
  /** The guest said "this many or more". */
  party_size_is_minimum: number
  guest_name: string | null
  /** The guest's account picture, when they have one. */
  guest_image_url: string | null
  owner: 'app' | 'channel'
  channel: 'airbnb' | 'vrbo' | 'booking_com' | 'direct'
  /** A channel stay that landed on held nights. */
  overbooked: number
  total_minor: number | null
  currency: string | null
  /** Recorded payments and captured online payments, net of refunds, in the booking's currency. */
  paid_minor: number
  /** The offering's responsible member, and how the team names them. */
  assigned_member_id: string | null
  assigned_member_name: string | null
  conversation_id: string | null
  /** 1 when the viewer sits in the booking's guest conversation and so can open it. */
  viewer_seated: number
}

/**
 * The booked records a viewer hosts that overlap local days `from`..`to`, as
 * one statement for the caller's batch: an owner or admin hosts every one, a
 * member the slot bookings of the offerings they are named on. Instants are
 * read a day wider either side, because each record's day is its own zone's;
 * the caller keeps the days it shows. `pending` adds every request still
 * waiting for a decision that has not ended; `cancelled` keeps cancelled ones.
 * A `guest` read is the viewer's own visits and stays across businesses, as
 * their account shows them. Today, the Agenda, the host Calendar and the
 * bookings list read it.
 */
export function bookedRecordsInRange(viewer: ViewerTerms, range: { from: string; to: string; pending?: boolean; cancelled?: boolean; guest?: boolean; includeAssignedStays?: boolean; includeCalendarGrants?: boolean; includePayments?: boolean }): BatchQuery {
  const wideFrom = `${addLocalDays(range.from, -1)}T00:00:00.000Z`, wideTo = `${addLocalDays(range.to, 1)}T23:59:59.999Z`
  const assigned = `(${range.includeAssignedStays ? '1' : 'b.product_session_id IS NOT NULL'}
    AND ${assignedMemberSql('c', viewer.user)}${viewer.role ? ` AND ${roleMatchesSql(viewer.role, assignedOperationsRoles)}` : ''})`
  const known = `(${viewer.organizationWide} = 1 OR ${assigned}${viewer.role ? ` OR ${listingGrantSql('b.organization_id', 'b.product_id', viewer.member, 'details', viewer.role)}` : ''})`
  const calendar = range.includeCalendarGrants && viewer.role ? listingGrantSql('b.organization_id', 'b.product_id', viewer.member, 'calendar', viewer.role) : '0'
  const privateColumn = (expression: string) => range.guest ? expression : `CASE WHEN ${known} THEN ${expression} END`
  const paid = range.includePayments && viewer.role ? `CASE WHEN ${roleMatchesSql(viewer.role, workspaceManagementRoles)} THEN
    (SELECT COALESCE(SUM(o.amount_minor), 0) FROM offline_payments o WHERE o.organization_id = b.organization_id AND o.booking_id = b.id)
      + (SELECT COALESCE(SUM(pay.captured_amount - pay.refunded_amount), 0) FROM payments pay WHERE pay.organization_id = b.organization_id AND pay.subject_type = 'booking' AND pay.subject_id = b.id)
    ELSE 0 END` : '0'
  const whose = range.guest
    ? `r.user_id = ${viewer.user} AND ${CURRENT_GUEST_SQL('r')} AND (b.product_session_id IS NOT NULL OR (b.owner = 'app' AND b.user_id = r.user_id))`
    : `b.organization_id = ${viewer.organization} AND (${known} OR ${calendar})`
  return {
    query: `SELECT b.id, b.organization_id, org.name AS organization_name, org.vertical, b.status, CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS unit, b.product_id, p.kind AS product_kind,
        ${range.guest ? 'p.name' : 'COALESCE(sc.internal_name, p.name)'} AS product_name, b.product_session_id, COALESCE(b.location_id, sc.location_id) AS location_id, l.title AS location_title,
        b.starts_at, b.ends_at, b.timezone, b.party_size, b.adults, b.children, b.party_size_is_minimum, ${privateColumn("json_extract(r.payload_json, '$.guest.name')")} AS guest_name,
        ${privateColumn('(SELECT u.image FROM user u WHERE u.id = r.user_id)')} AS guest_image_url, b.owner, b.channel, b.overbooked, b.total_minor, org.default_currency AS currency,
        ${paid} AS paid_minor,
        c.assigned_member_id, (SELECT ${MEMBER_NAME_SQL} FROM member m JOIN user u ON u.id = m.userId LEFT JOIN member_scheduling ms ON ms.member_id = m.id AND ms.organization_id = m.organizationId
          WHERE m.id = c.assigned_member_id AND m.organizationId = b.organization_id) AS assigned_member_name, r.id AS conversation_id,
        ${conversationMemberSql('r', viewer.user)} AS viewer_seated
      FROM bookings b
      JOIN organization org ON org.id = b.organization_id
      JOIN products p ON p.organization_id = b.organization_id AND p.id = b.product_id
      LEFT JOIN product_booking_configs c ON c.organization_id = b.organization_id AND c.product_id = b.product_id
      LEFT JOIN product_stay_configs sc ON b.product_session_id IS NULL AND sc.organization_id = b.organization_id AND sc.product_id = b.product_id
      LEFT JOIN business_locations l ON l.organization_id = b.organization_id AND l.id = COALESCE(b.location_id, sc.location_id)
      LEFT JOIN conversations r ON r.organization_id = b.organization_id AND r.booking_id = b.id AND r.kind = 'booking'
     WHERE ${whose} ${range.cancelled ? '' : "AND b.status <> 'cancelled'"}
       AND ((b.starts_at <= ? AND b.ends_at >= ?)${range.pending ? " OR (b.status = 'pending' AND b.ends_at >= ?)" : ''})
     ORDER BY b.starts_at, b.id`,
    params: [wideTo, wideFrom, ...(range.pending ? [wideFrom] : [])],
  }
}
