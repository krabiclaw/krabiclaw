import { refreshProductBusy } from '~/server/domain/member-scheduling'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { CapacityUnavailableError, claimSessionCapacity, requireBookingConfig } from '~/server/utils/availability'
import { cloudflareEnv, cleanString } from '~/server/utils/api-response'
import { isReservedTestDomain, shouldSendRealEmail } from '~/server/utils/email-delivery'
import { notifyBookingCreated, raiseSettledFailures } from '~/server/utils/notifications'
import { measurementOutcome, readPageEventId, recordOrganizationConversionEvent } from '~/server/utils/organization-conversions'
import { resolveLocationContact } from '~/server/utils/contact-resolution'
import { toE164 } from '~/utils/phone'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { productPolicySummarySource, renderBookingPolicySummary } from '~/server/utils/reservations'
import { getProduct, resolveVariantPrice } from '~/server/utils/product-management'
import { isCurrencyCode } from '~/shared/currencies'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguageEntitlement } from '~/server/utils/localization'
import { formatTenantLocalePath } from '~/utils/tenant-locale-path'
import { buildOwnerThreadInboxUrl } from '~/server/utils/dashboard-notification-links'
import { createReplayableReservationCancelToken, hashReservationCancelToken } from '~/server/utils/reservation-cancel-token'
import { ensureInteractionUser, type CloudflareEnv } from '~/server/utils/auth'
import { getGuestRequest, getThreadOperationalRecord, requestInsertQueries, threadPayloadForGuest, type BookingOperator } from '~/server/domain/requests'
import { DEFAULT_EMAIL_DAILY_LIMIT as EMAIL_DAILY_LIMIT, DEFAULT_IP_HOURLY_LIMIT as IP_HOURLY_LIMIT, getClientIp, hashClientIp, hashIdentifier, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { HTTPError, type H3Event } from 'nitro'
import { createPaymentCheckout } from '~/server/domain/payments/checkout'
import { paidOnline } from '~/server/domain/payments'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { isRecord } from '~/server/utils/type-guards'
import { pushStayHoldNights, quoteStay, readPublicStayHome, type StayQuote } from '~/server/domain/stays'
import { requireChannelPush } from '~/server/integrations/channex/ari'

export interface BookingCreationContext {
  organizationId: string
  slug: string
  body: Record<string, unknown>
  financialWritesAllowed?: boolean
  operator?: BookingOperator
}

function creationResult(body: Record<string, unknown>, options: { status: number }) { return { body, status: options.status } }

/** Creation delivery is shared by ordinary claims and authenticated Checkout conversion. */
export async function notifyProductBookingCreated(env: CloudflareEnv, db: DbClient, organizationId: string, requestId: string, cancellationToken?: string) {
  const [request, record, organization] = await Promise.all([
    getGuestRequest(db, requestId, organizationId, 'booking'),
    getThreadOperationalRecord(db, requestId),
    queryFirst<{ name: string | null; vertical: string | null; public_url: string | null }>(db, `SELECT name, vertical, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active') AS public_url FROM organization WHERE id = ?`, [organizationId]),
  ])
  if (!request || request.kind !== 'booking' || !record || record.kind !== 'booking' || record.organization_id !== organizationId || !record.product_id || !record.product_name || !organization) throw new Error('Booking creation delivery requires its canonical tenant, request and offering')
  const creation = await queryFirst<{ status: string }>(db, `SELECT json_extract(payload_json, '$.afterStatus') AS status FROM activity_entries WHERE request_id = ? AND event_name = 'booking.created' AND dedupe_key = ?`, [requestId, `booking:${record.id}:created`])
  if (creation?.status !== 'pending' && creation?.status !== 'confirmed') throw new Error('Booking creation status is missing or invalid')
  const sourceLocale = await getSourceLocale(db, organizationId)
  const locale = request.payload.guest.locale ?? sourceLocale
  const token = cancellationToken ?? (await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', requestId)).token
  const tokenMatches = await hashReservationCancelToken(token) === request.payload.cancellation.token_hash
  if (cancellationToken && !tokenMatches) throw new Error('Booking cancellation capability does not match its request')
  const receiptUrl = tokenMatches && organization.public_url
    ? `${organization.public_url.replace(/\/$/, '')}${formatTenantLocalePath('/bookings/confirmed', locale, sourceLocale)}?id=${requestId}#${token}`
    : null
  const [{ contactPhone, contactEmail }, ownerInboxUrl, paid] = await Promise.all([
    resolveLocationContact(db, organizationId, record.location_id),
    buildOwnerThreadInboxUrl(env, db, { organizationId, locationId: record.location_id ?? undefined, threadId: requestId }),
    paidOnline(db, organizationId, 'booking', record.id),
  ])
  const results = await Promise.allSettled([
    publishGuestInboxThreadEvent(env, db, { threadId: requestId, type: 'thread.created' }),
    notifyBookingCreated(env, db, {
      organizationId, organizationName: organization.name, vertical: organization.vertical, locationId: record.location_id,
      guestAcknowledgement: request.payload.provenance?.guest_acknowledgement ?? true,
      bookingId: requestId, status: creation.status, guestName: request.payload.guest.name,
      email: request.payload.guest.email, guestPhone: request.payload.guest.phone,
      productId: record.product_id, productTitle: record.product_name, startsAt: record.starts_at,
      timezone: record.timezone, partySize: record.party_size, notes: request.payload.notes,
      receiptUrl, paid, contactPhone, contactEmail, ownerInboxUrl, locale,
    }),
  ])
  raiseSettledFailures('booking creation delivery', `bookingId ${requestId}`, results)
  return creation.status
}

/**
 * Claim seats on a session.
 *
 * The guest names a SESSION, not a date and a time: the occurrence is a real
 * row, so there is nothing to re-derive and nothing to disagree about. The
 * claim carries its own capacity predicate, so this route does no
 * check-then-write — the insert either takes the seats or takes none.
 */
export async function createProductBooking(event: H3Event, context: BookingCreationContext) {
  const { organizationId, slug, body, operator } = context
  if (!organizationId || !slug) return creationResult({ error: 'organizationId and slug required' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return creationResult({ error: 'Database not available' }, { status: 500 })

  const organization = await queryFirst<{ id: string; slug: string; name: string | null; default_currency: string; vertical: string | null; public_url: string | null }>(db, `SELECT id, slug, name, default_currency, vertical, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active') AS public_url FROM organization WHERE id = ? AND status = 'active' LIMIT 1`, [organizationId])
  if (!organization) return creationResult({ error: 'Organization not found' }, { status: 404 })
  const locale = body.locale === undefined ? await getSourceLocale(db, organizationId) : assertExactCanonicalLocale(body.locale)

  const guestName = cleanString(body.guest_name, 100)
  const guestEmail = cleanString(body.guest_email, 254)
  const guestPhone = cleanString(body.guest_phone, 30)
  const normalizedGuestPhone = guestPhone ? toE164(guestPhone) : null
  if (guestPhone && !normalizedGuestPhone) return creationResult({ error: 'A valid phone number is required.' }, { status: 400 })
  const sessionId = cleanString(body.session_id, 64)
  const requestedVariantId = cleanString(body.variant_id, 64)
  const notes = cleanString(body.notes, 1000)
  const pageEventId = readPageEventId(body.page_event_id)
  const partySizeValue = typeof body.party_size === 'number' || typeof body.party_size === 'string' ? Number(body.party_size) : Number.NaN
  if (!Number.isInteger(partySizeValue) || partySizeValue < 1 || partySizeValue > 99) {
    return creationResult({ error: 'Party size must be a whole number between 1 and 99.' }, { status: 400 })
  }
  const partySize = partySizeValue

  if (!guestName) return creationResult({ error: 'Name is required' }, { status: 400 })
  if (!guestEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) return creationResult({ error: 'A valid email address is required' }, { status: 400 })
  // Reserved test domains (example.com and friends) hard-bounce and must never
  // be accepted where the environment sends real email.
  if (shouldSendRealEmail(env) && isReservedTestDomain(guestEmail)) return creationResult({ error: 'Please enter a real email address.' }, { status: 422 })
  if (!sessionId) return creationResult({ error: 'A session is required' }, { status: 400 })

  const idempotencyKey = operator?.idempotencyKey ?? (typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '')
  if (!idempotencyKey || idempotencyKey.length > 200) return creationResult({ error: 'A stable booking request key is required' }, { status: 400 })
  const threadId = await hashIdentifier(JSON.stringify(operator ? [organizationId, idempotencyKey] : ['website-booking', organizationId, idempotencyKey]))
  const fingerprint = await hashIdentifier(JSON.stringify({ slug, sessionId, requestedVariantId, partySize, guestName, guestEmail, phone: normalizedGuestPhone, notes, source: operator?.source ?? 'website', externalReference: operator?.externalReference ?? null, guestAcknowledgement: operator?.guestAcknowledgement ?? true }))
  const replay = async () => {
    const existing = await queryFirst<{ id: string; status: string; fingerprint: string | null; completed: number | null; creation_status: string | null; product_session_id: string; product_variant_id: string; party_size: number }>(db, `SELECT b.id, b.status, b.product_session_id, b.product_variant_id, b.party_size, json_extract(r.payload_json, '$.provenance.fingerprint') AS fingerprint, json_extract(r.payload_json, '$.provenance.followups_completed') AS completed, json_extract(r.payload_json, '$.provenance.creation_status') AS creation_status FROM bookings b JOIN requests r ON r.id = b.request_id WHERE b.organization_id = ? AND r.id = ?`, [organizationId, threadId])
    if (!existing) return null
    if (existing.fingerprint !== fingerprint) return creationResult({ error: 'Idempotency key was reused with different booking details', code: 'idempotency_conflict' }, { status: 409 })
    if (!existing.completed) {
      if (existing.status !== existing.creation_status || existing.product_session_id !== sessionId || (requestedVariantId && existing.product_variant_id !== requestedVariantId) || existing.party_size !== partySize) {
        return creationResult({ error: 'Booking changed before creation notifications completed. Read the current booking before continuing.', code: 'booking_changed', operational_booking_id: existing.id, request_id: threadId, status: existing.status }, { status: 409 })
      }
      await notifyProductBookingCreated(env, db, organizationId, threadId)
      await db.prepare(`UPDATE requests SET payload_json=json_set(payload_json,'$.provenance.followups_completed',json('true')) WHERE id=? AND organization_id=?`).bind(threadId, organizationId).run()
    }
    const record = await getThreadOperationalRecord(db, threadId)
    if (!record || record.kind !== 'booking' || record.organization_id !== organizationId || record.id !== existing.id) throw new Error('Committed booking is missing its operational receipt')
    if (!operator) {
      if (record.status !== 'pending' && record.status !== 'confirmed') return creationResult({ error: 'This booking has already been cancelled', code: 'booking_cancelled', operational_booking_id: record.id, request_id: threadId }, { status: 409 })
      const cancellation = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', threadId)
      const request = await getGuestRequest(db, threadId, organizationId, 'booking')
      if (!request || request.kind !== 'booking' || await hashReservationCancelToken(cancellation.token) !== request.payload.cancellation.token_hash) throw new Error('Booking receipt is missing its cancellation capability')
      return creationResult({ success: true, booking_id: threadId, request_id: threadId, operational_booking_id: record.id, status: record.status, replayed: true,
        starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone, cancellation_token: cancellation.token,
        message: record.status === 'pending' ? 'Your booking request is awaiting review.' : 'Your booking is confirmed.',
      }, { status: 200 })
    }
    return creationResult({ success: true, booking_id: threadId, request_id: threadId, operational_booking_id: record.id, status: record.status, replayed: true,
      starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone,
    }, { status: 200 })
  }
  const existing = await replay()
  if (existing) return existing

  const checkoutAttempt = await queryFirst<{ price_snapshot_json: string; fingerprint: string | null }>(db, `SELECT p.price_snapshot_json, json_extract(r.payload_json,'$.provenance.fingerprint') AS fingerprint
    FROM payment_attempts a JOIN payments p ON p.id=a.payment_id JOIN requests r ON r.id=? AND r.organization_id=p.organization_id
    WHERE a.idempotency_key=? AND p.organization_id=?`, [threadId, `checkout:${organizationId}:${idempotencyKey}`, organizationId])
  if (checkoutAttempt) {
    if (checkoutAttempt.fingerprint !== fingerprint) return creationResult({ error: 'This key already identifies a different checkout request. Read its purchase before continuing.', code: 'idempotency_conflict' }, { status: 409 })
    const snapshot: unknown = JSON.parse(checkoutAttempt.price_snapshot_json)
    if (!isRecord(snapshot) || typeof snapshot.product_id !== 'string' || typeof snapshot.variant_id !== 'string'
      || snapshot.session_id !== sessionId || snapshot.quantity !== partySize || requestedVariantId && snapshot.variant_id !== requestedVariantId) {
      return creationResult({ error: 'Checkout retry does not match its saved purchase', code: 'idempotency_conflict' }, { status: 409 })
    }
    if (context.financialWritesAllowed === false) throw new HTTPError({ statusCode: 409, statusMessage: 'Continue this purchase through the business’s payment workflow', data: { code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(organization.slug)}/products/${encodeURIComponent(snapshot.product_id)}/booking` } })
    if (!env.STRIPE_SECRET_KEY || !env.NUXT_PUBLIC_PLATFORM_DOMAIN) return creationResult({ error: 'Payments provider configuration is incomplete', code: 'payments_unavailable' }, { status: 503 })
    const checkout = await createPaymentCheckout(db, env, {
      subjectType: 'booking', organizationId, buyerUserId: operator ? null : await ensureInteractionUser(event, env), productId: snapshot.product_id, variantId: snapshot.variant_id,
      sessionId, requestId: threadId, requestFingerprint: await hashIdentifier(JSON.stringify({ guestName, guestEmail, phone: normalizedGuestPhone, notes })), quantity: partySize,
      idempotencyKey, following: () => [],
    })
    return creationResult({ success: true, status: 'checkout', replayed: true, ...checkout }, { status: 200 })
  }

  await assertPublicOrganizationLanguageEntitlement(env, db, organizationId, locale)
  const product = await queryFirst<{ id: string; name: string; order_url: string | null }>(db, `
    SELECT p.id, p.name, p.order_url FROM products p
      JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
      JOIN product_booking_configs cfg ON cfg.product_id = p.id
     WHERE pub.organization_id = ? AND pub.published = 1 AND p.slug = ? AND p.active = 1 LIMIT 1
  `, [organizationId, slug])
  if (!product) return creationResult({ error: 'Product not found' }, { status: 404 })
  if (!operator && product.order_url) return creationResult({ error: 'Book this product on its configured external website.', external_url: product.order_url }, { status: 409 })

  const session = await queryFirst<{ id: string; location_id: string | null; starts_at: string; ends_at: string; timezone: string }>(db, `
    SELECT s.id, s.location_id, s.starts_at, s.ends_at, s.timezone
      FROM product_sessions s
     WHERE s.id = ? AND s.product_id = ? AND s.organization_id = ? AND s.status = 'scheduled'
       -- A branch that has stopped selling this product does not take seats
       -- for it, whatever the site and the product itself still say.
       AND (s.location_id IS NULL OR EXISTS (
         SELECT 1 FROM product_locations pl
           JOIN business_locations l ON l.id = pl.location_id AND l.organization_id = ? AND l.status = 'active'
          WHERE pl.product_id = s.product_id AND pl.location_id = s.location_id
            AND pl.active = 1 AND pl.published = 1
       ))
  `, [sessionId, product.id, organization.id, organizationId])
  if (!session) return creationResult({ error: 'That session is not open for booking' }, { status: 404 })

  // What is being bought is a variant. Adult and child seats, or a class and
  // its private package, are different things at different prices, so the
  // guest's choice is carried here — never resolved by sort order. One active
  // variant is not a choice; several with none named is a request that cannot
  // be filled.
  const variants = await queryAll<{ id: string }>(db, `
    SELECT id FROM product_variants
     WHERE product_id = ? AND organization_id = ? AND active = 1
     ORDER BY sort_order, id
  `, [product.id, organization.id])
  if (variants.length === 0) return creationResult({ error: 'This product has no bookable option' }, { status: 409 })
  if (requestedVariantId && !variants.some(variant => variant.id === requestedVariantId)) {
    return creationResult({ error: 'That option is not available for this product' }, { status: 400 })
  }
  if (!requestedVariantId && variants.length > 1) {
    return creationResult({ error: 'Choose an option before booking' }, { status: 400 })
  }
  const productVariantId = requestedVariantId || variants[0]!.id

  const full = await getProduct(db, organization.id, product.id)
  const presentation = resolveBookingPresentation('booking', organization.vertical)
  const config = await requireBookingConfig(db, organization.id, product.id)
  if (!isCurrencyCode(organization.default_currency)) throw new Error(`Unsupported organization currency: ${organization.default_currency}`)
  const variant = full.variants.find(candidate => candidate.id === productVariantId)
  if (!variant) throw new Error('The selected variant is missing')
  const price = resolveVariantPrice(variant, { currency: organization.default_currency, location_id: session.location_id, at: new Date().toISOString() })
  if (!price || price.type !== 'one_time') return creationResult({ error: 'A current one-time price is required for this offering', code: 'price_unavailable' }, { status: 409 })
  const requiresPayment = config.online_payment_required && price.unit_amount > 0
  if (requiresPayment && context.financialWritesAllowed === false) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'This booking requires online payment. Review the offering in the dashboard and complete its payment workflow before a booking can be created.', data: {
      code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(organization.slug)}/products/${encodeURIComponent(product.id)}/booking`,
    } })
  }

  const clientIp = getClientIp(event)
  const ipHash = await hashClientIp(clientIp)
  const emailHash = await hashIdentifier(guestEmail)
  const e2eOverride = env.E2E_ALLOW_DEV_ROUTES === 'true'
  if (!operator && !import.meta.dev && !e2eOverride) {
    const hourWindow = Math.floor(Date.now() / 3_600_000)
    const today = new Date().toISOString().split('T')[0]
    if (!await incrementHourlyRateLimit(db, `rate:book:ip:${ipHash}:${hourWindow}`, IP_HOURLY_LIMIT, 3_600_000)) {
      return creationResult({ error: 'Too many requests. Please try again later.' }, { status: 429 })
    }
    if (!await incrementHourlyRateLimit(db, `rate:book:email:${emailHash}:${today}`, EMAIL_DAILY_LIMIT, 86_400_000)) {
      return creationResult({ error: 'Too many booking requests from this email. Please try again tomorrow.' }, { status: 429 })
    }
  }

  await refreshProductBusy(db, env, organization.id, product.id)
  const cancellation = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', threadId)
  const cancellationTokenHash = await hashReservationCancelToken(cancellation.token)
  if (requiresPayment && !await hasOrganizationEntitlement(env,organizationId,'payments')) return creationResult({error:'Payments entitlement is required to collect online payment',code:'payment_required'}, {status:409})
  if (requiresPayment && (!env.STRIPE_SECRET_KEY || !env.NUXT_PUBLIC_PLATFORM_DOMAIN)) return creationResult({error:'Payments provider configuration is incomplete',code:'payments_unavailable'},{status:503})
  // The person is the Better Auth user; what they typed stays on the thread as
  // this booking's guest snapshot and is never copied onto that user.
  const userId = operator ? null : await ensureInteractionUser(event, env)

  const now = new Date().toISOString()
  const payload = threadPayloadForGuest({ name: guestName, email: guestEmail, phone: normalizedGuestPhone, locale, notes, ipHash })
  payload.provenance = { source: operator?.source ?? 'website', external_reference: operator?.externalReference ?? null, actor_user_id: operator?.userId ?? null,
    idempotency_key: idempotencyKey, fingerprint, guest_acknowledgement: operator?.guestAcknowledgement ?? true,
    creation_kind: requiresPayment ? 'checkout' : 'ordinary', creation_status: config.confirmation_mode === 'review' ? 'pending' : 'confirmed', followups_completed: false }
  payload.cancellation = { token_hash: cancellationTokenHash, expires_at: cancellation.expiresAt, used_at: null }

  if (requiresPayment) {
    if (!env.STRIPE_SECRET_KEY || !env.NUXT_PUBLIC_PLATFORM_DOMAIN) return creationResult({ error: 'Payments provider configuration is incomplete', code: 'payments_unavailable' }, { status: 503 })
    const checkoutKey = idempotencyKey
    // Contact stays on the guest thread. A checkout thread waits on the guest;
    // authenticated capture alone creates its operational Booking and activity.
    const checkout = await createPaymentCheckout(db, env, {
      subjectType: 'booking', organizationId, buyerUserId: userId, productId: product.id, variantId: productVariantId,
      sessionId: session.id, requestId: threadId, requestFingerprint: await hashIdentifier(JSON.stringify({ guestName, guestEmail, phone: normalizedGuestPhone, notes })), quantity: partySize, idempotencyKey: checkoutKey,
     
      following: paymentId => requestInsertQueries({
        kind: 'booking', id: threadId, organization_id: organizationId, location_id: session.location_id,
        user_id: userId, review_id: null, conversation_state: 'waiting_on_guest', resolved_at: null,
        payload, created_at: now, updated_at: now,
      }, { query: "SELECT 1 FROM payment_checkout_holds WHERE payment_id = ? AND status = 'active'", params: [paymentId] }),
    })
    return creationResult({ success: true, status: 'checkout', ...checkout }, { status: 201 })
  }

  let operationalBookingId: string
  try {
    // The seat is claimed first, and the thread is written only where that
    // claim landed: a claim that finds the session full inserts nothing and
    // raises nothing, so a thread written ahead of it would commit on its own.
    // The booking takes its request id once the thread exists.
    const claim = await claimSessionCapacity(db, {
      organizationId: organization.id, productId: product.id, sessionId: session.id,
      productVariantId, partySize, userId, requestId: null,
      following: bookingId => [
        ...requestInsertQueries({
          kind: 'booking', id: threadId, organization_id: organization.id,
          location_id: session.location_id, user_id: userId, review_id: null,
          conversation_state: 'needs_attention', resolved_at: null, payload,
          created_at: now, updated_at: now,
        }, { query: 'SELECT 1 FROM bookings WHERE id = ?', params: [bookingId] }),
        {
          query: `UPDATE bookings SET request_id = ?, updated_at = ?
                   WHERE id = ? AND EXISTS (SELECT 1 FROM requests WHERE id = ?)`,
          params: [threadId, now, bookingId, threadId],
        },
        {
          query: `UPDATE requests SET payload_json = json_set(payload_json, '$.provenance.creation_status',
                    (SELECT status FROM bookings WHERE id = ?))
                  WHERE id = ? AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND request_id = requests.id)`,
          params: [bookingId, threadId, bookingId],
        },
        {
          query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, actor_user_id, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
                  SELECT ?, request_id, 'operation', 'request', ?, ?, 'booking.created',
                    json_object('operational_booking_id', id, 'request_id', request_id, 'afterStatus', status), ?,
                    COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id = bookings.request_id), 0) + 1, ?, ?
                  FROM bookings WHERE id = ? AND request_id IS NOT NULL`,
          params: [crypto.randomUUID(), operator ? 'member' : 'system', operator?.userId ?? null, `booking:${bookingId}:created`, now, now, bookingId],
        },
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
  // unknown value, not a zero one.
  const recordBookingMeasurement = async () => {
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
  await db.prepare(`UPDATE requests SET payload_json = json_set(payload_json, '$.provenance.followups_completed', json('true')) WHERE id = ? AND organization_id = ?`).bind(threadId, organizationId).run()
  const record = await getThreadOperationalRecord(db, threadId)
  if (!record || record.kind !== 'booking' || record.organization_id !== organizationId || record.id !== operationalBookingId) throw new Error('Created booking is missing its operational receipt')
  if (!operator && record.status === 'cancelled') return creationResult({ error: 'This booking has already been cancelled', code: 'booking_cancelled', operational_booking_id: record.id, request_id: threadId }, { status: 409 })
  const whenLabel = new Intl.DateTimeFormat(locale, { timeZone: record.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.starts_at)) + (record.location_id === null ? ` (${record.timezone})` : '')
  const measurement = measurementOutcome(followUps[1]!)
  const quotedValueOf = (result: PromiseSettledResult<unknown>) => result.status === 'fulfilled' ? (result.value as { quotedValue: unknown }).quotedValue : null

  return creationResult({
    success: true, booking_id: threadId, request_id: threadId, operational_booking_id: operationalBookingId, status: record.status, replayed: false, starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone, presentation, ...(operator ? {} : { cancellation_token: cancellation.token, quoted_value: quotedValueOf(followUps[1]!), measurement }),
    message: record.status === 'cancelled' ? 'This booking was cancelled.' : record.status === 'pending' ? `Your request for ${record.product_name} on ${whenLabel} is awaiting review.` : `Your ${presentation.noun} for ${record.product_name} on ${whenLabel} is confirmed.`,
    policy_summary: renderBookingPolicySummary(productPolicySummarySource(full.details), locale, full.kind),
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
export async function createStayBooking(event: H3Event, context: { organizationId: string; slug: string; body: Record<string, unknown> }) {
  const { organizationId, slug, body } = context
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 500, statusMessage: 'Database not available' })
  const organization = await queryFirst<{ id: string }>(db, "SELECT id FROM organization WHERE id = ? AND status = 'active'", [organizationId])
  if (!organization) stayBookingError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found', 'organization_id')
  if (body.locale !== undefined) assertExactCanonicalLocale(body.locale)

  const guestName = cleanString(body.guest_name, 100)
  const guestEmail = cleanString(body.guest_email, 254)
  const guestPhone = cleanString(body.guest_phone, 30)
  const notes = cleanString(body.notes, 1000)
  if (!guestName) stayBookingError(422, 'GUEST_NAME_REQUIRED', 'Name is required', 'guest_name')
  if (!guestEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) stayBookingError(422, 'GUEST_EMAIL_INVALID', 'A valid email address is required', 'guest_email')
  if (shouldSendRealEmail(env) && isReservedTestDomain(guestEmail)) stayBookingError(422, 'GUEST_EMAIL_INVALID', 'Please enter a real email address.', 'guest_email')
  const phone = guestPhone ? toE164(guestPhone) : null
  if (guestPhone && !phone) stayBookingError(422, 'GUEST_PHONE_INVALID', 'A valid phone number is required.', 'guest_phone')
  const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : ''
  if (!idempotencyKey || idempotencyKey.length > 200) stayBookingError(422, 'IDEMPOTENCY_KEY_REQUIRED', 'A stable booking request key is required', 'idempotency_key')

  const home = await readPublicStayHome(db, organizationId, slug)
  const request = { product_id: home.product_id, check_in_date: body.check_in_date, check_out_date: body.check_out_date, adults: body.adults, children: body.children ?? 0, infants: body.infants ?? 0 }
  const guest = { name: guestName, email: guestEmail, phone, notes }
  const fingerprint = await hashIdentifier(JSON.stringify({ slug, ...request, guest }))

  if (!env.STRIPE_SECRET_KEY || !env.NUXT_PUBLIC_PLATFORM_DOMAIN) stayBookingError(503, 'payments_unavailable', 'Payments provider configuration is incomplete', 'payments')
  const retrying = await queryFirst(db, 'SELECT 1 FROM payment_attempts a JOIN payments p ON p.id = a.payment_id WHERE a.idempotency_key = ? AND p.organization_id = ?', [`checkout:${organizationId}:${idempotencyKey}`, organizationId])
  // The quote's refusals name the rule a guest's choice breaks; they come before rate limits and payment setup.
  const quoted: StayQuote | null = retrying ? null : await quoteStay(db, organizationId, home, request)
  const quote = async () => quoted ?? await quoteStay(db, organizationId, home, request)
  if (!retrying) {
    const e2eOverride = env.E2E_ALLOW_DEV_ROUTES === 'true'
    if (!import.meta.dev && !e2eOverride) {
      const hourWindow = Math.floor(Date.now() / 3_600_000)
      const today = new Date().toISOString().split('T')[0]
      if (!await incrementHourlyRateLimit(db, `rate:book:ip:${await hashClientIp(getClientIp(event))}:${hourWindow}`, IP_HOURLY_LIMIT, 3_600_000)) stayBookingError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.', 'guest_email')
      if (!await incrementHourlyRateLimit(db, `rate:book:email:${await hashIdentifier(guestEmail)}:${today}`, EMAIL_DAILY_LIMIT, 86_400_000)) stayBookingError(429, 'RATE_LIMITED', 'Too many booking requests from this email. Please try again tomorrow.', 'guest_email')
    }
  }
  await requireChannelPush(db, env, organizationId, home.product_id)
  const stay = quoted
    ? { product_id: quoted.product_id, check_in_date: quoted.check_in_date, check_out_date: quoted.check_out_date, adults: quoted.adults, children: quoted.children, infants: quoted.infants }
    : { product_id: home.product_id, check_in_date: String(request.check_in_date), check_out_date: String(request.check_out_date), adults: Number(request.adults), children: Number(request.children), infants: Number(request.infants) }
  const checkout = await createPaymentCheckout(db, env, {
    subjectType: 'stay', organizationId, buyerUserId: await ensureInteractionUser(event, env), requestId: null, requestFingerprint: fingerprint,
    quantity: stay.adults + stay.children, idempotencyKey, following: () => [],
    stay, guest, quote,
  })
  // The held nights close on the home's channel now, not when the payment lands.
  await pushStayHoldNights(db, env, organizationId, home.product_id, stay.check_in_date, stay.check_out_date)
  return { body: { success: true, status: 'checkout', replayed: Boolean(retrying), ...checkout }, status: retrying ? 200 : 201 }
}
