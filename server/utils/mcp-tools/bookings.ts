import { paginationInputSchema, pageInfoObject, organizationTool, PHONE_FORMAT, type McpToolDefinition } from './shared'
import { PRODUCT_KINDS } from '~/shared/product-details'
import { HTTPError } from 'nitro'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { assertResourceAccess, assertProductAccess, assertAssignedBookingAccess, assignedMemberSql, roleAllows, memberAccessPrincipal } from '~/server/utils/member-access'
import { queryAll, queryFirst } from '~/server/db'
import { createSession, listSessions, requireBookingConfig, updateSession } from '~/server/utils/availability'
import { mcpPageInfo, mcpPageWindow, paginateMcpCollection } from '~/server/utils/mcp-pagination'
import { createProductBooking } from '~/server/domain/product-bookings'
import { BOOKING_ENDS_SQL, BOOKING_STARTS_SQL, getGuestRequest, getThreadOperationalRecord, isBookingDay, type ThreadOperationalRecord, type ThreadPayload } from '~/server/domain/requests'
import { localDateAt } from '~/utils/timezone'
import { stayGuestFirstName } from '~/shared/bookings'
import { cancelStay, getStay, stayAccessFor } from '~/server/domain/stays'
import { stayDetail, stayTurnover } from './stays'
import { CHANNEL_PUSH_SCHEMA } from '~/shared/channel-push'
import { executeGuestThreadOperation } from '~/server/domain/guest-threads/operations'
import { moveBooking, requestBookingChange } from '~/server/domain/guest-threads/booking-changes'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { NOT_HANDLED, requiredString, optionalString, type McpExecutorContext } from './execution'
import { BOOKING_STATUSES, isBookingComplete, type BookingStatus } from '~/shared/bookings'
import { formAnswerInputJsonSchema, formAnswerSnapshotsJsonSchema, formAnswerSnapshotsSchema } from '~/shared/form-questions'

const key = { type: 'string', minLength: 1, maxLength: 200, description: 'Caller-supplied durable idempotency key. Reuse only for the identical operation.' }
const bookingId = { type: 'string', description: 'Booking ID returned by list_product_bookings or create_product_booking. Distinct from conversation_id, which identifies the inbox conversation.' }
const text = { type: 'string', minLength: 1 }
const nullableText = { type: ['string', 'null'] }
const guest = { type: 'object', properties: { name: text, email: text, phone: nullableText }, required: ['name', 'email'] }
const answersInput = formAnswerInputJsonSchema()
const questionsRevision = { type: 'string', description: 'The questions_revision the answers were collected against. Required with answers; a changed revision returns questions_changed with the current questions.' }
const productKind = { type: 'string', enum: [...PRODUCT_KINDS], description: 'What was booked: an experience, a consultation (service) or a restaurant table.' }
const record = { type: 'object', properties: { id: text, kind: { type: 'string', enum: ['booking'] }, status: { type: 'string', enum: [...BOOKING_STATUSES] }, party_size: { type: 'integer', minimum: 1 }, starts_at: text, ends_at: text, timezone: text, assigned_member_id: nullableText, location_id: nullableText, product_id: nullableText, product_kind: productKind, product_name: nullableText }, required: ['id', 'kind', 'status', 'party_size', 'starts_at', 'ends_at', 'timezone', 'assigned_member_id', 'location_id', 'product_id', 'product_kind', 'product_name'] }
const booking = { type: 'object', properties: { booking_id: text, conversation_id: nullableText, product_id: text, product_kind: productKind, product_variant_id: nullableText, product_session_id: { ...nullableText, description: 'The session a slot booking holds; null for a stay, which holds nights.' }, unit: { type: 'string', enum: ['slot', 'nights'], description: 'What the booking holds: a session\'s places (slot) or a home\'s nights (nights).' }, status: { type: 'string', enum: [...BOOKING_STATUSES] }, is_complete: { type: 'boolean' }, party_size: { type: 'integer' }, updated_at: text, assigned_member_id: nullableText, location_id: nullableText, starts_at: text, ends_at: text, timezone: text, guest: { type: ['object', 'null'], properties: { name: nullableText }, required: ['name'], additionalProperties: false }, provenance: { type: ['object', 'null'], properties: { source: text, external_reference: nullableText, guest_acknowledgement: { type: 'boolean' } }, required: ['source', 'external_reference', 'guest_acknowledgement'] } }, required: ['booking_id', 'conversation_id', 'product_id', 'product_kind', 'product_variant_id', 'product_session_id', 'unit', 'status', 'is_complete', 'party_size', 'updated_at', 'assigned_member_id', 'location_id', 'starts_at', 'ends_at', 'timezone', 'guest', 'provenance'] }
const session = { type: 'object', properties: { id: text, organization_id: text, product_id: text, location_id: nullableText, timezone: text, starts_at: text, ends_at: text, updated_at: text, capacity: { type: ['integer', 'null'] }, status: text, claimed: { type: 'integer' }, remaining: { type: ['integer', 'null'] }, is_full: { type: 'boolean' } }, required: ['id', 'organization_id', 'product_id', 'location_id', 'starts_at', 'ends_at', 'timezone', 'capacity', 'status', 'claimed', 'remaining', 'is_full', 'updated_at'] }
const operationResult = { type: 'object', properties: { ok: { const: true }, status: { const: 200 }, conversation_id: text, record, available_actions: { type: 'array', items: text }, thread: { type: 'object', properties: { id: text, kind: { type: 'string', enum: ['booking'] } }, required: ['id', 'kind'] } }, required: ['ok', 'status', 'conversation_id', 'record', 'available_actions', 'thread'] }
const nightsCancelResult = { type: 'object', properties: { booking_id: text, unit: { const: 'nights' }, status: { const: 'cancelled' }, version: { type: 'integer' }, cancelled_at: text, cancellation_reason: nullableText, channel_push: { ...CHANNEL_PUSH_SCHEMA } }, required: ['booking_id', 'unit', 'status', 'version', 'cancelled_at', 'cancellation_reason', 'channel_push'], additionalProperties: false }
const changeResult = { type: 'object', properties: { success: { const: true }, conversation_id: text, change_status: { type: 'string', enum: ['awaiting_guest_acceptance', 'accepted', 'declined', 'moved'] }, record }, required: ['success', 'conversation_id', 'change_status', 'record'] }

