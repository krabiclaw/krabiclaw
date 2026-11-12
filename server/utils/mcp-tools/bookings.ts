import { paginationInputSchema, pageInfoObject, organizationTool, type McpToolDefinition } from './shared'
import { PRODUCT_KINDS } from '~/shared/product-details'
import { HTTPError } from 'nitro'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { assertResourceAccess, assertProductAccess, assertAssignedBookingAccess, assignedMemberSql, roleAllows, memberAccessPrincipal } from '~/server/utils/member-access'
import { queryAll, queryFirst } from '~/server/db'
import { createSession, findBookableSession, listScheduleSessions, updateSession } from '~/server/utils/availability'
import { mcpPageInfo, mcpPageWindow, paginateMcpCollection } from '~/server/utils/mcp-pagination'
import { createMemberBooking } from '~/server/domain/product-bookings'
import { BOOKING_ENDS_SQL, BOOKING_STARTS_SQL, getGuestRequest, getThreadOperationalRecord, isBookingDay, type ThreadOperationalRecord, type ThreadPayload } from '~/server/domain/requests'
import { localDateAt } from '~/utils/timezone'
import { stayGuestFirstName } from '~/shared/bookings'
import { getStay, stayAccessFor, updateStay } from '~/server/domain/stays'
import { nightBookingFields, nightBookingMutation, nightBookingReceipt, stayDetail, stayTurnover } from './stays'
import { CHANNEL_PUSH_SCHEMA } from '~/shared/channel-push'
import { executeBookingStatus } from '~/server/domain/guest-threads/operations'
import { changeBooking } from '~/server/domain/guest-threads/booking-changes'
import { setBookingNote } from '~/server/domain/bookings'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { NOT_HANDLED, requiredString, optionalString, type McpExecutorContext } from './execution'
import { BOOKING_STATUSES, isBookingComplete, type BookingStatus } from '~/shared/bookings'
import { formAnswerInputJsonSchema, formAnswerSnapshotsJsonSchema, formAnswerSnapshotsSchema } from '~/shared/form-questions'

