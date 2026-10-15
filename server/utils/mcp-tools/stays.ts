import { organizationTool, type McpToolDefinition } from './shared'
import { NOT_HANDLED, requiredString, type McpExecutorContext } from './execution'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { cancelStay, createStay, deleteStayPayment, getStay, listStays, readStayCalendar, recordStayPayment, setStayNights, stayAccessFor, updateStay, STAY_CHANNELS, STAY_PAYMENT_METHODS, STAY_STATUSES } from '~/server/domain/stays'

const text = { type: 'string', minLength: 1 }
const nullableText = { type: ['string', 'null'] }
const day = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const time = { type: ['string', 'null'], pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }
const minor = { type: 'integer', minimum: 0, description: 'Whole minor units of the organization currency, e.g. cents.' }
const productId = { type: 'string', minLength: 1, description: 'The place to stay: a product of kind stay, from list_products.' }
const stayId = { type: 'string', minLength: 1, description: 'Stay ID from list_stays.' }
const version = { type: 'integer', minimum: 1, description: 'The stay version from the latest read; a stale version is refused.' }
const key = { type: 'string', minLength: 1, maxLength: 200, description: 'Caller-supplied durable idempotency key. Reuse only for the identical stay.' }

const payment = { type: 'object', properties: { id: text, stay_id: text, amount_minor: { type: 'integer' }, currency: text, method: { type: 'string', enum: [...STAY_PAYMENT_METHODS] }, paid_on: day, reference: nullableText, note: nullableText, created_at: text, created_by: text },
  required: ['id', 'stay_id', 'amount_minor', 'currency', 'method', 'paid_on', 'reference', 'note', 'created_at', 'created_by'] }
const stayProperties = {
  id: text, product_id: text, location_id: text, timezone: text, channel: { type: 'string', enum: [...STAY_CHANNELS] }, owner: { type: 'string', enum: ['app', 'channel'] },
  status: { type: 'string', enum: [...STAY_STATUSES] }, overbooked: { type: 'boolean' }, check_in_date: day, check_out_date: day, arrival_time: time,
  adults: { type: 'integer' }, children: { type: 'integer' }, infants: { type: 'integer' }, guest_name: nullableText, guest_surname: nullableText,
  guest_email: nullableText, guest_phone: nullableText, user_id: nullableText, total_minor: { type: 'integer' }, currency: text, notes: nullableText,
  provider: nullableText, external_booking_id: nullableText, channel_booking_id: nullableText, cancelled_at: nullableText, cancellation_reason: nullableText,
  version: { type: 'integer' }, created_at: text, updated_at: text,
}
const stay = { type: 'object', properties: stayProperties, required: Object.keys(stayProperties) }
const channelPush = { type: ['object', 'null'], description: "What the home's connected channel took from this change: null when the home has no channel; needs_review with the reason when the channel did not take it.", properties: { state: { type: 'string', enum: ['pushed', 'needs_review'] }, detail: nullableText }, required: ['state', 'detail'] }
const stayDetail = { type: 'object', properties: { ...stayProperties, payments: { type: 'array', items: payment }, paid_minor: { type: 'integer' }, payment_status: { type: ['string', 'null'], enum: ['unpaid', 'partial', 'paid', 'overpaid', null] }, channel_push: channelPush },
  required: [...Object.keys(stayProperties), 'payments', 'paid_minor', 'payment_status'] }
const home = { type: 'object', properties: { product_id: text, name: text, location_id: text, timezone: text, currency: text, base_price_minor: { type: ['integer', 'null'] }, check_in_time: text, check_out_time: text, max_guests: { type: 'integer' }, min_nights: { type: 'integer' },
  assigned_member_id: { ...nullableText, description: 'The member (member id) who looks after this home.' }, assigned_team_id: { ...nullableText, description: 'The team that looks after this home.' },
  channel: { type: ['object', 'null'], description: 'The channel this home is connected to; null when it is kept only in KrabiClaw and its night changes go nowhere else.', properties: { provider: { type: 'string', enum: ['channex'] }, status: { type: 'string', enum: ['importing', 'connected', 'disconnected'] } }, required: ['provider', 'status'] } },
  required: ['product_id', 'name', 'location_id', 'timezone', 'currency', 'base_price_minor', 'check_in_time', 'check_out_time', 'max_guests', 'min_nights', 'assigned_member_id', 'assigned_team_id', 'channel'] }
