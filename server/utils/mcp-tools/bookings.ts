import { paginationInputSchema, pageInfoObject, organizationTool, type McpToolDefinition } from './shared'
import { reassignBookingProvider } from '~/server/domain/provider-reassignment'
import { refreshProductBusy } from '~/server/domain/member-scheduling'
import { HTTPError } from 'nitro'
import { createTableReservation } from '~/server/domain/table-reservations'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { assertResourceAccess, assertProductAccess, assertAssignedBookingAccess, assignedBookingSql, roleAllows, memberAccessPrincipal } from '~/server/utils/member-access'
import { queryAll, queryFirst } from '~/server/db'
import { createSession, getSessionAvailability, listSessions, requireBookingConfig, updateSession } from '~/server/utils/availability'
import { mcpPageInfo, mcpPageWindow, paginateMcpCollection } from '~/server/utils/mcp-pagination'
import { createProductBooking } from '~/server/domain/product-bookings'
import { getGuestRequest, getThreadOperationalRecord, type ThreadOperationalRecord, type ThreadPayload } from '~/server/domain/requests'
import { executeGuestThreadOperation } from '~/server/domain/guest-threads/operations'
import { requestBookingChange } from '~/server/domain/guest-threads/booking-changes'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { NOT_HANDLED, requiredString, optionalString, type McpExecutorContext } from './execution'
import { BOOKING_STATUSES, isBookingComplete, type BookingStatus } from '~/shared/bookings'

const key = { type: 'string', minLength: 1, maxLength: 200, description: 'Caller-supplied durable idempotency key. Reuse only for the identical operation.' }
const bookingId = { type: 'string', description: 'Booking ID returned by list_product_bookings or create_product_booking. Distinct from request_id, which identifies the inbox conversation.' }
const reservationId = { type: 'string', description: 'Reservation ID from list_reservation_inquiries. Distinct from the inbox conversation ID.' }
const text = { type: 'string', minLength: 1 }
const nullableText = { type: ['string', 'null'] }
const guest = { type: 'object', properties: { name: text, email: text, phone: nullableText }, required: ['name', 'email'] }
const record = { type: 'object', properties: { id: text, kind: { type: 'string', enum: ['booking', 'reservation'] }, status: { type: 'string', enum: [...BOOKING_STATUSES] }, party_size: { type: 'integer', minimum: 1 }, starts_at: text, ends_at: text, timezone: text, assigned_member_id: nullableText, location_id: nullableText, product_id: nullableText, product_name: nullableText }, required: ['id', 'kind', 'status', 'party_size', 'starts_at', 'ends_at', 'timezone', 'assigned_member_id', 'location_id', 'product_id', 'product_name'] }
const booking = { type: 'object', properties: { operational_booking_id: text, request_id: nullableText, product_id: text, product_variant_id: nullableText, product_session_id: text, status: { type: 'string', enum: [...BOOKING_STATUSES] }, is_complete: { type: 'boolean' }, party_size: { type: 'integer' }, user_id: nullableText, updated_at: text, assigned_member_id: nullableText, location_id: nullableText, starts_at: text, ends_at: text, timezone: text, guest: { ...guest, type: ['object', 'null'] }, provenance: { type: ['object', 'null'], properties: { source: text, external_reference: nullableText, guest_acknowledgement: { type: 'boolean' } }, required: ['source', 'external_reference', 'guest_acknowledgement'] } }, required: ['operational_booking_id', 'request_id', 'product_id', 'product_variant_id', 'product_session_id', 'status', 'is_complete', 'party_size', 'user_id', 'updated_at', 'assigned_member_id', 'location_id', 'starts_at', 'ends_at', 'timezone', 'guest', 'provenance'] }
const session = { type: 'object', properties: { assigned_member_id: nullableText, id: text, organization_id: text, product_id: text, location_id: nullableText, timezone: text, starts_at: text, ends_at: text, updated_at: text, capacity: { type: ['integer', 'null'] }, status: text, claimed: { type: 'integer' }, remaining: { type: ['integer', 'null'] }, is_full: { type: 'boolean' } }, required: ['id', 'organization_id', 'product_id', 'location_id', 'assigned_member_id', 'starts_at', 'ends_at', 'timezone', 'capacity', 'status', 'claimed', 'remaining', 'is_full', 'updated_at'] }
const operationResult = { type: 'object', properties: { ok: { const: true }, status: { const: 200 }, request_id: text, record, availableActions: { type: 'array', items: text }, thread: { type: 'object', properties: { id: text, kind: { type: 'string', enum: ['booking', 'reservation'] }, conversation_state: text }, required: ['id', 'kind', 'conversation_state'] } }, required: ['ok', 'status', 'request_id', 'record', 'availableActions', 'thread'] }
const changeResult = { type: 'object', properties: { success: { const: true }, request_id: text, change_status: { const: 'awaiting_guest_acceptance' }, record }, required: ['success', 'request_id', 'change_status', 'record'] }