const key = { type: 'string', minLength: 1, maxLength: 200, description: 'Caller-supplied durable idempotency key. Reuse only for the identical operation.' }
const version = { type: 'integer', minimum: 1, description: 'The booking version from get_product_booking. A stale version is refused.' }
const bookingId = { type: 'string', description: 'Booking ID returned by list_product_bookings or create_product_booking. Distinct from conversation_id, which identifies the inbox conversation.' }
const text = { type: 'string', minLength: 1 }
const nullableText = { type: ['string', 'null'] }
const guest = { type: 'object', properties: { name: text, email: text, phone: nullableText }, required: ['name', 'email'] }
const answersInput = formAnswerInputJsonSchema()
const questionsRevision = { type: 'string', description: 'The questions_revision the answers were collected against. Required with answers; a changed revision returns questions_changed with the current questions.' }
const productKind = { type: 'string', enum: [...PRODUCT_KINDS], description: 'What was booked: an experience, legal consultation, restaurant table or place to stay.' }
const record = { type: 'object', properties: { id: text, kind: { type: 'string', enum: ['booking'] }, status: { type: 'string', enum: [...BOOKING_STATUSES] }, party_size: { type: 'integer', minimum: 1 }, starts_at: text, ends_at: text, timezone: text, assigned_member_id: nullableText, location_id: nullableText, product_id: nullableText, product_kind: productKind, product_name: nullableText }, required: ['id', 'kind', 'status', 'party_size', 'starts_at', 'ends_at', 'timezone', 'assigned_member_id', 'location_id', 'product_id', 'product_kind', 'product_name'] }
const booking = { type: 'object', properties: { booking_id: text, conversation_id: nullableText, product_id: text, product_kind: productKind, product_variant_id: nullableText, product_session_id: { ...nullableText, description: 'The session a slot booking holds; null for a stay, which holds nights.' }, unit: { type: 'string', enum: ['slot', 'nights'], description: 'What the booking holds: a session\'s places (slot) or a home\'s nights (nights).' }, status: { type: 'string', enum: [...BOOKING_STATUSES] }, is_complete: { type: 'boolean' }, party_size: { type: 'integer' }, version, updated_at: text, assigned_member_id: nullableText, location_id: nullableText, starts_at: text, ends_at: text, timezone: text, guest: { type: ['object', 'null'], properties: { name: nullableText }, required: ['name'], additionalProperties: false }, provenance: { type: ['object', 'null'], properties: { source: text, external_reference: nullableText, guest_acknowledgement: { type: 'boolean' } }, required: ['source', 'external_reference', 'guest_acknowledgement'] } }, required: ['booking_id', 'conversation_id', 'product_id', 'product_kind', 'product_variant_id', 'product_session_id', 'unit', 'status', 'is_complete', 'party_size', 'version', 'updated_at', 'assigned_member_id', 'location_id', 'starts_at', 'ends_at', 'timezone', 'guest', 'provenance'] }
const session = { type: 'object', properties: { id: text, organization_id: text, product_id: text, location_id: nullableText, timezone: text, starts_at: text, ends_at: text, updated_at: nullableText, capacity: { type: ['integer', 'null'] }, status: text, claimed: { type: 'integer' }, remaining: { type: ['integer', 'null'] }, is_full: { type: 'boolean' } }, required: ['id', 'organization_id', 'product_id', 'location_id', 'starts_at', 'ends_at', 'timezone', 'capacity', 'status', 'claimed', 'remaining', 'is_full', 'updated_at'] }
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
    inputSchema: { anyOf: [{ required: ['starts_at'] }, { required: ['ends_at'] }, { required: ['capacity'] }, { required: ['status'] }], product_id: text, product_session_id: text, updated_at: { ...nullableText, description: 'Session updated_at from list_product_booking_sessions, or null for a recurring time with no saved change or booking.' }, starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' }, capacity: { type: ['integer', 'null'], minimum: 0 }, status: { type: 'string', enum: ['scheduled', 'cancelled'] } }, required: ['product_id', 'product_session_id', 'updated_at'],
    outputSchema: { type: 'object', properties: { session }, required: ['session'] },
  }),

  organizationTool({ name: 'list_product_booking_sessions', outputSchema: { type: 'object', properties: { sessions: { type: 'array', items: session }, page_info: pageInfoObject }, required: ['sessions', 'page_info'] }, domain: 'bookings', minimumRole: 'member', description: 'Read scheduled times and remaining places for a product, including shared calendar conflicts. Choose a returned session ID to create or change a booking.',
    inputSchema: { product_id: { type: 'string' }, from: { type: 'string', description: 'Inclusive ISO UTC instant.' }, to: { type: 'string', description: 'Exclusive ISO UTC instant, at most 93 days after from.' }, ...paginationInputSchema }, required: ['product_id', 'from', 'to'],
  }),
  organizationTool({ name: 'list_product_bookings', outputSchema: { type: 'object', properties: { bookings: { type: 'array', items: booking }, page_info: pageInfoObject }, required: ['bookings', 'page_info'] }, domain: 'bookings', minimumRole: 'member', description: 'Read bookings for tables, experiences, legal consultations and stays. Use get_product_booking for guest contact details and booking_id plus version to make changes.',
    inputSchema: { unit: { type: 'string', enum: ['slot', 'nights'] }, assigned_member_id: {type: 'string'}, location_id: { type: ['string', 'null'] }, product_id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'confirmed', 'completed', 'cancelled'] }, from: { type: 'string', description: 'Inclusive session start instant.' }, to: { type: 'string', description: 'Exclusive session start instant.' }, ...paginationInputSchema },
  }),
  organizationTool({ name: 'create_product_booking', outputSchema: { type: 'object', anyOf: [
    { type: 'object', properties: { success: { const: true }, booking_id: text, conversation_id: text, status: { type: 'string', enum: [...BOOKING_STATUSES] }, replayed: { type: 'boolean' }, http_status: { type: 'integer', minimum: 200, maximum: 299 } }, required: ['success', 'booking_id', 'conversation_id', 'status', 'http_status'] },
    { ...nightBookingReceipt, properties: { ...nightBookingReceipt.properties, success: { const: true } }, required: [...nightBookingReceipt.required, 'success'] },
  ] }, domain: 'bookings', minimumRole: 'admin', description: 'Book a guest in a timed offering or record a direct stay. Use an available session ID for a table, experience or legal consultation; for a stay give the arrival and departure dates, guests and amount due to the host. Reuse the same key for the same request. Timed bookings that require online payment need an approved dashboard checkout.',
    inputSchema: {
      ...nightBookingFields,
      product_slug: { type: 'string', description: 'Offering slug from list_products or get_product.' }, product_session_id: { type: 'string', description: 'Available time from list_product_booking_sessions.' }, product_variant_id: text,
      party_size: { type: 'integer', minimum: 1, maximum: 99 }, notes: { type: 'string', maxLength: 1000 },
      answers: answersInput, questions_revision: questionsRevision, locale: { type: 'string', description: 'Guest confirmation language code; defaults to the website language.' },
      idempotency_key: key, source: { type: 'string', minLength: 1, maxLength: 100, description: 'Provenance for timed bookings, such as operator or external scheduler.' },
      external_reference: { type: 'string', maxLength: 200 }, guest_acknowledgement: { type: 'boolean', description: 'Explicit choice to send the timed booking confirmation.' },
      oneOf: [
        { required: ['product_session_id', 'party_size', 'guest_email', 'source', 'guest_acknowledgement'], not: { required: ['check_in_date'] } },
        { required: ['check_in_date', 'check_out_date', 'adults', 'total_minor'], not: { required: ['product_session_id'] } },
      ],
    }, required: ['product_slug', 'guest_name', 'idempotency_key'],
  }),
  organizationTool({ name: 'get_product_booking', outputSchema: { type: 'object', anyOf: [
    { type: 'object', properties: { booking_id: text, unit: { const: 'slot' }, conversation_id: text, version, updated_at: text, guest, answers: formAnswerSnapshotsJsonSchema(), provenance: booking.properties.provenance, record }, required: ['booking_id', 'unit', 'conversation_id', 'version', 'updated_at', 'guest', 'answers', 'provenance', 'record'] },
    { type: 'object', description: 'A stay: its guest, nights, payments and version, or, for a member who looks after the home, its turnover.', properties: { booking_id: text, unit: { const: 'nights' }, record: { anyOf: [stayDetail, stayTurnover] } }, required: ['booking_id', 'unit', 'record'], additionalProperties: false },
  ] }, domain: 'bookings', minimumRole: 'member', description: 'Read one booking — an experience, consultation, table or stay at a home — when the user wants its guest details, answers to the offering\'s questions, status or current session. Use the booking version when making a change.', inputSchema: { booking_id: bookingId }, required: ['booking_id'],
  }),
  ...([
    ['confirm', 'Confirm a pending product booking or consultation after staff review and email the guest, keeping its session and places. No payment is collected.'],
    ['reject', 'Decline a pending product booking or consultation, release its places and email the guest. A required refund returns financial_action_required and a dashboard URL before status changes.'],
    ['no_show', 'Record that a guest did not attend a booking that has begun and does not have a guest review.'],
    ['cancel', 'Cancel a pending or confirmed booking before it ends and tell the guest: a product booking or consultation releases its places; a stay the host entered frees its nights, cancels its pending automatic messages and updates the home\'s connected Airbnb availability through Channex (a channel\'s stay is cancelled on its channel). A required refund returns financial_action_required and a dashboard URL before status changes.'],
  ] as const).map(([action, purpose]) => organizationTool({
    name: `${action}_product_booking`, outputSchema: action === 'cancel' ? { type: 'object', anyOf: [operationResult, nightsCancelResult] } : operationResult, domain: 'bookings', minimumRole: 'member', description: purpose,
    inputSchema: { booking_id: bookingId, idempotency_key: key, version, ...(action === 'cancel' ? { reason: { type: 'string', maxLength: 500, description: 'For a stay: why it was cancelled, kept with it.' } } : {}) }, required: ['booking_id', 'version', 'idempotency_key'],
  })),
  organizationTool({ name: 'request_product_booking_change', outputSchema: { type: 'object', anyOf: [changeResult, { ...nightBookingReceipt,
    properties: { ...nightBookingReceipt.properties, scheduled_message_id: text }, required: [...nightBookingReceipt.required, 'scheduled_message_id'] }] }, domain: 'bookings', minimumRole: 'member',
    description: 'Propose a different session or party size to the guest, or apply the move now when allowed. Legal consultation time changes require client acceptance. Give product_id for a table move to a different offering, or to move a stay to another home. For a stay, apply must be true; the guest receives the new arrival instructions.',
    inputSchema: { booking_id: bookingId, product_session_id: text, product_id: text, party_size: { type: 'integer', minimum: 1, maximum: 99 }, version,
      apply: { type: 'boolean' }, idempotency_key: key, anyOf: [{ required: ['product_session_id'] }, { required: ['product_id', 'apply'], properties: { apply: { const: true } } }] },
    required: ['booking_id', 'version', 'idempotency_key'],
  }),
  organizationTool({ name: 'update_product_booking', outputSchema: { type: 'object', anyOf: [nightBookingReceipt,
    { type: 'object', properties: { booking_id: text, unit: { const: 'slot' }, version, private_notes: nullableText }, required: ['booking_id', 'unit', 'version', 'private_notes'] }] }, domain: 'bookings', minimumRole: 'member',
    description: 'Edit the team’s private notes, or update the dates, party and guest details of a host-entered stay. Use the latest booking version. Use request_product_booking_change for timed inventory changes.',
    inputSchema: { booking_id: bookingId, version, ...nightBookingFields, anyOf: Object.keys(nightBookingFields).map(field => ({ required: [field] })) },
    required: ['booking_id', 'version'],
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
    if (toolName === 'update_product_session') {
      const sessionId = requiredString(args, 'product_session_id')
      const current = await queryFirst<{ id: string; location_id: string | null }>(db, 'SELECT id, location_id FROM product_sessions WHERE organization_id=? AND product_id=? AND id=?', [organizationId, productId, sessionId])
        ?? await findBookableSession(db, { organizationId, productId, sessionId }, 'editor')
      if (!current) throw new HTTPError({ statusCode: 404, statusMessage: 'Session not found for this offering' })
      if (managesBookings) await assertResourceAccess(db, { ...principal, resourceLocationId: current.location_id })
      return { session: await updateSession(db, { env, organizationId, productId, sessionId, actorId: organization.userId, expectedUpdatedAt: args.updated_at === null ? null : requiredString(args, 'updated_at'), startsAt: optionalString(args, 'starts_at') ?? undefined, endsAt: optionalString(args, 'ends_at') ?? undefined, capacity: args.capacity as number | null | undefined, status: args.status as 'scheduled' | 'cancelled' | undefined }) }
    }
    const locationId = requiredString(args, 'location_id')
    if (managesBookings) await assertResourceAccess(db, { ...principal, resourceLocationId: locationId })
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
    const range = { env, organizationId, productId, fromInstant: new Date(start).toISOString(), toInstant: new Date(end).toISOString() }
    const sessions = await listScheduleSessions(db, range)
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
    if (args.unit === 'slot' || args.unit === 'nights') filters.push(`b.product_session_id IS ${args.unit === 'slot' ? 'NOT ' : ''}NULL`)
    const resource = { resource: `product-bookings:${JSON.stringify({ filters, params })}` }
    const window = mcpPageWindow(args, resource)
    const rows = await queryAll<Record<string, unknown> & { status: BookingStatus; ends_at: string; guest_json: string | null; provenance_json: string | null }>(db, `SELECT b.id AS booking_id, r.id AS conversation_id, b.product_id, p.kind AS product_kind, b.product_variant_id, b.product_session_id, CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS unit, b.status, b.party_size, b.user_id, b.version, b.updated_at, c.assigned_member_id, b.location_id, b.starts_at, b.ends_at, b.timezone, json_extract(r.payload_json, '$.guest') AS guest_json, json_extract(r.payload_json, '$.provenance') AS provenance_json FROM bookings b JOIN product_booking_configs c ON c.product_id = b.product_id AND c.organization_id = b.organization_id JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id LEFT JOIN conversations r ON r.booking_id = b.id AND r.organization_id = b.organization_id AND r.kind = 'booking' WHERE ${filters.join(' AND ')} ORDER BY b.starts_at DESC, b.id LIMIT ? OFFSET ?`, [...params, window.limit + 1, window.offset])
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
    const slug = requiredString(args, 'product_slug')
    const product = await queryFirst<{ id: string }>(db, 'SELECT id FROM products WHERE organization_id=? AND slug=?', [organizationId, slug])
    if (!product) throw new HTTPError({ statusCode: 404, message: 'Bookable offering not found' })
    const result = await createMemberBooking(event, {
      principal, productId: product.id, body: args, financialWritesAllowed: false,
      operator: { idempotencyKey: requiredString(args, 'idempotency_key'), source: optionalString(args, 'source') ?? 'operator',
        externalReference: optionalString(args, 'external_reference') ?? null, guestAcknowledgement: args.guest_acknowledgement === true },
    })
    if (result.kind === 'stay') return { success: true, ...nightBookingMutation(result.stay) }
    return renderStructuredResponse({ success: result.status < 400, ...result.body, http_status: result.status }, undefined, undefined, result.status >= 400)
  }
  const statusActions: Record<string, 'confirm' | 'reject' | 'cancel' | 'no_show'> = {
    confirm_product_booking: 'confirm', reject_product_booking: 'reject', cancel_product_booking: 'cancel', no_show_product_booking: 'no_show',
  }
  const action = statusActions[toolName]
  if (!action && !['get_product_booking', 'request_product_booking_change', 'update_product_booking'].includes(toolName)) return NOT_HANDLED
  const id = requiredString(args, 'booking_id')
  await assertAssignedBookingAccess(db, { ...principal, bookingId: id })
  const row = await queryFirst<{ conversation_id: string; version: number; updated_at: string; answers: string; unit: 'slot' | 'nights' }>(db, `SELECT c.id AS conversation_id,
    b.version, b.updated_at, b.answers, CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS unit
    FROM bookings b JOIN conversations c ON c.booking_id=b.id AND c.organization_id=b.organization_id AND c.kind='booking'
    WHERE b.id=? AND b.organization_id=?`, [id, organizationId])
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found in this organization' })
  const access = row.unit === 'nights' ? await stayAccessFor(principal) : undefined
  if (toolName === 'update_product_booking') {
    const { booking_id: _bookingId, ...patch } = args
    if (access) return nightBookingMutation(await updateStay(db, env, access, id, { ...patch, version: args.version }))
    if (Object.keys(patch).some(field => field !== 'version' && field !== 'private_notes')) throw new HTTPError({ statusCode: 422, message: 'Use request_product_booking_change to update a timed booking' })
    await setBookingNote(db, { organizationId, bookingId: id }, { ...patch, private_notes: patch.private_notes ?? '' })
    await publishConversationEvent(env, db, { conversationId: row.conversation_id, type: 'MESSAGE_UPDATE' })
    const booking = await queryFirst<{ booking_id: string; unit: 'slot'; private_notes: string | null; version: number }>(db, "SELECT id AS booking_id, 'slot' AS unit, private_notes, version FROM bookings WHERE id=? AND organization_id=?", [id, organizationId])
    if (!booking) throw new Error('Updated booking could not be read')
    return booking
  }
  if (access && toolName === 'get_product_booking') return { booking_id: id, unit: 'nights', record: await getStay(db, access, id) }
  const thread = await getGuestRequest(db, row.conversation_id, organizationId, 'booking')
  if (!thread || thread.kind !== 'booking') {
    throw new HTTPError({
      statusCode: 404,
      message: `Booking thread '${row.conversation_id}' not found for booking '${id}'`,
      data: { code: 'THREAD_NOT_FOUND', conversation_id: row.conversation_id, booking_id: id },
    })
  }
  let operationalRecord = await getThreadOperationalRecord(db, thread.id)
  if (!operationalRecord || operationalRecord.id !== id || operationalRecord.organization_id !== organizationId) {
    throw new HTTPError({
      statusCode: 404,
      message: `Operational record '${id}' not found in this organization`,
      data: { code: 'RECORD_NOT_FOUND', booking_id: id },
    })
  }
  if (toolName === 'get_product_booking') {
    const provenance = thread.payload.provenance
    return { booking_id: id, unit: row.unit, conversation_id: thread.id, version: row.version, updated_at: row.updated_at, guest: thread.payload.guest, answers: formAnswerSnapshotsSchema.parse(JSON.parse(row.answers)),
      provenance: mcpBookingProvenance(provenance),
      record: mcpBookingRecord(operationalRecord) }
  }
  const key = requiredString(args, 'idempotency_key')
  if (toolName === 'request_product_booking_change') {
    const proposal = await changeBooking(db, env, {
      organizationId, bookingId: id, actorUserId: organization.userId, body: args, apply: args.apply === true, idempotencyKey: key, stayAccess: access,
    })
    if (proposal.kind === 'stay') return { ...nightBookingMutation(proposal.stay), scheduled_message_id: proposal.scheduledMessageId }
    operationalRecord = await getThreadOperationalRecord(db, proposal.conversationId)
    if (!operationalRecord || operationalRecord.id !== id || operationalRecord.organization_id !== organizationId) throw new HTTPError({ statusCode: 404, message: 'Operational booking record not found in this organization' })
    return { success: true, conversation_id: proposal.conversationId, change_status: proposal.changeStatus, record: mcpBookingRecord(operationalRecord) }
  }
  if (!action || typeof args.version !== 'number') throw new HTTPError({ statusCode: 400, message: 'Booking version is required' })
  const result = await executeBookingStatus(db, { bookingId: id, version: args.version, threadId: thread.id, organizationId, action, actorUserId: organization.userId,
    idempotencyKey: key, env, stayAccess: access, stayManager: access?.manage, reason: optionalString(args, 'reason') ?? undefined, financialWritesAllowed: false })
  if (result.kind === 'stay') {
    const { stay } = result
    if (stay.cancelled_at === null) throw new Error(`Cancelled booking ${id} has no cancellation time`)
    return { booking_id: id, unit: 'nights', status: 'cancelled', version: stay.version, cancelled_at: stay.cancelled_at, cancellation_reason: stay.cancellation_reason, channel_push: stay.channel_push }
  }
  const { outcome } = result
  if (outcome.ok || outcome.reason === 'delivery_failed') await publishConversationEvent(env, db, { conversationId: thread.id, type: 'MESSAGE_CREATE' })
  if (!outcome.ok) return renderStructuredResponse(outcome.reason === 'delivery_failed' && outcome.record
    ? { ...outcome, record: mcpBookingRecord(outcome.record) }
    : outcome, undefined, undefined, true)
  operationalRecord = await getThreadOperationalRecord(db, thread.id)
  if (!operationalRecord || operationalRecord.id !== id || operationalRecord.organization_id !== organizationId) throw new HTTPError({ statusCode: 404, message: 'Operational booking record not found in this organization' })
  return renderStructuredResponse({
    ok: outcome.ok, status: outcome.status, conversation_id: outcome.thread.id,
    record: mcpBookingRecord(operationalRecord), available_actions: outcome.availableActions,
    thread: { id: outcome.thread.id, kind: outcome.thread.kind },
  })
}