const night = { type: 'object', properties: { date: day, available: { type: 'boolean' }, stay_id: nullableText, closed: { type: 'boolean' }, price_minor: { type: ['integer', 'null'] }, min_stay_arrival: { type: ['integer', 'null'] }, min_stay_through: { type: ['integer', 'null'] }, max_stay: { type: ['integer', 'null'] }, closed_to_arrival: { type: 'boolean' }, closed_to_departure: { type: 'boolean' }, source: { type: ['string', 'null'], enum: ['host', 'import', null] },
  channel: { type: ['object', 'null'], properties: { state: { type: 'string', enum: ['pending', 'pushed', 'needs_review'] }, detail: nullableText }, required: ['state', 'detail'] } },
  required: ['date', 'available', 'stay_id', 'closed', 'price_minor', 'min_stay_arrival', 'min_stay_through', 'max_stay', 'closed_to_arrival', 'closed_to_departure', 'source', 'channel'] }
const calendar = { type: 'object', properties: { home, nights: { type: 'array', items: night }, stays: { type: 'array', items: stay }, channel_push: channelPush }, required: ['home', 'nights', 'stays'] }
const guestFields = {
  check_in_date: day, check_out_date: { ...day, description: 'The morning the guest leaves; the stay holds the nights before it.' }, arrival_time: time,
  adults: { type: 'integer', minimum: 1, maximum: 99 }, children: { type: 'integer', minimum: 0, maximum: 99 }, infants: { type: 'integer', minimum: 0, maximum: 99 },
  guest_name: { type: 'string', minLength: 1, maxLength: 200 }, guest_surname: { type: ['string', 'null'], maxLength: 200 }, guest_email: { type: ['string', 'null'] },
  guest_phone: { type: ['string', 'null'], description: 'International phone number with calling code.' }, total_minor: minor, notes: { type: ['string', 'null'], maxLength: 2000 },
}

