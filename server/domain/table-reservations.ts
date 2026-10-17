import { getGuestRequest, getThreadOperationalRecord, requestInsertQueries, threadPayloadForGuest, type BookingOperator } from '~/server/domain/requests'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { execute, queryFirst, type DbClient } from '~/server/db'
import { cleanString, cloudflareEnv } from '~/server/utils/api-response'
import { isReservedTestDomain, shouldSendRealEmail } from '~/server/utils/email-delivery'
import { notifyReservationCreated, raiseSettledFailures } from '~/server/utils/notifications'
import { createReplayableReservationCancelToken, hashReservationCancelToken } from '~/server/utils/reservation-cancel-token'
import { resolveLocationContact } from '~/server/utils/contact-resolution'
import { resolveLocationTimezone, isDateBeforeTimezoneToday } from '~/server/utils/organization-config'
import {
  claimReservation,
  listReservationSlots,
  renderBookingPolicySummary,
  requireLocationReservationConfig,
  reservationPolicySummarySource,
  ReservationUnavailableError,
} from '~/server/utils/reservations'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguageEntitlement } from '~/server/utils/localization'
import { formatTenantLocalePath } from '~/utils/tenant-locale-path'
import { createPaymentCheckout } from '~/server/domain/payments/checkout'
import { isRecord } from '~/server/utils/type-guards'
import { ensureInteractionUser, type CloudflareEnv } from '~/server/utils/auth'
import { DEFAULT_EMAIL_DAILY_LIMIT as EMAIL_DAILY_LIMIT, DEFAULT_IP_HOURLY_LIMIT as IP_HOURLY_LIMIT, getClientIp, hashClientIp, hashIdentifier, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { parsePhone } from '~/utils/phone'
import { measurementOutcome, readPageEventId, recordOrganizationConversionEvent } from '~/server/utils/organization-conversions'
import { buildOwnerThreadInboxUrl } from '~/server/utils/dashboard-notification-links'
import { HTTPError, type H3Event } from 'nitro'
import { localNow } from '~/utils/timezone'

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function creationResult(body: Record<string, unknown>, options: { status: number }) { return { body, status: options.status } }

/** Delivery reads the confirmed reservation and its saved guest, including after payment capture. */
export async function notifyTableReservationCreated(env: CloudflareEnv, db: DbClient, organizationId: string, requestId: string) {
  const [request, record, organization] = await Promise.all([
    getGuestRequest(db, requestId, organizationId, 'reservation'), getThreadOperationalRecord(db, requestId),
    queryFirst<{ name: string; public_url: string | null }>(db, `SELECT name, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active') AS public_url FROM organization WHERE id = ?`, [organizationId]),
  ])
  if (!request || request.kind !== 'reservation' || !record || record.kind !== 'reservation' || record.organization_id !== organizationId || !record.location_id || !organization) throw new Error('Reservation delivery requires its saved guest, location and tenant')
  const creation = await queryFirst(db, "SELECT id FROM activity_entries WHERE request_id = ? AND event_name = 'reservation.created' AND dedupe_key = ?", [requestId, `reservation:${record.id}:created`])
  if (!creation) throw new Error('Reservation delivery has no confirmed creation receipt')
  const sourceLocale = await getSourceLocale(db, organizationId)
  const locale = request.payload.guest.locale ?? sourceLocale
  const cancellation = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', requestId)
  const matches = await hashReservationCancelToken(cancellation.token) === request.payload.cancellation.token_hash
  const cancelUrl = matches && organization.public_url ? `${organization.public_url.replace(/\/$/, '')}${formatTenantLocalePath('/reservations/cancel', locale, sourceLocale)}?id=${requestId}#${cancellation.token}` : env.NUXT_PUBLIC_PLATFORM_DOMAIN ? new URL('/account', env.NUXT_PUBLIC_PLATFORM_DOMAIN).toString() : null
  const [location, { contactPhone, contactEmail }, ownerInboxUrl] = await Promise.all([
    queryFirst<{ title: string }>(db, 'SELECT title FROM business_locations WHERE organization_id = ? AND id = ?', [organizationId, record.location_id]),
    resolveLocationContact(db, organizationId, record.location_id),
    buildOwnerThreadInboxUrl(env, db, { organizationId, locationId: record.location_id, threadId: requestId }),
  ])
  if (!location) throw new Error('Reservation delivery location is missing')
  const local = localNow(record.timezone, new Date(record.starts_at))
  const outcomes = await Promise.allSettled([
    publishGuestInboxThreadEvent(env, db, { threadId: requestId, type: 'thread.created' }),
    notifyReservationCreated(env, db, { organizationId, organizationName: organization.name, locationId: record.location_id, locationName: location.title,
      reservationId: requestId, guestAcknowledgement: request.payload.provenance?.guest_acknowledgement ?? true,
      guestName: request.payload.guest.name, email: request.payload.guest.email, phone: request.payload.guest.phone,
      date: local.date, time: local.time, guests: `${record.party_size}${request.payload.party_size_is_minimum ? '+' : ''}`, requests: request.payload.notes,
      cancelUrl, contactPhone, contactEmail, ownerInboxUrl, locale }),
  ])
  raiseSettledFailures('Reservation creation delivery', requestId, outcomes)
}

export async function createTableReservation(event: H3Event, input: {
  organizationId: string; body: Record<string, unknown>; operator?: BookingOperator; financialWritesAllowed?: boolean
}) {
  const { organizationId, body, operator } = input
  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return creationResult({ error: 'Database not available' }, { status: 503 })

  const name       = cleanString(body.name, 100)
  const email      = cleanString(body.email, 200)
  let phone = cleanString(body.phone, 30)
  if (phone) {
    const parsedPhone = parsePhone(phone)
    if (parsedPhone.valid && parsedPhone.e164) phone = parsedPhone.e164
    else return creationResult({ error: 'Please enter a valid phone number.' }, { status: 400 })
  }
  const date       = cleanString(body.date, 10)
  const time       = cleanString(body.time, 5)
  const guests     = cleanString(body.guests, 3)
  const requests   = cleanString(body.requests, 1000)
  const locationId = typeof body.location_id === 'string' ? body.location_id.trim() : null

  if (!name) return creationResult({ error: 'Please enter your name.' }, { status: 400 })
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return creationResult({ error: 'Please enter a valid email address.' }, { status: 400 })
  // Reserved test domains (example.com, wa-verify@example.com, etc.) are guaranteed to
  // hard-bounce and must never be accepted where the environment sends real email.
  if (shouldSendRealEmail(env) && isReservedTestDomain(email))
    return creationResult({ error: 'Please enter a real email address.' }, { status: 422 })
  if (!phone) return creationResult({ error: 'Please enter your phone number.' }, { status: 400 })
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return creationResult({ error: 'Please choose a valid future date.' }, { status: 400 })
  if (!time || !TIME_PATTERN.test(time))
    return creationResult({ error: 'Please choose a valid time.' }, { status: 400 })
  if (!Number.isSafeInteger(Number.parseInt(guests, 10)) || Number.parseInt(guests, 10) < 1 || Number.parseInt(guests, 10) > 99 || !/^\d{1,2}\+?$/.test(guests))
    return creationResult({ error: 'Please choose a valid party size.' }, { status: 400 })

  const organization = await queryFirst<{ id: string; slug: string; name?: string | null; public_url?: string | null }>(
    db, `SELECT id, slug, name, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active') AS public_url FROM organization WHERE id = ? AND status = ? LIMIT 1`, [organizationId, 'active'], )
  if (!organization) return creationResult({ error: 'Organization not found' }, { status: 404 })
  const locale = body.locale === undefined ? await getSourceLocale(db, organizationId) : assertExactCanonicalLocale(body.locale)
  const organizationBaseUrl = organization.public_url?.trim().replace(/\/$/, '')
  if (!organizationBaseUrl) return creationResult({ error: 'Organization public URL is not configured' }, { status: 500 })

  // Location is always required — there is no site shape where a reservation isn't tied to a
  // specific room/location, so this never silently falls back to a "primary" or first location.
  if (!locationId) return creationResult({ error: 'Please choose a location.' }, { status: 400 })
  const resolvedLocationId = locationId
  const partySize = Number.parseInt(guests, 10)
  const idempotencyKey = operator?.idempotencyKey ?? (typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '')
  if (!idempotencyKey || idempotencyKey.length > 200) return creationResult({ error: 'A stable reservation request key is required' }, { status: 400 })
  const id = await hashIdentifier(JSON.stringify([operator ? 'reservation' : 'website-reservation', organizationId, idempotencyKey]))
  const fingerprint = await hashIdentifier(JSON.stringify({ name, email, phone, date, time, guests, requests, locationId, source: operator?.source ?? 'website', externalReference: operator?.externalReference ?? null, guestAcknowledgement: operator?.guestAcknowledgement ?? true }))
  const replay = async () => {
    const row = await queryFirst<{ id: string; status: string; starts_at: string; ends_at: string; timezone: string; party_size: number; location_id: string; fingerprint: string | null; completed: number | null }>(db, `SELECT r.id,r.status,r.starts_at,r.ends_at,r.timezone,r.party_size,r.location_id, json_extract(t.payload_json, '$.provenance.fingerprint') AS fingerprint, json_extract(t.payload_json, '$.provenance.followups_completed') AS completed FROM reservations r JOIN requests t ON t.id = r.request_id AND t.organization_id = r.organization_id WHERE r.organization_id = ? AND t.id = ?`, [organizationId, id])
    if (!row) return null
    if (row.fingerprint !== fingerprint) return creationResult({ error: 'This idempotency key belongs to different reservation details', code: 'idempotency_conflict' }, { status: 409 })
    const recordedTime = localNow(row.timezone, new Date(row.starts_at))
    if (!row.completed && (row.status !== 'confirmed' || recordedTime.date !== date || recordedTime.time !== time || row.party_size !== partySize || row.location_id !== resolvedLocationId)) return creationResult({ error: 'Reservation changed before creation delivery completed', code: 'booking_changed', operational_reservation_id: row.id, request_id: id, status: row.status }, { status: 409 })
    if (!row.completed) {
      await notifyTableReservationCreated(env, db, organizationId, id)
      await execute(db, `UPDATE requests SET payload_json=json_set(payload_json,'$.provenance.followups_completed',json('true')) WHERE id=? AND organization_id=?`, [id, organizationId])
    }
    const cancellation = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', id)
    const request = await getGuestRequest(db, id, organizationId, 'reservation')
    if (!request || request.kind !== 'reservation') throw new HTTPError({ statusCode: 404, message: 'Reservation thread not found' })
    if (await hashReservationCancelToken(cancellation.token) !== request.payload.cancellation.token_hash) throw new Error('Reservation receipt is missing its cancellation capability')
    const record = await getThreadOperationalRecord(db, id)
    if (!record || record.kind !== 'reservation' || record.organization_id !== organizationId || record.id !== row.id) throw new HTTPError({ statusCode: 404, message: 'Reservation operational receipt not found' })
    if (!operator && record.status !== 'confirmed') return creationResult({ error: 'This reservation has already been cancelled', code: 'reservation_cancelled', operational_reservation_id: record.id, request_id: id }, { status: 409 })
    return creationResult({ success: true, id, request_id: id, operational_reservation_id: record.id, status: record.status, replayed: true,
      starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone, ...(operator ? {} : { cancellationToken: cancellation.token }),
    }, { status: 200 })
  }
  const completed = await replay()
  if (completed) return completed
  const checkoutAttempt = await queryFirst<{ price_snapshot_json: string; fingerprint: string | null }>(db, `SELECT p.price_snapshot_json, json_extract(r.payload_json, '$.provenance.fingerprint') AS fingerprint FROM payment_attempts a JOIN payments p ON p.id = a.payment_id JOIN requests r ON r.id = ? AND r.organization_id = p.organization_id WHERE a.idempotency_key = ? AND p.organization_id = ? AND p.subject_type = 'reservation'`, [id, `checkout:${organizationId}:${idempotencyKey}`, organizationId])
  if (checkoutAttempt) {
    if (checkoutAttempt.fingerprint !== fingerprint) return creationResult({ error: 'This idempotency key belongs to different reservation details', code: 'idempotency_conflict' }, { status: 409 })
    const snapshot: unknown = JSON.parse(checkoutAttempt.price_snapshot_json)
    if (!isRecord(snapshot) || !isRecord(snapshot.reservation) || snapshot.reservation.location_id !== resolvedLocationId || snapshot.reservation.party_size !== partySize
      || typeof snapshot.reservation.starts_at !== 'string' || typeof snapshot.reservation.ends_at !== 'string' || typeof snapshot.reservation.timezone !== 'string') throw new Error('Saved reservation checkout has invalid occurrence details')
    if (input.financialWritesAllowed === false) throw new HTTPError({ statusCode: 409, message: 'Continue this reservation through the business’s payment workflow', data: { code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(organization.slug)}/calendar/settings/availability/deposit?locationId=${encodeURIComponent(resolvedLocationId)}` } })
    if (!env.STRIPE_SECRET_KEY || !env.NUXT_PUBLIC_PLATFORM_DOMAIN) return creationResult({ error: 'Payments provider configuration is incomplete', code: 'payments_unavailable' }, { status: 503 })
    const checkout = await createPaymentCheckout(db, env, {
      subjectType: 'reservation', organizationId, buyerUserId: operator ? null : await ensureInteractionUser(event, env), locationId: resolvedLocationId,
      startsAt: snapshot.reservation.starts_at, endsAt: snapshot.reservation.ends_at, timezone: snapshot.reservation.timezone,
      requestId: id, requestFingerprint: fingerprint, quantity: partySize, idempotencyKey, returnOrigin: env.NUXT_PUBLIC_PLATFORM_DOMAIN, following: () => [],
    })
    return creationResult({ success: true, status: 'checkout', replayed: true, ...checkout }, { status: 200 })
  }
  await assertPublicOrganizationLanguageEntitlement(env, db, organizationId, locale)
  const policy = await requireLocationReservationConfig(db, { organizationId, locationId: resolvedLocationId })
  if (!Number.isSafeInteger(policy.duration_minutes) || !policy.duration_minutes || policy.duration_minutes < 1) return creationResult({ error: 'Set this location’s reservation duration before taking reservations', missing: ['duration_minutes'] }, { status: 409 })
  const requiresDeposit = policy.deposit_required && (policy.deposit_trigger_party_size === null || partySize >= policy.deposit_trigger_party_size)
  if (requiresDeposit && input.financialWritesAllowed === false) throw new HTTPError({ statusCode: 409, message: 'This reservation requires a deposit. Continue through the business’s payment workflow.', data: { code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(organization.slug)}/calendar/settings/availability/deposit?locationId=${encodeURIComponent(resolvedLocationId)}` } })

  const location = await queryFirst<{ title: string | null; opening_hours: string | null; max_capacity: number | null }>(
    db, 'SELECT title, opening_hours, max_capacity FROM business_locations WHERE id = ? AND organization_id = ? LIMIT 1', [resolvedLocationId, organizationId], )
  if (!location) return creationResult({ error: 'location_id must reference a location on this organization' }, { status: 400 })

  const reservationTimezone = await resolveLocationTimezone(db, organization.id, resolvedLocationId)
  if (isDateBeforeTimezoneToday(date, reservationTimezone))
    return creationResult({ error: 'Please choose a valid future date.' }, { status: 400 })

  const availability = await listReservationSlots(db, { organizationId: organization.id, locationId: resolvedLocationId, date })
  const slot = availability.slots.find(entry => entry.time_slot === time)
  if (!slot) return creationResult({ error: 'Please choose a valid time — this location is closed at that time.' }, { status: 400 })
  if (slot.is_closed) return creationResult({ error: 'This time is closed for booking.' }, { status: 409 })
  // An early answer so the form can say something useful. The claim below
  // carries its own predicate and is the authoritative one.
  if (slot.remaining !== null && partySize > slot.remaining) {
    return creationResult({ error: `Only ${Math.max(slot.remaining, 0)} spot(s) left at this time.`, code: 'capacity_unavailable' }, { status: 409 })
  }
  const reservationId = crypto.randomUUID()
  const clientIp = getClientIp(event)
  const ipHash = await hashClientIp(clientIp)
  const emailHash = await hashIdentifier(email)
  const cancellation = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', id)
  const cancellationTokenHash = await hashReservationCancelToken(cancellation.token)

  // Rate limiting (skipped in dev so local work and E2E can submit repeatedly) — runs before
  // the guest identity is established so a rate-limited request never mints one.
  const e2eOverride = env.E2E_ALLOW_DEV_ROUTES === 'true'
  if (!operator && !import.meta.dev && !e2eOverride) {
    const hourWindow = Math.floor(Date.now() / 3_600_000)
    const today = new Date().toISOString().split('T')[0]

    const ipOk = await incrementHourlyRateLimit(db, `rate:reservation:ip:${ipHash}:${hourWindow}`, IP_HOURLY_LIMIT, 3_600_000)
    if (!ipOk) return creationResult({ error: 'Too many requests. Please try again later.' }, { status: 429 })

    const emailOk = await incrementHourlyRateLimit(db, `rate:reservation:email:${emailHash}:${today}`, EMAIL_DAILY_LIMIT, 86_400_000)
    if (!emailOk) return creationResult({ error: 'Too many reservation requests from this email. Please try again tomorrow.' }, { status: 429 })
  }

  // The person is the Better Auth user; what they typed stays on the thread as
  // this reservation's guest snapshot and is never copied onto that user.
  const userId = operator ? null : await ensureInteractionUser(event, env)

  const now = new Date().toISOString()
  const payload = threadPayloadForGuest({ name, email, phone, locale, notes: requests, ipHash, partySizeIsMinimum: guests.endsWith('+') })
  payload.provenance = { source: operator?.source ?? 'website', external_reference: operator?.externalReference ?? null, actor_user_id: operator?.userId ?? null,
    idempotency_key: idempotencyKey, fingerprint, guest_acknowledgement: operator?.guestAcknowledgement ?? true, creation_kind: requiresDeposit ? 'checkout' : 'ordinary', creation_status: 'confirmed', followups_completed: false }
  payload.cancellation = { token_hash: cancellationTokenHash, expires_at: cancellation.expiresAt, used_at: null }

  if (requiresDeposit) {
    if (!env.STRIPE_SECRET_KEY || !env.NUXT_PUBLIC_PLATFORM_DOMAIN) return creationResult({ error: 'Payments provider configuration is incomplete', code: 'payments_unavailable' }, { status: 503 })
    if (!slot) throw new Error('Reservation checkout has no selected time')
    const checkout = await createPaymentCheckout(db, env, {
      subjectType: 'reservation', organizationId, buyerUserId: userId, locationId: resolvedLocationId, startsAt: slot.starts_at,
      endsAt: new Date(Date.parse(slot.starts_at) + policy.duration_minutes! * 60_000).toISOString(), timezone: availability.timezone,
      requestId: id, requestFingerprint: fingerprint, quantity: partySize, idempotencyKey, returnOrigin: env.NUXT_PUBLIC_PLATFORM_DOMAIN,
      following: paymentId => requestInsertQueries({ id, kind: 'reservation', organization_id: organizationId, location_id: resolvedLocationId,
        user_id: userId, review_id: null, conversation_state: 'waiting_on_guest', resolved_at: null, payload, created_at: now, updated_at: now,
      }, { query: "SELECT 1 FROM payment_checkout_holds WHERE payment_id = ? AND status = 'active'", params: [paymentId] }),
    })
    return creationResult({ success: true, status: 'checkout', ...checkout }, { status: 201 })
  }

  // The reservation and its inbox thread commit in one batch, the thread
  // conditional on the claim: the claim's capacity predicate decides whether
  // the table is there, and nothing is left behind if it is not.
  try {
    await claimReservation(db, {
      organizationId: organization.id, locationId: resolvedLocationId,
      reservationId, requestId: id, userId,
      timezone: availability.timezone, startsAt: slot.starts_at,
      date, timeSlot: slot.time_slot,
      endsAt: new Date(Date.parse(slot.starts_at) + policy.duration_minutes! * 60_000).toISOString(),
      partySize,
      thread: [...requestInsertQueries({
        id, kind: 'reservation', organization_id: organization.id,
        location_id: resolvedLocationId, user_id: userId, review_id: null,
        conversation_state: 'needs_attention', resolved_at: null, payload, created_at: now, updated_at: now,
      }, { query: 'SELECT 1 FROM reservations WHERE id = ?', params: [reservationId] }), {
        query: `INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, actor_user_id, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
          SELECT ?, ?, 'operation', 'request', ?, ?, 'reservation.created', json_object('operational_reservation_id', id, 'afterStatus', status), ?,
            COALESCE((SELECT MAX(sequence) FROM activity_entries WHERE request_id = ?), 0) + 1, ?, ? FROM reservations WHERE id = ? AND EXISTS (SELECT 1 FROM requests WHERE id = ?)`,
        params: [crypto.randomUUID(), id, operator ? 'member' : 'system', operator?.userId ?? null, `reservation:${reservationId}:created`, id, now, now, reservationId, id],
      }],
    })
  } catch (error) {
    const completed = await replay()
    if (completed) return completed
    if (!(error instanceof ReservationUnavailableError)) throw error
    return creationResult({ error: 'This time is no longer available. Please choose another time.', code: 'capacity_unavailable' }, { status: 409 })
  }
  // Telling the owner and recording the conversion are independent, so both are
  // attempted before either failure is raised.
  const followUps = await Promise.allSettled([
    notifyTableReservationCreated(env, db, organizationId, id),
    operator ? Promise.resolve({ recorded: false, reason: 'operator_creation' }) : recordOrganizationConversionEvent(db, event.req, {
      organizationId: organization.id,
      eventName: 'reservation_submit',
      stage: 'submitted',
      surface: 'website',
      locationId: resolvedLocationId,
      entityType: 'request',
      entityId: id,
      pageType: 'reservations',
      routePath: '/reservations',
      originEventId: readPageEventId(body.page_event_id),
    }),
  ])
  // Only the owner notification can fail the request. Measurement is reported beside the
  // committed result: a guest told a confirmed submission failed would submit again.
  raiseSettledFailures('reservation follow-up', `reservationId ${id}`, followUps.slice(0, 1),
    ['notifyReservationCreated'])
  await execute(db, `UPDATE requests SET payload_json = json_set(payload_json, '$.provenance.followups_completed', json('true')) WHERE id = ? AND organization_id = ?`, [id, organizationId])
  const measurement = measurementOutcome(followUps[1]!)
  const record = await getThreadOperationalRecord(db, id)
  if (!record || record.kind !== 'reservation' || record.organization_id !== organizationId || record.id !== reservationId) throw new HTTPError({ statusCode: 404, message: 'Reservation operational receipt not found' })

  return creationResult({
    success: true, id, request_id: id, operational_reservation_id: record.id, status: record.status, starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone,
    replayed: false, ...(operator ? {} : { measurement, cancellationToken: cancellation.token }), message: record.status === 'cancelled' ? 'This reservation was cancelled.' : 'Your reservation is confirmed.', policy_summary: renderBookingPolicySummary(reservationPolicySummarySource(policy), locale), }, { status: 201 })
}
