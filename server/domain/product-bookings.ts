import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { planSourceMessages } from '~/server/domain/scheduled-guest-messages'
import { CapacityUnavailableError, claimSessionCapacity, paidQuantity, partyPaysOnline, partySizeRefusal, requireBookingConfig, resolveBookingSession, sessionAllocationPredicate } from '~/server/utils/availability'
import { cloudflareEnv, cleanString } from '~/server/utils/api-response'
import { isReservedTestDomain, shouldSendRealEmail } from '~/server/utils/email-delivery'
import { notifyBookingCreated, raiseSettledFailures } from '~/server/utils/notifications'
import { measurementOutcome, readPageEventId, recordOrganizationConversionEvent } from '~/server/utils/organization-conversions'
import { resolveLocationContact } from '~/server/utils/contact-resolution'
import { toE164 } from '~/utils/phone'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { bookingPolicy, formatBookingPolicySummary } from '~/server/utils/booking-policy-summary'
import { readTimedBookingPrice } from '~/server/domain/bookings'
import { isCurrencyCode } from '~/shared/currencies'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguage } from '~/server/utils/localization'
import { formatTenantLocalePath } from '~/utils/tenant-locale-path'
import { buildOwnerThreadInboxUrl } from '~/server/utils/dashboard-notification-links'
import { createReplayableReservationCancelToken, hashReservationCancelToken } from '~/server/utils/reservation-cancel-token'
import { ensureInteractionUser, getAuthSession, type CloudflareEnv } from '~/server/utils/auth'
import { bookingDay, getGuestRequest, getThreadOperationalRecord, requestInsertQueries, stayRequestProgress, threadPayloadForGuest, type BookingOperator } from '~/server/domain/requests'
import { conversationTaskQueries } from '~/server/domain/guest-threads/repository'
import { GUEST_NOTE_EVENT, openingSentence } from '~/server/domain/guest-threads/opening'
import { DEFAULT_EMAIL_DAILY_LIMIT as EMAIL_DAILY_LIMIT, DEFAULT_IP_HOURLY_LIMIT as IP_HOURLY_LIMIT, getClientIp, hashClientIp, hashIdentifier, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { HTTPError, type H3Event } from 'nitro'
import { createPaymentCheckout } from '~/server/domain/payments/checkout'
import { paidOnline } from '~/server/domain/payments'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { isRecord } from '~/server/utils/type-guards'
import { createStay, createStayRequest, publishStayRequest, pushStayHoldNights, quoteStay, readPublicStayHome, stayAccessFor, type StayQuote } from '~/server/domain/stays'
import { requireChannelPush } from '~/server/integrations/channex/ari'
import { readLodgingBookingPolicy } from '~/server/utils/lodging-booking-policy'
import { requireStripeCheckoutAcceptance } from '~/server/utils/stripe-connect'
import { accountActivityPath } from '~/shared/account-activity'
import { acceptFormAnswers } from '~/server/domain/form-questions'
import { formAnswerSnapshotsSchema, formAnswersFingerprint } from '~/shared/form-questions'
import type { ProductKind } from '~/shared/product-details'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'

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

async function bookingRateLimit(db: DbClient, env: CloudflareEnv, ipHash: string, email: string): Promise<string | null> {
  if (import.meta.dev || env.E2E_ALLOW_DEV_ROUTES === 'true') return null
  const now = Date.now()
  const hourWindow = Math.floor(now / 3_600_000)
  const today = new Date(now).toISOString().slice(0, 10)
  if (!await incrementHourlyRateLimit(db, `rate:book:ip:${ipHash}:${hourWindow}`, IP_HOURLY_LIMIT, 3_600_000)) {
    return 'Too many requests. Please try again later.'
  }
  if (!await incrementHourlyRateLimit(db, `rate:book:email:${await hashIdentifier(email)}:${today}`, EMAIL_DAILY_LIMIT, 86_400_000)) {
    return 'Too many booking requests from this email. Please try again tomorrow.'
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

function publicTimedOffering(db: DbClient, organizationId: string, slug: string, productId?: string) {
  return queryFirst<{ id: string; name: string; kind: ProductKind; order_url: string | null }>(db, `
    SELECT p.id, p.name, p.kind, p.order_url FROM products p
      JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
      JOIN product_booking_configs cfg ON cfg.product_id = p.id AND cfg.organization_id = p.organization_id AND cfg.unit = 'slot'
     WHERE pub.organization_id = ? AND pub.published = 1 AND p.slug = ? AND p.active = 1
       AND (? IS NULL OR p.id = ?) LIMIT 1
  `, [organizationId, slug, productId ?? null, productId ?? null])
}

async function timedBookingTerms(db: DbClient, env: CloudflareEnv, input: {
  organizationId: string; productId: string; sessionId: string; requestedVariantId: string | null
  partySize: number; currency: string; actorId: string; now: string
}) {
  const { organizationId, productId, requestedVariantId, partySize } = input
  const [resolved, config, variants] = await Promise.all([
    resolveBookingSession(db, { ...input, env }),
    requireBookingConfig(db, organizationId, productId),
    queryAll<{ id: string; name: string }>(db, 'SELECT id,name FROM product_variants WHERE product_id=? AND organization_id=? AND active=1', [productId, organizationId]),
  ])
  if (!variants.length) return { failure: creationResult({ error: 'This product has no bookable option' }, { status: 409 }) }
  if (!requestedVariantId && variants.length > 1) return { failure: creationResult({ error: 'Choose an option before booking' }, { status: 400 }) }
  const variant = requestedVariantId ? variants.find(candidate => candidate.id === requestedVariantId) : variants[0]
  if (!variant) return { failure: creationResult({ error: 'That option is not available for this product' }, { status: 400 }) }
  const partyRefusal = partySizeRefusal(config, partySize)
  if (partyRefusal) return { failure: creationResult({ error: partyRefusal, code: 'party_size_unavailable' }, { status: 400 }) }
  if (!isCurrencyCode(input.currency)) throw new Error(`Unsupported organization currency: ${input.currency}`)
  const price = await readTimedBookingPrice(db, { organizationId, variantId: variant.id, currency: input.currency, locationId: resolved.session.location_id, now: input.now })
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
  const [offering, organization] = await Promise.all([
    publicTimedOffering(db, input.organizationId, input.slug),
    queryFirst<{ default_currency: string }>(db, "SELECT default_currency FROM organization WHERE id=? AND status='active'", [input.organizationId]),
  ])
  if (!offering || !organization) throw new HTTPError({ statusCode: 404, message: 'Product not found' })
  if (offering.order_url) throw new HTTPError({ statusCode: 409, message: 'Book this product on its configured external website.', data: { external_url: offering.order_url } })
  const now = new Date().toISOString()
  const terms = await timedBookingTerms(db, env, { ...selection, organizationId: input.organizationId, productId: offering.id, currency: organization.default_currency, actorId: 'system', now })
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
export async function notifyProductBookingCreated(env: CloudflareEnv, db: DbClient, organizationId: string, requestId: string, cancellationToken?: string) {
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
  const sourceLocale = await getSourceLocale(db, organizationId)
  const locale = request.payload.guest.locale ?? sourceLocale
  // The guest's note is their message in the conversation.
  const note = await queryFirst<{ body: string | null }>(db, 'SELECT body FROM messages WHERE conversation_id = ? AND event_name = ?', [requestId, GUEST_NOTE_EVENT])
  const token = cancellationToken ?? (await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', requestId)).token
  const tokenMatches = await hashReservationCancelToken(token) === request.payload.cancellation.token_hash
  if (cancellationToken && !tokenMatches) throw new Error('Booking cancellation capability does not match its request')
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
  return creation.status
}

/** The authenticated member creates a booking through the selected offering's inventory. */
export async function createMemberBooking(event: H3Event, input: {
  principal: MemberAccessPrincipal; productId: string; body: Record<string, unknown>
  operator: Omit<BookingOperator, 'userId'>; financialWritesAllowed?: boolean
}) {
  const { principal, productId, body, operator } = input
  const { organizationId, userId, env } = principal
  const db = env.DB
  const product = await queryFirst<{ slug: string; unit: 'slot' | 'nights' }>(db, `SELECT p.slug, cfg.unit FROM products p
    JOIN product_booking_configs cfg ON cfg.product_id=p.id AND cfg.organization_id=p.organization_id
    WHERE p.organization_id=? AND p.id=?`, [organizationId, productId])
  if (!product) throw new HTTPError({ statusCode: 404, message: 'Bookable offering not found' })
  if (product.unit === 'nights') {
    const access = await stayAccessFor(principal)
    const stay = await createStay(db, env, access, { ...body, product_id: productId, idempotency_key: operator.idempotencyKey })
    return { kind: 'stay' as const, stay, status: 201 as const }
  }
  const result = await createProductBooking(event, {
    organizationId, slug: product.slug, productId, body,
    financialWritesAllowed: input.financialWritesAllowed, operator: { ...operator, userId },
  })
  return { kind: 'booking' as const, ...result }
}

/** Create a booking or hold using the offering's canonical inventory unit. */
export async function createProductBooking(event: H3Event, context: BookingCreationContext) {
  const { organizationId, slug, productId, body, operator } = context
  if (!organizationId || !slug) return creationResult({ error: 'Organization and slug are required' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return creationResult({ error: 'Database not available' }, { status: 500 })

  const [organization, offering] = await Promise.all([
    queryFirst<{ id: string; slug: string; default_currency: string; vertical: string | null }>(db, "SELECT id, slug, default_currency, vertical FROM organization WHERE id = ? AND status = 'active'", [organizationId]),
    queryFirst<{ kind: ProductKind }>(db, 'SELECT kind FROM products WHERE organization_id = ? AND slug = ? AND (? IS NULL OR id = ?)', [organizationId, slug, productId ?? null, productId ?? null]),
  ])
  const nights = offering?.kind === 'stay'
  if (!organization) {
    if (nights) stayBookingError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found', 'organization_id')
    return creationResult({ error: 'Organization not found' }, { status: 404 })
  }
  const locale = body.locale === undefined ? await getSourceLocale(db, organizationId) : assertExactCanonicalLocale(body.locale)
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
    return createNightBooking(event, env, db, context, { name: guestName, email: guestEmail, phone: normalizedGuestPhone, notes, locale, idempotencyKey })
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
      await notifyProductBookingCreated(env, db, organizationId, threadId)
      await db.prepare(`UPDATE conversations SET payload_json=json_set(payload_json,'$.provenance.followups_completed',json('true')) WHERE id=? AND organization_id=?`).bind(threadId, organizationId).run()
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

  const checkoutAttempt = await queryFirst<{ price_snapshot_json: string; fingerprint: string | null; party_size: number }>(db, `
    SELECT p.price_snapshot_json, json_extract(r.payload_json,'$.provenance.fingerprint') AS fingerprint, h.quantity AS party_size
    FROM payments p JOIN payment_checkout_holds h ON h.payment_id=p.id AND h.organization_id=p.organization_id
    JOIN conversations r ON r.id=h.conversation_id AND r.id=? AND r.organization_id=p.organization_id
    WHERE p.idempotency_key=? AND p.organization_id=?`, [threadId, `checkout:${organizationId}:${idempotencyKey}`, organizationId])
  if (checkoutAttempt) {
    if (checkoutAttempt.fingerprint !== fingerprint) return creationResult({ error: 'This key already identifies a different checkout request. Read its purchase before continuing.', code: 'idempotency_conflict' }, { status: 409 })
    const snapshot: unknown = JSON.parse(checkoutAttempt.price_snapshot_json)
    if (!isRecord(snapshot) || typeof snapshot.product_id !== 'string' || typeof snapshot.variant_id !== 'string'
      || snapshot.session_id !== sessionId || checkoutAttempt.party_size !== partySize || requestedVariantId && snapshot.variant_id !== requestedVariantId) {
      return creationResult({ error: 'Checkout retry does not match its saved purchase', code: 'idempotency_conflict' }, { status: 409 })
    }
    if (context.financialWritesAllowed === false) throw new HTTPError({ statusCode: 409, statusMessage: 'Continue this purchase through the business’s payment workflow', data: { code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(organization.slug)}/products/${encodeURIComponent(snapshot.product_id)}/booking` } })
    const checkout = await createPaymentCheckout(db, env, {
      // A retry is held to the answers its purchase froze; it does not read them again.
      unit: 'slot', organizationId, buyerUserId: operator ? null : await ensureInteractionUser(event, env), productId: snapshot.product_id, variantId: snapshot.variant_id,
      sessionId, answers: null, requestId: threadId, requestFingerprint: await hashIdentifier(JSON.stringify({ guestName, guestEmail, phone: normalizedGuestPhone, notes })), quantity: partySize,
      idempotencyKey, following: () => [], origin: operator ? null : { request: event.req, pageEventId },
    })
    return creationResult({ success: true, status: 'checkout', replayed: true, ...checkout }, { status: 200 })
  }

  await assertPublicOrganizationLanguage(db, organizationId, locale)
  const product = await publicTimedOffering(db, organizationId, slug, productId)
  if (!product) return creationResult({ error: 'Product not found' }, { status: 404 })
  if (!operator && product.order_url) return creationResult({ error: 'Book this product on its configured external website.', external_url: product.order_url }, { status: 409 })
  // A restaurant calls a table's guest when plans change, so a table booking needs a phone number.
  if (product.kind === 'table' && !normalizedGuestPhone) return creationResult({ error: 'Please enter your phone number.' }, { status: 400 })
  // The answers are checked and frozen here, before any seat or payment: a
  // checkout's thread carries them, and capture uses what was accepted now.
  const answers = await acceptFormAnswers(db, { kind: 'booking', organizationId, productId: product.id }, { locale, answers: body.answers, questionsRevision: body.questions_revision, revisionRequired: false })

  const now = new Date().toISOString()
  const terms = await timedBookingTerms(db, env, {
    ...selection, organizationId, productId: product.id, currency: organization.default_currency, actorId: operator?.userId ?? 'system', now,
  })
  if (terms.failure) return terms.failure
  const { resolved, variant, config, price, requiresPayment, policy } = terms
  const session = resolved.session
  const productVariantId = variant.id
  const presentation = resolveBookingPresentation(product.kind, organization.vertical)
  if (requiresPayment && context.financialWritesAllowed === false) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'This booking requires online payment. Review the offering in the dashboard and complete its payment workflow before a booking can be created.', data: {
      code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(organization.slug)}/products/${encodeURIComponent(product.id)}/booking`,
    } })
  }

  const ipHash = await hashClientIp(getClientIp(event))
  const limited = !operator && await bookingRateLimit(db, env, ipHash, guestEmail)
  if (limited) return creationResult({ error: limited }, { status: 429 })

  const cancellation = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', threadId)
  const cancellationTokenHash = await hashReservationCancelToken(cancellation.token)
  if (requiresPayment && !await hasOrganizationEntitlement(env,organizationId,'payments')) return creationResult({error:'Payments entitlement is required to collect online payment',code:'payment_required'}, {status:409})
  // The person is the Better Auth user; what they typed stays on the thread as
  // this booking's guest snapshot and is never copied onto that user.
  const userId = operator ? null : await ensureInteractionUser(event, env)

  const payload = threadPayloadForGuest({ name: guestName, email: guestEmail, phone: normalizedGuestPhone, locale, ipHash })
  // The booking's own message opens its conversation, stated where and when it is.
  const place = session.location_id === null ? null
    : await queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE id = ? AND organization_id = ?', [session.location_id, organizationId])
  if (session.location_id !== null && !place) throw new HTTPError({ statusCode: 404, message: 'The session location does not exist' })
  if (!organization.vertical) throw new Error('The organization has no vertical')
  const opening = { note: notes, opening: openingSentence({ kind: 'booking', vertical: organization.vertical, productKind: product.kind, productTitle: product.name, partySizeIsMinimum: false, guestName, guestPhone: payload.guest.phone,
    answers, partySize, startsAt: session.starts_at, timezone: session.timezone, placeTitle: place?.title ?? null }) }
  payload.provenance = { source: operator?.source ?? 'website', external_reference: operator?.externalReference ?? null, actor_user_id: operator?.userId ?? null,
    idempotency_key: idempotencyKey, fingerprint, guest_acknowledgement: operator?.guestAcknowledgement ?? true,
    creation_kind: requiresPayment ? 'checkout' : 'ordinary', creation_status: config.confirmation_mode === 'review' ? 'pending' : 'confirmed', followups_completed: false }
  payload.cancellation = { token_hash: cancellationTokenHash, expires_at: cancellation.expiresAt, used_at: null }

  if (requiresPayment) {
    const checkoutKey = idempotencyKey
    // Contact stays on the guest thread. A checkout thread waits on the guest;
    // authenticated capture alone creates its operational Booking and activity.
    const checkout = await createPaymentCheckout(db, env, {
      unit: 'slot', organizationId, buyerUserId: userId, productId: product.id, variantId: productVariantId,
      sessionId: session.id, resolved, answers, requestId: threadId, requestFingerprint: await hashIdentifier(JSON.stringify({ guestName, guestEmail, phone: normalizedGuestPhone, notes })), quantity: partySize, idempotencyKey: checkoutKey,
      origin: operator ? null : { request: event.req, pageEventId },
      following: paymentId => requestInsertQueries({
        kind: 'booking', id: threadId, organization_id: organizationId, location_id: session.location_id,
        user_id: userId, booking_id: null, payload, created_at: now,
      }, { query: "SELECT 1 FROM payment_checkout_holds WHERE payment_id = ? AND status = 'active'", params: [paymentId] }, opening),
    })
    return creationResult({ success: true, status: 'checkout', ...checkout }, { status: 201 })
  }

  let operationalBookingId: string
  try {
    // The seat is claimed first, and the conversation is written only where
    // that claim landed: a claim that finds the session full inserts nothing
    // and raises nothing, so a conversation written ahead of it would commit
    // on its own. The conversation names the booking it is about.
    const claim = await claimSessionCapacity(db, {
      env,
      organizationId: organization.id, productId: product.id, sessionId: session.id,
      productVariantId, partySize, userId, policyJson: JSON.stringify(policy), answers, resolved,
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
    operationalBookingId = claim.bookingId
  } catch (error) {
    // Nothing to roll back: the batch either applied whole or not at all.
    const existing = await replay()
    if (existing) return existing
    if (!(error instanceof CapacityUnavailableError)) throw error
    return creationResult({ error: 'This session just filled up. Please pick another time.', code: 'capacity_unavailable' }, { status: 409 })
  }

  if (!operationalBookingId) throw new Error('Booking allocation did not produce an operational ID')
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
    notifyProductBookingCreated(env, db, organization.id, threadId, cancellation.token),
    operator ? Promise.resolve({ recorded: false, reason: 'operator_creation', quotedValue: null })
      // A preview is the host looking at their own site, not a guest's conversion.
      : event.context.previewAuthorized === true ? Promise.resolve({ recorded: false, reason: 'preview', quotedValue: null })
      : recordBookingMeasurement(),
  ])
  // Only the owner notification can fail the request. Measurement is reported beside the
  // committed result: a guest told a confirmed submission failed would submit again.
  raiseSettledFailures('booking follow-up', `bookingId ${threadId}`, followUps.slice(0, 1),
    ['notifyProductBookingCreated'])
  await db.prepare(`UPDATE conversations SET payload_json = json_set(payload_json, '$.provenance.followups_completed', json('true')) WHERE id = ? AND organization_id = ?`).bind(threadId, organizationId).run()
  const record = await getThreadOperationalRecord(db, threadId)
  if (!record || record.organization_id !== organizationId || record.id !== operationalBookingId) throw new Error('Created booking is missing its operational receipt')
  if (!operator && record.status === 'cancelled') return creationResult({ error: 'This booking has already been cancelled', code: 'booking_cancelled', booking_id: record.id, conversation_id: threadId }, { status: 409 })
  const whenLabel = new Intl.DateTimeFormat(locale, { timeZone: record.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.starts_at)) + (record.location_id === null ? ` (${record.timezone})` : '')
  const measurement = measurementOutcome(followUps[1]!)
  const quotedValueOf = (result: PromiseSettledResult<unknown>) => result.status === 'fulfilled' ? (result.value as { quotedValue: unknown }).quotedValue : null

  return creationResult({
    success: true, conversation_id: threadId, booking_id: operationalBookingId, status: record.status, replayed: false, starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone, presentation, ...(operator ? {} : { cancellation_token: cancellation.token, quoted_value: quotedValueOf(followUps[1]!), measurement }),
    message: record.status === 'cancelled' ? 'This booking was cancelled.' : record.status === 'pending' ? `Your request for ${record.product_name} on ${whenLabel} is awaiting review.` : `Your ${presentation.noun} for ${record.product_name} on ${whenLabel} is confirmed.`,
    policy_summary: formatBookingPolicySummary(policy, locale, product.kind),
  }, { status: 201 })
}

function stayBookingError(statusCode: number, code: string, message: string, field: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code, field } })
}

/**
 * Book a place to stay on the site. The guest names the nights and the party;
 * the server quotes them against every rule the home offers and the guest pays
 * the full amount: the checkout holds the nights while they pay, the home's
 * channel closes them at once, and capture confirms the stay. A retry with the
 * same key returns the same checkout without quoting the nights it holds.
 */
async function createNightBooking(event: H3Event, env: CloudflareEnv, db: DbClient, context: BookingCreationContext, contact: BookingContact) {
  const { organizationId, slug, body } = context
  const { name, email, phone, notes, locale, idempotencyKey } = contact

  const home = await readPublicStayHome(db, organizationId, slug)
  const request = { product_id: home.product_id, check_in_date: body.check_in_date, check_out_date: body.check_out_date, adults: body.adults, children: body.children ?? 0, infants: body.infants ?? 0 }
  const fingerprint = await hashIdentifier(JSON.stringify({ slug, ...request, guest: { name, email, phone, notes }, answers: formAnswersFingerprint(body.answers) }))

  const requestResult = async (bookingId: string, conversationId: string, followupsCompleted: boolean, replayed: boolean) => {
    const current = await getThreadOperationalRecord(db, conversationId)
    if (!current || current.organization_id !== organizationId || current.id !== bookingId || !current.respond_by) {
      throw new Error('The stay request has no operational receipt')
    }
    const progress = stayRequestProgress(current)
    if (!followupsCompleted) {
      if (progress.request_status === 'awaiting_approval') {
        await notifyProductBookingCreated(env, db, organizationId, conversationId)
      }
      await execute(db, `UPDATE conversations SET payload_json=json_set(payload_json, '$.provenance.followups_completed', json('true'))
        WHERE organization_id=? AND id=? AND booking_id=?`, [organizationId, conversationId, bookingId])
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
  const replayRequest = async (buyerUserId?: string) => {
    const saved = await queryFirst<{ id: string; conversation_id: string; user_id: string | null; fingerprint: string; followups_completed: number }>(db, `
      SELECT b.id, r.id AS conversation_id, b.user_id, json_extract(r.payload_json, '$.provenance.fingerprint') AS fingerprint,
             json_extract(r.payload_json, '$.provenance.followups_completed') AS followups_completed
        FROM bookings b JOIN conversations r ON r.booking_id=b.id AND r.organization_id=b.organization_id AND r.kind='booking' AND r.user_id=b.user_id
       WHERE b.organization_id=? AND b.idempotency_key=? AND json_type(b.policy_json, '$.stay_request')='object'`, [organizationId, idempotencyKey])
    if (!saved) return null
    const currentUserId = buyerUserId ?? (await getAuthSession(event, env))?.user.id
    if (!currentUserId || saved.user_id !== currentUserId || saved.fingerprint !== fingerprint) {
      stayBookingError(409, 'IDEMPOTENCY_CONFLICT', 'This request key belongs to a different stay request.', 'idempotency_key')
    }
    if (!saved.followups_completed) await publishStayRequest(db, env, organizationId, saved.id)
    return requestResult(saved.id, saved.conversation_id, saved.followups_completed === 1, true)
  }
  const existing = await replayRequest()
  if (existing) return existing
  const retrying = await queryFirst(db, 'SELECT 1 FROM payments WHERE idempotency_key = ? AND organization_id = ?', [`checkout:${organizationId}:${idempotencyKey}`, organizationId])
  const policy = retrying ? null : await readLodgingBookingPolicy(db, organizationId)
  if (policy && (body.confirmation_mode !== undefined || policy.confirmation_mode === 'review') && body.confirmation_mode !== policy.confirmation_mode) {
    stayBookingError(409, 'STAY_BOOKING_MODE_CHANGED', 'Refresh this listing to see the host’s current booking settings.', 'confirmation_mode')
  }
  // A new checkout checks and freezes the answers with the purchase; a retry is
  // held to the purchase it froze, answers included, and does not read the
  // questions again (createPaymentCheckout reads `guest` only for a new checkout).
  const answers = retrying ? [] : await acceptFormAnswers(db, { kind: 'booking', organizationId, productId: home.product_id }, { locale, answers: body.answers, questionsRevision: body.questions_revision, revisionRequired: false })
  const guest = { name, email, phone, notes, answers }
  // The quote's refusals name the rule a guest's choice breaks; they come before rate limits and payment setup.
  let quoted: StayQuote | null = null
  let buyerUserId: string | undefined
  try {
    if (!retrying) quoted = await quoteStay(db, organizationId, home, request)
    const limited = !retrying && await bookingRateLimit(db, env, await hashClientIp(getClientIp(event)), email)
    if (limited) stayBookingError(429, 'RATE_LIMITED', limited, 'guest_email')
    await requireChannelPush(db, env, organizationId, home.product_id)
    if (policy?.confirmation_mode === 'review') {
      if (!quoted) throw new Error('A new stay request needs its quote')
      await requireStripeCheckoutAcceptance(db, env, organizationId)
      buyerUserId = await ensureInteractionUser(event, env)
      const stay = await createStayRequest(db, env, {
        organizationId, buyerUserId, key: idempotencyKey, fingerprint,
        home, quote: quoted, guest, locale, ipHash: await hashClientIp(getClientIp(event)),
      })
      return requestResult(stay.id, stay.conversation_id, false, false)
    }
  } catch (error) {
    if (policy?.confirmation_mode === 'review' && error instanceof HTTPError && isRecord(error.data) && error.data.code === 'STAY_NIGHTS_UNAVAILABLE') {
      const raced = await replayRequest(buyerUserId)
      if (raced) return raced
    }
    throw error
  }
  const quote = async () => quoted ?? await quoteStay(db, organizationId, home, request)
  const stay = quoted
    ? { product_id: quoted.product_id, check_in_date: quoted.check_in_date, check_out_date: quoted.check_out_date, adults: quoted.adults, children: quoted.children, infants: quoted.infants }
    : { product_id: home.product_id, check_in_date: String(request.check_in_date), check_out_date: String(request.check_out_date), adults: Number(request.adults), children: Number(request.children), infants: Number(request.infants) }
  const checkout = await createPaymentCheckout(db, env, {
    unit: 'nights', organizationId, buyerUserId: await ensureInteractionUser(event, env), requestId: null, requestFingerprint: fingerprint,
    quantity: stay.adults + stay.children, idempotencyKey, following: () => [],
    origin: { request: event.req, pageEventId: readPageEventId(body.page_event_id) },
    stay, guest, quote,
  })
  // The held nights close on the home's channel now, not when the payment lands.
  await pushStayHoldNights(db, env, organizationId, home.product_id, stay.check_in_date, stay.check_out_date)
  return { body: { success: true, status: 'checkout', replayed: Boolean(retrying), ...checkout }, status: retrying ? 200 : 201 }
}