function mcpBookingRecord(record: ThreadOperationalRecord) {
  const { id, status, party_size, starts_at, ends_at, timezone, assigned_member_id, location_id, product_id, product_kind, product_name } = record
  return { id, kind: 'booking' as const, status, party_size, starts_at, ends_at, timezone, assigned_member_id, location_id, product_id, product_kind, product_name }
}

function mcpBookingProvenance(provenance: ThreadPayload['provenance'] | null) {
  return provenance ? { source: provenance.source, external_reference: provenance.external_reference, guest_acknowledgement: provenance.guest_acknowledgement } : null
}

export const BOOKINGS_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'create_product_session', domain: 'bookings', minimumRole: 'member', description: 'Add a dated time at a location for an existing bookable offering using its actual start and end. Online offerings take no dated sessions: they are booked in their provider\'s working hours. A restaurant\'s tables take none either: they are seated through their location\'s opening hours.',
    inputSchema: { product_id: text, location_id: { ...text, description: 'Session location.' }, starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' }, capacity: { type: ['integer', 'null'], minimum: 0 }, idempotency_key: key }, required: ['product_id', 'location_id', 'starts_at', 'ends_at', 'idempotency_key'],
    outputSchema: { type: 'object', properties: { sessions: { type: 'array', items: session, minItems: 1 } }, required: ['sessions'] },
  }),
  organizationTool({ name: 'update_product_session', domain: 'bookings', minimumRole: 'member', description: 'Edit one session’s time, capacity or state using its current timestamp. Committed bookings or checkout holds prevent time or state changes; use the guest booking-change workflow. A restaurant table\'s seatings are not edited one by one: change its location\'s hours, special hours or closures.',
    inputSchema: { anyOf: [{ required: ['starts_at'] }, { required: ['ends_at'] }, { required: ['capacity'] }, { required: ['status'] }], product_id: text, product_session_id: text, updated_at: { ...text, description: 'Session updated_at from list_product_booking_sessions.' }, starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' }, capacity: { type: ['integer', 'null'], minimum: 0 }, status: { type: 'string', enum: ['scheduled', 'cancelled'] } }, required: ['product_id', 'product_session_id', 'updated_at'],
    outputSchema: { type: 'object', properties: { session }, required: ['session'] },
  }),

  organizationTool({ name: 'list_product_booking_sessions', outputSchema: { type: 'object', properties: { sessions: { type: 'array', items: session }, page_info: pageInfoObject }, required: ['sessions', 'page_info'] }, domain: 'bookings', minimumRole: 'member', description: 'Read scheduled times and remaining places for a product, including shared calendar conflicts. Choose a returned session ID to create or change a booking.',
    inputSchema: { product_id: { type: 'string' }, from: { type: 'string', description: 'Inclusive ISO UTC instant.' }, to: { type: 'string', description: 'Exclusive ISO UTC instant, at most 93 days after from.' }, ...paginationInputSchema }, required: ['product_id', 'from', 'to'],
  }),
  organizationTool({ name: 'list_product_bookings', outputSchema: { type: 'object', properties: { bookings: { type: 'array', items: booking }, page_info: pageInfoObject }, required: ['bookings', 'page_info'] }, domain: 'bookings', minimumRole: 'member', description: 'Read bookings — experiences, consultations and restaurant table reservations — with guest names, session times, assigned members and status; use booking_id to manage a booking. Use get_product_booking for one booking’s guest contact details.',
    inputSchema: { assigned_member_id: {type: 'string'}, location_id: { type: ['string', 'null'] }, product_id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'confirmed', 'completed', 'cancelled'] }, from: { type: 'string', description: 'Inclusive session start instant.' }, to: { type: 'string', description: 'Exclusive session start instant.' }, ...paginationInputSchema },
  }),
  organizationTool({ name: 'create_product_booking', outputSchema: { type: 'object', properties: { success: { const: true }, booking_id: text, conversation_id: text, status: { type: 'string', enum: [...BOOKING_STATUSES] }, replayed: { type: 'boolean' }, http_status: { type: 'integer', minimum: 200, maximum: 299 } }, required: ['success', 'booking_id', 'conversation_id', 'status', 'http_status'] }, domain: 'bookings', minimumRole: 'admin', description: 'Book the named guest at a returned product session; for a legal practice this books a client consultation, and for a restaurant a table at a location (the location\'s table product). Review offerings start pending and instant offerings confirmed. Notifies the business’s staff and, when guest_acknowledgement is true, emails the guest. Required online payment returns financial_action_required and a dashboard URL before any booking is created.',
    inputSchema: {
      product_slug: { type: 'string', description: 'Offering slug from list_products or get_product, not its product ID.' }, product_session_id: { type: 'string', description: 'Available session ID from list_product_booking_sessions.' }, product_variant_id: { type: 'string' },
      party_size: { type: 'integer', minimum: 1, maximum: 99 }, guest_name: { type: 'string', minLength: 1 },
      guest_email: { type: 'string' }, guest_phone: { type: 'string', description: `Required for a table; optional otherwise. ${PHONE_FORMAT}` }, notes: { type: 'string', maxLength: 1000 },
      answers: { ...answersInput, description: `${answersInput.description} Questions are get_product → booking.questions.` }, questions_revision: questionsRevision,
      locale: { type: 'string', description: 'Guest confirmation language code; defaults to the website language.' },
      idempotency_key: key, source: { type: 'string', minLength: 1, maxLength: 100, description: 'Explicit provenance, such as operator or external scheduler.' },
      external_reference: { type: 'string', maxLength: 200 },
      guest_acknowledgement: { type: 'boolean', description: 'Explicit choice to send the guest creation email. Owner alerts, inbox, and audit always remain.' },
    }, required: ['product_slug', 'product_session_id', 'party_size', 'guest_name', 'guest_email', 'idempotency_key', 'source', 'guest_acknowledgement'],
  }),
  organizationTool({ name: 'get_product_booking', outputSchema: { anyOf: [
    { type: 'object', properties: { booking_id: text, conversation_id: text, updated_at: text, guest, answers: formAnswerSnapshotsJsonSchema(), provenance: booking.properties.provenance, record }, required: ['booking_id', 'conversation_id', 'updated_at', 'guest', 'answers', 'provenance', 'record'] },
    { type: 'object', description: 'A stay: its guest, nights, payments and version, or, for a member who looks after the home, its turnover.', properties: { booking_id: text, unit: { const: 'nights' }, stay: { anyOf: [stayDetail, stayTurnover] } }, required: ['booking_id', 'unit', 'stay'], additionalProperties: false },
  ] }, domain: 'bookings', minimumRole: 'member', description: 'Read one booking — an experience, consultation, table or stay at a home — when the user wants its guest details, answers to the offering\'s questions, status or current session. Use updated_at when proposing a change.', inputSchema: { booking_id: bookingId }, required: ['booking_id'],
  }),
  ...([
    ['confirm', 'Confirm a pending product booking or consultation after staff review and email the guest, keeping its session and places. No payment is collected.'],
    ['reject', 'Decline a pending product booking or consultation, release its places and email the guest. A required refund returns financial_action_required and a dashboard URL before status changes.'],
    ['cancel', 'Cancel a pending or confirmed booking before it ends and tell the guest: a product booking or consultation releases its places; a stay the host entered frees its nights, cancels its pending automatic messages and updates the home\'s connected Airbnb availability through Channex (a channel\'s stay is cancelled on its channel). A required refund returns financial_action_required and a dashboard URL before status changes.'],
  ] as const).map(([action, purpose]) => organizationTool({
    name: `${action}_product_booking`, outputSchema: action === 'cancel' ? { anyOf: [operationResult, nightsCancelResult] } : operationResult, domain: 'bookings', minimumRole: 'member', description: purpose,
    inputSchema: { booking_id: bookingId, idempotency_key: key, ...(action === 'cancel' ? { expected_version: { type: 'integer', minimum: 1, description: 'Required for a stay: stay.version from get_product_booking. A stale version is refused.' }, reason: { type: 'string', maxLength: 500, description: 'For a stay: why it was cancelled, kept with it.' } } : {}) }, required: ['booking_id', 'idempotency_key'],
  })),
  organizationTool({ name: 'request_product_booking_change', outputSchema: changeResult, domain: 'bookings', minimumRole: 'member', description: 'Email the guest a proposal to change a booking’s session or party size. A table booking may move to a session of the business’s tables at another location (list_product_booking_sessions on that location’s table product). The current booking and places remain unchanged until guest acceptance, which requires availability and preserves its review status. Consultation time changes always require client acceptance. For other booking kinds, apply moves the booking now and emails the guest; a paid quantity or location change is refused.',
    inputSchema: { booking_id: bookingId, product_session_id: { type: 'string', description: 'Destination session ID from list_product_booking_sessions.' }, party_size: { type: 'integer', minimum: 1, maximum: 99 }, updated_at: { type: 'string', description: 'updated_at from get_product_booking: the booking\'s own version. A guest message in the conversation does not change it.' }, apply: { type: 'boolean', description: 'For bookings other than consultations, move immediately and email the guest. Consultations always require client acceptance.' }, idempotency_key: key }, required: ['booking_id', 'product_session_id', 'party_size', 'updated_at', 'idempotency_key'],
  }),
]