export const STAYS_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_stays', domain: 'stays', minimumRole: 'member', description: 'Read guests staying at the organization’s places to stay overlapping a date range, with dates, party, channel and status. Members see only the homes they look after.',
    inputSchema: { from: day, to: { ...day, description: 'Exclusive; at most 400 days after from.' }, product_id: productId, include_cancelled: { type: 'boolean' } }, required: ['from', 'to'],
    outputSchema: { type: 'object', properties: { stays: { type: 'array', items: stay } }, required: ['stays'] } }),
  organizationTool({ name: 'get_stay', domain: 'stays', minimumRole: 'member', description: 'Read one stay with its guest details and, for a stay the host took, the payments recorded against it.',
    inputSchema: { stay_id: stayId }, required: ['stay_id'], outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'get_stay_calendar', domain: 'stays', minimumRole: 'member', description: 'Read every night of a date range at one place to stay: whether it is free, its price and stay rules, and the stay holding it.',
    inputSchema: { product_id: productId, from: day, to: { ...day, description: 'Exclusive; at most 500 days after from.' } }, required: ['product_id', 'from', 'to'], outputSchema: calendar }),
  organizationTool({ name: 'create_stay', domain: 'stays', minimumRole: 'admin', description: 'Add a stay the host took directly (phone, repeat guest) at a place to stay. It holds its nights; a night another stay already holds refuses it with STAY_OVERLAP. Takes no payment and sends no guest email.',
    inputSchema: { product_id: productId, ...guestFields, idempotency_key: key }, required: ['product_id', 'check_in_date', 'check_out_date', 'adults', 'guest_name', 'total_minor', 'idempotency_key'],
    outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'update_stay', domain: 'stays', minimumRole: 'admin', description: 'Change a stay the host took: dates, party, guest details, total or notes. Fields left out keep their values. Stays from Airbnb or another channel change only on that channel.',
    inputSchema: { stay_id: stayId, expected_version: version, ...guestFields }, required: ['stay_id', 'expected_version'],
    outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'cancel_stay', domain: 'stays', minimumRole: 'admin', description: 'Cancel a stay the host took and free its nights. Refunds are recorded separately with record_stay_payment as a negative amount.',
    inputSchema: { stay_id: stayId, expected_version: version, reason: { type: 'string', maxLength: 500 } }, required: ['stay_id', 'expected_version'],
    outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'record_stay_payment', domain: 'stays', minimumRole: 'admin', description: 'Record money the host received outside KrabiClaw for a stay they took (cash, bank transfer, a card machine). A negative amount records a refund. Moves no money.',
    inputSchema: { stay_id: stayId, amount_minor: { type: 'integer', description: 'Whole minor units; negative for a refund, never zero.' }, method: { type: 'string', enum: [...STAY_PAYMENT_METHODS] }, paid_on: day, reference: { type: 'string', maxLength: 200 }, note: { type: 'string', maxLength: 1000 }, idempotency_key: { ...key, description: 'Caller-supplied durable key. A retry with it returns the stay without a second payment.' } },
    required: ['stay_id', 'amount_minor', 'method', 'paid_on', 'idempotency_key'], outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'delete_stay_payment', domain: 'stays', minimumRole: 'admin', description: 'Remove a payment recorded by mistake from a stay.',
    inputSchema: { stay_id: stayId, payment_id: text }, required: ['stay_id', 'payment_id'], outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'set_stay_nights', domain: 'stays', minimumRole: 'admin', description: 'Close or open nights, set a nightly price, or set stay rules for a date range at one place to stay. Fields left out keep each night’s value; price_minor null returns to the base price; reset removes the range’s overrides.',
    inputSchema: { product_id: productId, from: day, to: { ...day, description: 'Exclusive; at most 500 days after from.' }, closed: { type: 'boolean' }, price_minor: { type: ['integer', 'null'], minimum: 0 },
      min_stay_arrival: { type: ['integer', 'null'], minimum: 1 }, min_stay_through: { type: ['integer', 'null'], minimum: 1 }, max_stay: { type: ['integer', 'null'], minimum: 1 },
      closed_to_arrival: { type: 'boolean' }, closed_to_departure: { type: 'boolean' }, reset: { type: 'boolean' } },
    required: ['product_id', 'from', 'to'], outputSchema: calendar }),
]

export async function handleStaysTools(ctx: McpExecutorContext): Promise<unknown> {
  const { organization, args, toolName } = ctx
  const { db, env } = organization
  const access = await stayAccessFor(memberAccessPrincipal(organization.membership, { env }))
  switch (toolName) {
    case 'list_stays': return { stays: await listStays(db, access, { from: args.from, to: args.to, productId: args.product_id as string | undefined, includeCancelled: args.include_cancelled === true }) }
    case 'get_stay': return { stay: await getStay(db, access, requiredString(args, 'stay_id')) }
    case 'get_stay_calendar': return readStayCalendar(db, access, { productId: requiredString(args, 'product_id'), from: args.from, to: args.to })
    case 'create_stay': return { stay: await createStay(db, env, access, { ...args, product_id: requiredString(args, 'product_id'), idempotency_key: requiredString(args, 'idempotency_key') }) }
    case 'update_stay': {
      const { stay_id: _id, ...patch } = args
      return { stay: await updateStay(db, env, access, requiredString(args, 'stay_id'), patch as Record<string, unknown> & { expected_version: unknown }) }
    }
    case 'cancel_stay': return { stay: await cancelStay(db, env, access, requiredString(args, 'stay_id'), { expected_version: args.expected_version, reason: args.reason }) }
    case 'record_stay_payment': return { stay: await recordStayPayment(db, access, requiredString(args, 'stay_id'), args) }
    case 'delete_stay_payment': return { stay: await deleteStayPayment(db, access, requiredString(args, 'stay_id'), requiredString(args, 'payment_id')) }
    case 'set_stay_nights': return setStayNights(db, env, access, { ...args, product_id: requiredString(args, 'product_id'), from: args.from, to: args.to })
    default: return NOT_HANDLED
  }
}