function mcpBookingRecord(record: ThreadOperationalRecord) {
  const { id, kind, status, party_size, starts_at, ends_at, timezone, assigned_member_id, location_id, product_id, product_name } = record
  return { id, kind, status, party_size, starts_at, ends_at, timezone, assigned_member_id, location_id, product_id, product_name }
}

function mcpBookingProvenance(provenance: ThreadPayload['provenance'] | null) {
  return provenance ? { source: provenance.source, external_reference: provenance.external_reference, guest_acknowledgement: provenance.guest_acknowledgement } : null
}

export const BOOKINGS_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'create_product_session', domain: 'bookings', minimumRole: 'member', description: 'Add a dated time at a location for an existing bookable offering using its actual start and end. An assigned team gets one session per member. Online offerings take no dated sessions: they are booked in their provider\'s working hours.',
    inputSchema: { product_id: text, location_id: { ...text, description: 'Session location.' }, starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' }, capacity: { type: ['integer', 'null'], minimum: 0 }, idempotency_key: key }, required: ['product_id', 'location_id', 'starts_at', 'ends_at', 'idempotency_key'],
    outputSchema: { type: 'object', properties: { sessions: { type: 'array', items: session, minItems: 1 } }, required: ['sessions'] },
  }),
  organizationTool({ name: 'update_product_session', domain: 'bookings', minimumRole: 'member', description: 'Edit one session’s time, capacity or state using its current timestamp. Committed bookings or checkout holds prevent time or state changes; use the guest booking-change workflow.',
    inputSchema: { product_id: text, session_id: text, expected_updated_at: { ...text, description: 'Session updated_at from the latest read.' }, starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' }, capacity: { type: ['integer', 'null'], minimum: 0 }, status: { type: 'string', enum: ['scheduled', 'cancelled'] } }, required: ['product_id', 'session_id', 'expected_updated_at'],
    outputSchema: { type: 'object', properties: { session }, required: ['session'] },
  }),

 organizationTool({name:'reassign_product_booking',outputSchema:{type:'object',properties:{session_id:text,assigned_member_id:text},required:['session_id','assigned_member_id']},domain:'bookings',minimumRole:'admin',description:'Move a provider-led booking’s whole session to an available team member, preserving its time and attendees’ booking IDs. Sends guest and staff notifications; active checkout holds prevent the change.',inputSchema:{operational_booking_id:bookingId,member_id:{type:'string'},expected_updated_at:{type:'string'},idempotency_key:key},required:['operational_booking_id','member_id','expected_updated_at','idempotency_key']}),
  organizationTool({ name: 'list_product_booking_sessions', outputSchema: { type: 'object', properties: { sessions: { type: 'array', items: session }, page_info: pageInfoObject }, required: ['sessions', 'page_info'] }, domain: 'bookings', minimumRole: 'member', description: 'Read scheduled times and remaining places for a product, including shared calendar conflicts. Choose a returned session ID to create or change a booking.',
    inputSchema: { product_id: { type: 'string' }, from: { type: 'string', description: 'Inclusive ISO UTC instant.' }, to: { type: 'string', description: 'Exclusive ISO UTC instant, at most 93 days after from.' }, ...paginationInputSchema }, required: ['product_id', 'from', 'to'],
  }),
  organizationTool({ name: 'list_product_bookings', outputSchema: { type: 'object', properties: { bookings: { type: 'array', items: booking }, page_info: pageInfoObject }, required: ['bookings', 'page_info'] }, domain: 'bookings', minimumRole: 'member', description: 'Read product bookings and consultations with guests, session times, assigned members and status; use operational_booking_id to manage a booking. Restaurant table reservations use list_reservation_inquiries.',
    inputSchema: { assigned_member_id: {type: 'string'}, location_id: { type: ['string', 'null'] }, product_id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'confirmed', 'completed', 'cancelled'] }, from: { type: 'string', description: 'Inclusive session start instant.' }, to: { type: 'string', description: 'Exclusive session start instant.' }, ...paginationInputSchema },
  }),
  organizationTool({ name: 'create_table_reservation', domain: 'bookings', minimumRole: 'admin', description: 'Reserve a table for a named guest at a location’s local date and time under its saved reservation policy. Required deposits return financial_action_required and a dashboard URL before confirmation.',
    inputSchema: { location_id: { type: 'string' }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, party_size: { type: 'integer', minimum: 1, maximum: 99 }, guest_name: { type: 'string', minLength: 1 }, guest_email: { type: 'string' }, guest_phone: { type: 'string', description: 'International phone number with calling code.' }, locale: { type: 'string', description: 'Guest confirmation language code; defaults to the website language.' }, notes: { type: 'string', maxLength: 1000 }, idempotency_key: key, source: { type: 'string', minLength: 1 }, external_reference: { type: 'string' }, guest_acknowledgement: { type: 'boolean', description: 'Explicit choice to email the guest; owner alerts, inbox and audit are always recorded.' } },
    required: ['location_id', 'date', 'time', 'party_size', 'guest_name', 'guest_email', 'guest_phone', 'idempotency_key', 'source', 'guest_acknowledgement'],
    outputSchema: { type: 'object', properties: { success: { const: true }, request_id: text, operational_reservation_id: text, status: { type: 'string' }, replayed: { type: 'boolean' }, http_status: { type: 'integer' } }, required: ['success', 'request_id', 'operational_reservation_id', 'status', 'http_status'] },
  }),
  organizationTool({ name: 'create_product_booking', outputSchema: { type: 'object', properties: { success: { const: true }, operational_booking_id: text, request_id: text, status: { type: 'string', enum: [...BOOKING_STATUSES] }, replayed: { type: 'boolean' }, http_status: { type: 'integer', minimum: 200, maximum: 299 } }, required: ['success', 'operational_booking_id', 'request_id', 'status', 'http_status'] }, domain: 'bookings', minimumRole: 'admin', description: 'Book the named guest at a returned product session; review offerings start pending and instant offerings confirmed. Required online payment returns financial_action_required and a dashboard URL before any booking is created.',
    inputSchema: {
      product_slug: { type: 'string' }, session_id: { type: 'string' }, variant_id: { type: 'string' },
      party_size: { type: 'integer', minimum: 1, maximum: 99 }, guest_name: { type: 'string', minLength: 1 },
      guest_email: { type: 'string' }, guest_phone: { type: 'string', description: 'Optional guest phone in international format.' }, notes: { type: 'string', maxLength: 1000 },
      locale: { type: 'string', description: 'Guest confirmation language code; defaults to the website language.' },
      idempotency_key: key, source: { type: 'string', minLength: 1, maxLength: 100, description: 'Explicit provenance, such as operator or external scheduler.' },
      external_reference: { type: 'string', maxLength: 200 },
      guest_acknowledgement: { type: 'boolean', description: 'Explicit choice to send the guest creation email. Owner alerts, inbox, and audit always remain.' },
    }, required: ['product_slug', 'session_id', 'party_size', 'guest_name', 'guest_email', 'idempotency_key', 'source', 'guest_acknowledgement'],
  }),
  organizationTool({ name: 'get_product_booking', outputSchema: { type: 'object', properties: { operational_booking_id: text, request_id: text, updated_at: text, operational_updated_at: text, guest_user_id: nullableText, guest, provenance: booking.properties.provenance, record }, required: ['operational_booking_id', 'request_id', 'updated_at', 'operational_updated_at', 'guest_user_id', 'guest', 'provenance', 'record'] }, domain: 'bookings', minimumRole: 'member', description: 'Read one product booking or consultation when the user wants its guest details, status or current session. Use its updated_at when proposing a change.', inputSchema: { operational_booking_id: bookingId }, required: ['operational_booking_id'],
  }),
  ...([
    ['confirm', 'Confirm a pending product booking or consultation after staff review and email the guest, keeping its session and places. No payment is collected.'],
    ['reject', 'Decline a pending product booking or consultation, release its places and email the guest. A required refund returns financial_action_required and a dashboard URL before status changes.'],
    ['cancel', 'Cancel a pending or confirmed product booking or consultation before it ends, release its places and email the guest. A required refund returns financial_action_required and a dashboard URL before status changes.'],
  ] as const).map(([action, purpose]) => organizationTool({
    name: `${action}_product_booking`, outputSchema: operationResult, domain: 'bookings', minimumRole: 'member', description: purpose,
    inputSchema: { operational_booking_id: bookingId, idempotency_key: key }, required: ['operational_booking_id', 'idempotency_key'],
  })),
  organizationTool({ name: 'request_product_booking_change', outputSchema: changeResult, domain: 'bookings', minimumRole: 'member', description: 'Email the guest a proposal to change a booking’s session or party size. The current booking and places remain unchanged until guest acceptance, which requires availability and preserves its review status.',
    inputSchema: { operational_booking_id: bookingId, session_id: { type: 'string' }, party_size: { type: 'integer', minimum: 1, maximum: 99 }, expected_updated_at: { type: 'string', description: 'Thread updated_at from get_product_booking.' }, idempotency_key: key }, required: ['operational_booking_id', 'session_id', 'party_size', 'expected_updated_at', 'idempotency_key'],
  }),
  organizationTool({ name: 'cancel_table_reservation', outputSchema: operationResult, domain: 'bookings', minimumRole: 'admin', description: 'Cancel a table reservation, release its capacity and email the guest. A required refund returns financial_action_required and a dashboard URL before cancellation.',
    inputSchema: { operational_reservation_id: reservationId, idempotency_key: key }, required: ['operational_reservation_id', 'idempotency_key'],
  }),
  organizationTool({ name: 'request_table_reservation_change', outputSchema: changeResult, domain: 'bookings', minimumRole: 'admin', description: 'Email the guest a proposal to change a table reservation’s location, local date, time or party size. The current reservation remains unchanged until the guest accepts.',
    inputSchema: { operational_reservation_id: reservationId, override_policy: { type: 'boolean', description: 'True only when the business approves an exception to its change policy.' }, location_id: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' }, party_size: { type: 'integer', minimum: 1, maximum: 99 }, expected_updated_at: { type: 'string' }, idempotency_key: key }, required: ['operational_reservation_id', 'location_id', 'date', 'time', 'party_size', 'expected_updated_at', 'idempotency_key'],
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
    const current = toolName === 'update_product_session' ? await getSessionAvailability(db, organizationId, productId, requiredString(args, 'session_id')) : null
    const locationId = current ? current.location_id : requiredString(args, 'location_id')
    if (managesBookings) await assertResourceAccess(db, { ...principal, resourceLocationId: locationId })
    if (current) {
      return { session: await updateSession(db, { organizationId, productId, sessionId: current.id, actorId: organization.userId, expectedUpdatedAt: requiredString(args, 'expected_updated_at'), startsAt: optionalString(args, 'starts_at') ?? undefined, endsAt: optionalString(args, 'ends_at') ?? undefined, capacity: args.capacity as number | null | undefined, status: args.status as 'scheduled' | 'cancelled' | undefined }) }
    }
    if (locationId === null) throw new HTTPError({ statusCode: 400, statusMessage: 'Online sessions come from the provider\'s working hours' })
    return { sessions: await createSession(db, { organizationId, productId, locationId, actorId: organization.userId, startsAt: requiredString(args, 'starts_at'), endsAt: requiredString(args, 'ends_at'), capacity: args.capacity as number | null | undefined, idempotencyKey: requiredString(args, 'idempotency_key') }) }
  }

  if (toolName === 'list_product_booking_sessions') {
    const from = requiredString(args, 'from')
    const to = requiredString(args, 'to')
    const start = Date.parse(from), end = Date.parse(to)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 93 * 86400000) throw new HTTPError({ statusCode: 400, message: 'A valid date range of at most 93 days is required' })
    const productId = requiredString(args, 'product_id')
    await assertProductAccess(db, { ...principal, productId })
    const product = await queryFirst(db, 'SELECT id FROM products WHERE id = ? AND organization_id = ?', [productId, organizationId])
    if (!product) throw new HTTPError({ statusCode: 404, message: 'Product not found in this organization' })
    await requireBookingConfig(db, organizationId, productId)
    await refreshProductBusy(db,env,organizationId,productId)
    const sessions = await listSessions(db, { organizationId, productId, fromInstant: new Date(start).toISOString(), toInstant: new Date(end).toISOString() })
    const page = paginateMcpCollection(sessions, args, { resource: `booking-sessions:${organizationId}:${productId}:${from}:${to}` })
    return { sessions: page.items, page_info: page.page_info }
  }
  if(toolName==='reassign_product_booking')return reassignBookingProvider({env,organizationId,userId:organization.userId},{booking_id:requiredString(args,'operational_booking_id'),member_id:requiredString(args,'member_id'),expected_updated_at:requiredString(args,'expected_updated_at'),idempotency_key:requiredString(args,'idempotency_key')})
  if (toolName === 'list_product_bookings') {
    const filters: string[] = ['b.organization_id = ?']
    const params: Array<string | number | null> = [organizationId]
    if (!managesBookings) { filters.push(assignedBookingSql('b')); params.push(organization.userId) }
    for (const [argument, column] of [['assigned_member_id', 'b.assigned_member_id'], ['product_id', 'b.product_id']] as const) {
      if (typeof args[argument] === 'string') { filters.push(`${column} = ?`); params.push(args[argument] as string) }
    }
    if (args.status === 'completed') filters.push("b.status = 'confirmed' AND s.ends_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    else if (typeof args.status === 'string') {
      filters.push('b.status = ?'); params.push(args.status)
      if (args.status === 'confirmed') filters.push("s.ends_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    }
    if (Object.hasOwn(args, 'location_id')) { filters.push('s.location_id IS ?'); params.push(args.location_id as string | null) }
    for (const [argument, operator] of [['from', '>='], ['to', '<']] as const) {
      if (args[argument] !== undefined) {
        const instant = new Date(requiredString(args, argument))
        if (!Number.isFinite(instant.getTime())) throw new HTTPError({ statusCode: 400, message: `${argument} must be an ISO instant` })
        filters.push(`s.starts_at ${operator} ?`); params.push(instant.toISOString())
      }
    }
    const resource = { resource: `product-bookings:${JSON.stringify({ filters, params })}` }
    const window = mcpPageWindow(args, resource)
    const rows = await queryAll<Record<string, unknown> & { status: BookingStatus; ends_at: string; guest_json: string | null; provenance_json: string | null }>(db, `SELECT b.id AS operational_booking_id, b.request_id, b.product_id, b.product_variant_id, b.product_session_id, b.status, b.party_size, b.user_id, b.updated_at, b.assigned_member_id, s.location_id, s.starts_at, s.ends_at, s.timezone, json_extract(r.payload_json, '$.guest') AS guest_json, json_extract(r.payload_json, '$.provenance') AS provenance_json FROM bookings b JOIN product_sessions s ON s.id = b.product_session_id AND s.organization_id = b.organization_id LEFT JOIN requests r ON r.id = b.request_id AND r.organization_id = b.organization_id WHERE ${filters.join(' AND ')} ORDER BY s.starts_at DESC, b.id LIMIT ? OFFSET ?`, [...params, window.limit + 1, window.offset])
    const now = new Date().toISOString()
    const bookings = rows.slice(0, window.limit).map(({ guest_json, provenance_json, ...booking }) => ({ ...booking, is_complete: isBookingComplete(booking, now), guest: guest_json === null ? null : JSON.parse(guest_json), provenance: mcpBookingProvenance(provenance_json === null ? null : JSON.parse(provenance_json)) }))
    return { bookings, page_info: mcpPageInfo(window, bookings.length, rows.length > window.limit, resource) }
  }
  if (toolName === 'create_table_reservation') {
    if (!event) throw new HTTPError({ statusCode: 500, message: 'Reservation creation requires the request context' })
    const locationId = requiredString(args, 'location_id')
    await assertResourceAccess(db, { ...memberAccessPrincipal(organization.membership, { env }), resourceLocationId: locationId })
    const result = await createTableReservation(event, { financialWritesAllowed: false, organizationId,
      body: { name: args.guest_name, email: args.guest_email, phone: args.guest_phone, locale: args.locale, date: args.date, time: args.time, guests: String(args.party_size), requests: args.notes, location_id: locationId },
      operator: { userId: organization.userId, idempotencyKey: requiredString(args, 'idempotency_key'), source: requiredString(args, 'source'), externalReference: optionalString(args, 'external_reference') ?? null, guestAcknowledgement: args.guest_acknowledgement === true },
    })
    return renderStructuredResponse({ success: result.status < 400, ...result.body, http_status: result.status }, undefined, undefined, result.status >= 400)
  }
  if (toolName === 'create_product_booking') {
    if (!event) throw new HTTPError({ statusCode: 500, message: 'Booking creation requires the request context' })
    const result = await createProductBooking(event, {
      organizationId, slug: requiredString(args, 'product_slug'), body: args, financialWritesAllowed: false,
      operator: { userId: organization.userId, idempotencyKey: requiredString(args, 'idempotency_key'), source: requiredString(args, 'source'), externalReference: optionalString(args, 'external_reference') ?? null, guestAcknowledgement: args.guest_acknowledgement === true },
    })
    return renderStructuredResponse({ success: result.status < 400, ...result.body, http_status: result.status }, undefined, undefined, result.status >= 400)
  }
  if (!['get_product_booking', 'confirm_product_booking', 'reject_product_booking', 'cancel_product_booking', 'request_product_booking_change', 'cancel_table_reservation', 'request_table_reservation_change'].includes(toolName)) return NOT_HANDLED
  const reservation = toolName.includes('table_reservation')
  const id = requiredString(args, reservation ? 'operational_reservation_id' : 'operational_booking_id')
  if (!reservation) await assertAssignedBookingAccess(db, { ...principal, bookingId: id })
  const row = await queryFirst<{ request_id: string | null; updated_at: string }>(db, `SELECT request_id, updated_at FROM ${reservation ? 'reservations' : 'bookings'} WHERE id = ? AND organization_id = ?`, [id, organizationId])
  if (!row?.request_id) throw new HTTPError({ statusCode: 404, message: 'Operational booking with an inbox thread not found in this organization' })
  const thread = await getGuestRequest(db, row.request_id, organizationId, reservation ? 'reservation' : 'booking')
  if (!thread) throw new HTTPError({ statusCode: 404, message: 'Booking thread not found' })
  let operationalRecord = await getThreadOperationalRecord(db, thread.id)
  if (!operationalRecord || operationalRecord.id !== id || operationalRecord.kind !== thread.kind || operationalRecord.organization_id !== organizationId) throw new HTTPError({ statusCode: 404, message: 'Operational booking record not found in this organization' })
  if (toolName === 'get_product_booking') {
    const provenance = thread.kind === 'booking' ? thread.payload.provenance : undefined
    return { operational_booking_id: id, request_id: thread.id, updated_at: thread.updated_at, operational_updated_at: row.updated_at, guest_user_id: thread.user_id, guest: thread.payload.guest,
      provenance: mcpBookingProvenance(provenance),
      record: mcpBookingRecord(operationalRecord) }
  }
  const key = requiredString(args, 'idempotency_key')
  if (toolName.startsWith('request_')) {
    if (!reservation) await assertAssignedBookingAccess(db, { ...principal, bookingId: id, sessionId: requiredString(args, 'session_id') })
    const fields = reservation ? { kind: 'reservation', overridePolicy: args.override_policy, locationId: requiredString(args, 'location_id'), bookingDate: requiredString(args, 'date'), bookingTime: requiredString(args, 'time'), partySize: args.party_size } : { kind: 'booking', sessionId: requiredString(args, 'session_id'), partySize: args.party_size }
    await requestBookingChange(db, env, thread, organization.userId, { ...fields, expectedUpdatedAt: requiredString(args, 'expected_updated_at') }, key)
    await publishGuestInboxThreadEvent(env, db, { threadId: thread.id, type: 'thread.changed' })
    operationalRecord = await getThreadOperationalRecord(db, thread.id)
    if (!operationalRecord || operationalRecord.id !== id || operationalRecord.kind !== thread.kind || operationalRecord.organization_id !== organizationId) throw new HTTPError({ statusCode: 404, message: 'Operational booking record not found in this organization' })
    return { success: true, request_id: thread.id, change_status: 'awaiting_guest_acceptance', record: mcpBookingRecord(operationalRecord) }
  }
  const outcome = await executeGuestThreadOperation(db, { threadId: thread.id, organizationId, action: toolName.split('_')[0]!, actorUserId: organization.userId, idempotencyKey: key, env, financialWritesAllowed: false })
  if (outcome.ok || outcome.reason === 'delivery_failed') await publishGuestInboxThreadEvent(env, db, { threadId: thread.id, type: 'thread.changed' })
  if (!outcome.ok) return renderStructuredResponse(outcome.reason === 'delivery_failed' && outcome.record
    ? { ...outcome, record: mcpBookingRecord(outcome.record) }
    : outcome, undefined, undefined, true)
  operationalRecord = await getThreadOperationalRecord(db, thread.id)
  if (!operationalRecord || operationalRecord.id !== id || operationalRecord.kind !== thread.kind || operationalRecord.organization_id !== organizationId) throw new HTTPError({ statusCode: 404, message: 'Operational booking record not found in this organization' })
  return renderStructuredResponse({
    ok: outcome.ok, status: outcome.status, request_id: outcome.thread.id,
    record: mcpBookingRecord(operationalRecord), availableActions: outcome.availableActions,
    thread: { id: outcome.thread.id, kind: outcome.thread.kind, conversation_state: outcome.thread.conversation_state },
  })
}