export async function handleBookingsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { organization, args, toolName, event } = ctx
  const { db, env, organizationId } = organization
  const principal = memberAccessPrincipal(organization.membership, { env })
  const managesBookings = await roleAllows({ ...principal, permissions: { operations: ['update'] } })
  if (toolName === 'create_product_session' || toolName === 'update_product_session') {
    const productId = requiredString(args, 'product_id')
    await assertProductAccess(db, { ...principal, productId })
    const current = toolName === 'update_product_session' ? await queryFirst<{ id: string; location_id: string | null }>(db, 'SELECT id, location_id FROM product_sessions WHERE organization_id=? AND product_id=? AND id=?', [organizationId, productId, requiredString(args, 'product_session_id')]) : null
    if (toolName === 'update_product_session' && !current) throw new HTTPError({ statusCode: 404, statusMessage: 'Session not found for this offering' })
    const locationId = current ? current.location_id : requiredString(args, 'location_id')
    if (managesBookings) await assertResourceAccess(db, { ...principal, resourceLocationId: locationId })
    if (current) {
      return { session: await updateSession(db, { env, organizationId, productId, sessionId: current.id, actorId: organization.userId, expectedUpdatedAt: requiredString(args, 'updated_at'), startsAt: optionalString(args, 'starts_at') ?? undefined, endsAt: optionalString(args, 'ends_at') ?? undefined, capacity: args.capacity as number | null | undefined, status: args.status as 'scheduled' | 'cancelled' | undefined }) }
    }
    if (locationId === null) throw new HTTPError({ statusCode: 400, statusMessage: 'Online sessions come from the provider\'s working hours' })
    return { sessions: await createSession(db, { env, organizationId, productId, locationId, actorId: organization.userId, startsAt: requiredString(args, 'starts_at'), endsAt: requiredString(args, 'ends_at'), capacity: args.capacity as number | null | undefined, idempotencyKey: requiredString(args, 'idempotency_key') }) }
  }

  if (toolName === 'list_product_booking_sessions') {
    const from = requiredString(args, 'from')
    const to = requiredString(args, 'to')
    const start = Date.parse(from), end = Date.parse(to)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 93 * 86400000) throw new HTTPError({ statusCode: 400, message: 'A valid date range of at most 93 days is required' })
    const productId = requiredString(args, 'product_id')
    await assertProductAccess(db, { ...principal, productId })
    const product = await queryFirst(db, 'SELECT id FROM products WHERE id = ? AND organization_id = ?', [productId, organizationId])
    if (!product) {
      throw new HTTPError({
        statusCode: 404,
        message: `Product '${productId}' not found in this organization. Call list_products to inspect valid offerings.`,
        data: { code: 'PRODUCT_NOT_FOUND', product_id: productId, hint: 'Call list_products to inspect valid offerings.' },
      })
    }
    await requireBookingConfig(db, organizationId, productId)
    const sessions = await listSessions(db, { env, organizationId, productId, fromInstant: new Date(start).toISOString(), toInstant: new Date(end).toISOString() })
    const page = paginateMcpCollection(sessions, args, { resource: `booking-sessions:${organizationId}:${productId}:${from}:${to}` })
    return { sessions: page.items, page_info: page.page_info }
  }
  if (toolName === 'list_product_bookings') {
    const filters: string[] = ['b.organization_id = ?']
    const params: Array<string | number | null> = [organizationId]
    if (!managesBookings) { filters.push(assignedMemberSql('c')); params.push(organization.userId) }
    for (const [argument, column] of [['assigned_member_id', 'c.assigned_member_id'], ['product_id', 'b.product_id']] as const) {
      if (typeof args[argument] === 'string') { filters.push(`${column} = ?`); params.push(args[argument] as string) }
    }
    if (args.status === 'completed') filters.push(`b.status = 'confirmed' AND ${BOOKING_ENDS_SQL('b')} < strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    else if (typeof args.status === 'string') {
      filters.push('b.status = ?'); params.push(args.status)
      if (args.status === 'confirmed') filters.push(`${BOOKING_ENDS_SQL('b')} >= strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    }
    if (Object.hasOwn(args, 'location_id')) { filters.push('b.location_id IS ?'); params.push(args.location_id as string | null) }
    for (const [argument, operator] of [['from', '>='], ['to', '<']] as const) {
      if (args[argument] !== undefined) {
        const instant = new Date(requiredString(args, argument))
        if (!Number.isFinite(instant.getTime())) throw new HTTPError({ statusCode: 400, message: `${argument} must be an ISO instant` })
        filters.push(`${BOOKING_STARTS_SQL('b')} ${operator} ?`); params.push(instant.toISOString())
      }
    }
    const resource = { resource: `product-bookings:${JSON.stringify({ filters, params })}` }
    const window = mcpPageWindow(args, resource)
    const rows = await queryAll<Record<string, unknown> & { status: BookingStatus; ends_at: string; guest_json: string | null; provenance_json: string | null }>(db, `SELECT b.id AS booking_id, r.id AS conversation_id, b.product_id, p.kind AS product_kind, b.product_variant_id, b.product_session_id, CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS unit, b.status, b.party_size, b.user_id, b.updated_at, c.assigned_member_id, b.location_id, b.starts_at, b.ends_at, b.timezone, json_extract(r.payload_json, '$.guest') AS guest_json, json_extract(r.payload_json, '$.provenance') AS provenance_json FROM bookings b JOIN product_booking_configs c ON c.product_id = b.product_id AND c.organization_id = b.organization_id JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id LEFT JOIN conversations r ON r.booking_id = b.id AND r.organization_id = b.organization_id AND r.kind = 'booking' WHERE ${filters.join(' AND ')} ORDER BY b.starts_at DESC, b.id LIMIT ? OFFSET ?`, [...params, window.limit + 1, window.offset])
    const now = new Date().toISOString()
    const bookings = rows.slice(0, window.limit).map(({ guest_json, provenance_json, user_id: _userId, ...booking }) => {
      const guest = guest_json === null ? null : JSON.parse(guest_json) as ThreadPayload['guest']
      // A member reads a stay's guest by first name, as its turnover names them.
      const name = guest === null ? null : booking.unit === 'nights' && !managesBookings ? stayGuestFirstName(guest.name) : guest.name
      // A checkout stored as its day alone is complete once that day has passed where the home is.
      const complete = isBookingDay(booking.ends_at) ? booking.status === 'confirmed' && booking.ends_at < localDateAt(new Date(now), String(booking.timezone)) : isBookingComplete(booking, now)
      return { ...booking, is_complete: complete,
        guest: guest === null ? null : { name }, provenance: mcpBookingProvenance(provenance_json === null ? null : JSON.parse(provenance_json)) }
    })
    return { bookings, page_info: mcpPageInfo(window, bookings.length, rows.length > window.limit, resource) }
  }
  if (toolName === 'create_product_booking') {
    if (!event) throw new HTTPError({ statusCode: 500, message: 'Booking creation requires the request context' })
    const result = await createProductBooking(event, {
      organizationId, slug: requiredString(args, 'product_slug'), body: args, financialWritesAllowed: false,
      operator: { userId: organization.userId, idempotencyKey: requiredString(args, 'idempotency_key'), source: requiredString(args, 'source'), externalReference: optionalString(args, 'external_reference') ?? null, guestAcknowledgement: args.guest_acknowledgement === true },
    })
    return renderStructuredResponse({ success: result.status < 400, ...result.body, http_status: result.status }, undefined, undefined, result.status >= 400)
  }
  if (!['get_product_booking', 'confirm_product_booking', 'reject_product_booking', 'cancel_product_booking', 'request_product_booking_change'].includes(toolName)) return NOT_HANDLED
  const id = requiredString(args, 'booking_id')
  await assertAssignedBookingAccess(db, { ...principal, bookingId: id })
  // A stay is read and cancelled here as every booking is; only its nights are its own.
  if (await queryFirst(db, 'SELECT 1 FROM bookings WHERE id = ? AND organization_id = ? AND product_session_id IS NULL', [id, organizationId])) {
    const access = await stayAccessFor(principal)
    if (toolName === 'get_product_booking') return { booking_id: id, unit: 'nights', stay: await getStay(db, access, id) }
    if (toolName !== 'cancel_product_booking') throw new HTTPError({ statusCode: 409, message: 'A stay is not confirmed, declined or changed by session. Change it with update_stay or move_stay.', data: { code: 'STAY_ACTION_UNAVAILABLE', field: 'booking_id' } })
    const stay = await cancelStay(db, env, access, id, { expected_version: args.expected_version, reason: args.reason, financial_writes_allowed: false })
    if (stay.cancelled_at === null) throw new Error(`Cancelled stay ${id} reads back without its cancellation time`)
    return { booking_id: id, unit: 'nights', status: 'cancelled', version: stay.version, cancelled_at: stay.cancelled_at, cancellation_reason: stay.cancellation_reason, channel_push: stay.channel_push }
  }
  const row = await queryFirst<{ conversation_id: string | null; updated_at: string; answers: string }>(db, "SELECT (SELECT c.id FROM conversations c WHERE c.booking_id = b.id AND c.kind = 'booking') AS conversation_id, b.updated_at, b.answers FROM bookings b WHERE b.id = ? AND b.organization_id = ? AND b.product_session_id IS NOT NULL", [id, organizationId])
  if (!row?.conversation_id) {
    throw new HTTPError({
      statusCode: 404,
      message: `Booking '${id}' not found in this organization. Call list_product_bookings to view valid records.`,
      data: { code: 'BOOKING_NOT_FOUND', booking_id: id, hint: 'Call list_product_bookings to view valid records.' },
    })
  }
  const thread = await getGuestRequest(db, row.conversation_id, organizationId, 'booking')
  if (!thread || thread.kind !== 'booking') {
    throw new HTTPError({
      statusCode: 404,
      message: `Booking thread '${row.conversation_id}' not found for booking '${id}'`,
      data: { code: 'THREAD_NOT_FOUND', conversation_id: row.conversation_id, booking_id: id },
    })
  }
  let operationalRecord = await getThreadOperationalRecord(db, thread.id)
  if (!operationalRecord || operationalRecord.id !== id || operationalRecord.unit !== 'slot' || operationalRecord.organization_id !== organizationId) {
    throw new HTTPError({
      statusCode: 404,
      message: `Operational record '${id}' not found in this organization`,
      data: { code: 'RECORD_NOT_FOUND', booking_id: id },
    })
  }
  if (toolName === 'get_product_booking') {
    const provenance = thread.payload.provenance
    return { booking_id: id, conversation_id: thread.id, updated_at: row.updated_at, guest: thread.payload.guest, answers: formAnswerSnapshotsSchema.parse(JSON.parse(row.answers)),
      provenance: mcpBookingProvenance(provenance),
      record: mcpBookingRecord(operationalRecord) }
  }
  const key = requiredString(args, 'idempotency_key')
  if (toolName.startsWith('request_')) {
    const fields = { kind: 'booking', product_session_id: requiredString(args, 'product_session_id'), party_size: args.party_size }
    const proposal = args.apply === true
      ? await moveBooking(db, env, thread, { userId: organization.userId }, { ...fields, updated_at: args.updated_at }, key)
      : await requestBookingChange(db, env, thread, organization.userId, { ...fields, updated_at: args.updated_at }, key)
    await publishConversationEvent(env, db, { conversationId: thread.id, type: 'MESSAGE_CREATE' })
    operationalRecord = await getThreadOperationalRecord(db, thread.id)
    if (!operationalRecord || operationalRecord.id !== id || operationalRecord.unit !== 'slot' || operationalRecord.organization_id !== organizationId) throw new HTTPError({ statusCode: 404, message: 'Operational booking record not found in this organization' })
    return { success: true, conversation_id: thread.id, change_status: proposal.changeStatus, record: mcpBookingRecord(operationalRecord) }
  }
  const outcome = await executeGuestThreadOperation(db, { threadId: thread.id, organizationId, action: toolName.split('_')[0]!, actorUserId: organization.userId, idempotencyKey: key, env, financialWritesAllowed: false })
  if (outcome.ok || outcome.reason === 'delivery_failed') await publishConversationEvent(env, db, { conversationId: thread.id, type: 'MESSAGE_CREATE' })
  if (!outcome.ok) return renderStructuredResponse(outcome.reason === 'delivery_failed' && outcome.record
    ? { ...outcome, record: mcpBookingRecord(outcome.record) }
    : outcome, undefined, undefined, true)
  operationalRecord = await getThreadOperationalRecord(db, thread.id)
  if (!operationalRecord || operationalRecord.id !== id || operationalRecord.unit !== 'slot' || operationalRecord.organization_id !== organizationId) throw new HTTPError({ statusCode: 404, message: 'Operational booking record not found in this organization' })
  return renderStructuredResponse({
    ok: outcome.ok, status: outcome.status, conversation_id: outcome.thread.id,
    record: mcpBookingRecord(operationalRecord), available_actions: outcome.availableActions,
    thread: { id: outcome.thread.id, kind: outcome.thread.kind },
  })
}
