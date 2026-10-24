import { STAY_ARRIVAL_TEXT_LIMITS, STAY_CHECKOUT_DETAILS_LIMIT } from '~/shared/stay-arrival'
import { organizationTool, PHONE_FORMAT, type McpToolDefinition } from './shared'
import { NOT_HANDLED, requiredString, type McpExecutorContext } from './execution'
import { CHANNEL_PUSH_SCHEMA } from '~/shared/channel-push'
import { STAY_BOOKED_POLICIES } from '~/shared/stay-cancellation'
import { STAY_MAP_SHARING_MODES, STAY_AMENITIES, STAY_CANCELLATION_POLICIES, STAY_CHECK_IN_METHODS, STAY_CHECKOUT_TASKS, STAY_LISTING_TYPES, STAY_LONG_TERM_CANCELLATION_POLICIES, STAY_PROPERTY_SIZE_UNITS, STAY_PROPERTY_TYPE_GROUPS, STAY_PROPERTY_TYPES } from '~/shared/stay-listing'
import { MAX_STAY_BEDS_PER_TYPE, STAY_BED_TYPES, STAY_PHOTO_ROOM_TYPES } from '~/shared/stay-photos'
import { STAY_HOME_ACCESSIBILITY_FEATURES, STAY_ROOM_ACCESSIBILITY_FEATURES } from '~/shared/stay-accessibility'
import { MAX_ORDERED_MEDIA_ASSETS } from '~/shared/media-placement-contract'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { cancelStay, createStay, createStayPhotoRoom, deleteStayPayment, getStay, listStays, moveStayPhotos, readStayCalendar, recordStayPayment, removeStayPhotoRoom, setStayNights, stayAccessFor, updateStay, updateStayHomeAccessibility, updateStayPhotoRoom, STAY_CHANNELS, STAY_PAYMENT_METHODS, STAY_STATUSES } from '~/server/domain/stays'

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
  provider: nullableText, external_booking_id: nullableText, channel_booking_id: nullableText, request_id: { ...nullableText, description: 'The guest conversation about this stay, for get_guest_conversation and reply_to_guest. Null until a named guest with email or phone opens one; an existing conversation is retained.' }, cancelled_at: nullableText, cancellation_reason: nullableText,
  cancellation_policy: { type: ['string', 'null'], enum: [...STAY_BOOKED_POLICIES, null], description: 'The home cancellation policy the guest booked under on the site; it decides what their own cancellation refunds. Null for a stay not paid on the site.' },
  version: { type: 'integer' }, created_at: text, updated_at: text,
}
const stay = { type: 'object', properties: stayProperties, required: Object.keys(stayProperties) }
const channelPush = { ...CHANNEL_PUSH_SCHEMA, description: "What the home's connected channel took from this change: null when no channel push is needed; pushed only when delivery completed. A failed channel update returns a committed error." }
const onlinePayment = { type: ['object', 'null'], description: 'The Stripe payment the guest made when booking this stay on the site; null for a stay booked any other way. paid_minor counts it net of refunds.',
  properties: { payment_id: text, state: { type: 'string', enum: ['pending', 'captured', 'failed', 'recovery', 'refunded'] }, currency: text, amount_minor: { type: 'integer' }, captured_minor: { type: 'integer' }, refunded_minor: { type: 'integer' }, receipt_url: nullableText, created_at: text },
  required: ['payment_id', 'state', 'currency', 'amount_minor', 'captured_minor', 'refunded_minor', 'receipt_url', 'created_at'] }
export const stayDetail = { type: 'object', properties: { ...stayProperties, payments: { type: 'array', items: payment }, online_payment: onlinePayment, paid_minor: { type: 'integer' }, payment_status: { type: ['string', 'null'], enum: ['unpaid', 'partial', 'paid', 'overpaid', null] }, channel_push: channelPush },
  required: [...Object.keys(stayProperties), 'payments', 'online_payment', 'paid_minor', 'payment_status'] }
const nullableCode = (vocabulary: Record<string, unknown>, description: string) => ({ type: ['string', 'null'], enum: [...Object.keys(vocabulary), null], description })
/** What a home is and offers: public product stay settings. */
export const STAY_LISTING_SCHEMA = {
  property_type_group: nullableCode(STAY_PROPERTY_TYPE_GROUPS, `Airbnb's property group: ${Object.entries(STAY_PROPERTY_TYPE_GROUPS).map(([code, group]) => `${code} (${group.label}: ${group.types.join(', ')})`).join('; ')}. Set with property_type, both or neither.`),
  property_type: nullableCode(STAY_PROPERTY_TYPES, 'Airbnb property type, one the property_type_group offers. Null with property_type_group when not said.'),
  listing_type: nullableCode(STAY_LISTING_TYPES, 'Whether guests book the entire place, a private room or a shared room. Null when not said.'),
  total_floors: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'Total floors in the property; null when not said.' },
  listing_floor: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'The listing’s floor, counted from 1. Cannot exceed total_floors when both are known; null when not said.' },
  year_built: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'Year the property was built; null when not said.' },
  property_size: { type: ['number', 'null'], exclusiveMinimum: 0, description: 'Property area in property_size_unit. Size and unit must both be set or both null.' },
  property_size_unit: nullableCode(STAY_PROPERTY_SIZE_UNITS, 'The unit of property_size. Size and unit must both be set or both null.'),
  bedrooms: { type: ['integer', 'null'], minimum: 0, maximum: 50, description: 'Bedrooms; 0 is a studio.' },
  beds: { type: ['integer', 'null'], minimum: 1, maximum: 50 },
  bathrooms: { type: ['number', 'null'], minimum: 0, maximum: 50, multipleOf: 0.5, description: 'Whole and half baths, such as 1.5.' },
  amenities: { type: 'array', uniqueItems: true, items: { type: 'string', enum: Object.keys(STAY_AMENITIES) }, description: 'Amenity codes the home offers; replaces the whole list. Empty offers none.' },
  amenity_answers: { type: 'array', items: { type: 'object', properties: { code: { type: 'string', enum: Object.keys(STAY_AMENITIES) }, available: { type: 'boolean' } }, required: ['code', 'available'], additionalProperties: false }, description: 'Explicit amenity reports, each code once, in catalog order. Missing codes are unknown. amenities is the true-only projection.' },
  cancellation_policy: nullableCode(STAY_CANCELLATION_POLICIES, 'Policy shown to guests for stays under 28 nights. It does not refund by itself.'),
  long_term_cancellation_policy: nullableCode(STAY_LONG_TERM_CANCELLATION_POLICIES, 'Policy shown to guests for stays of 28 nights or more.'),
}
export const STAY_LISTING_WRITE_SCHEMA = { ...STAY_LISTING_SCHEMA, amenity_answers: { ...STAY_LISTING_SCHEMA.amenity_answers,
  items: { ...STAY_LISTING_SCHEMA.amenity_answers.items, properties: { ...STAY_LISTING_SCHEMA.amenity_answers.items.properties, available: { type: ['boolean', 'null'] } } },
  description: 'Sparse amenity answer patch: true offers it, false explicitly reports absence, null clears to unknown. Omitted codes remain. Positive-list edits preserve false reports and remove omitted positive reports to unknown. Contradictions between amenities and amenity_answers are refused.',
} }
const checkoutInstruction = { type: 'object', properties: { task: { type: 'string', enum: Object.keys(STAY_CHECKOUT_TASKS) }, details: { type: ['string', 'null'], minLength: 1, maxLength: STAY_CHECKOUT_DETAILS_LIMIT, description: 'Required for additional.' } }, required: ['task', 'details'], additionalProperties: false }
/** The private arrival guide: managers and assigned members read it; no public page carries it. */
export const STAY_ARRIVAL_SCHEMA = {
  check_in_method: nullableCode(STAY_CHECK_IN_METHODS, 'How guests get in.'),
  check_in_instructions: { type: ['string', 'null'], minLength: 1, maxLength: STAY_ARRIVAL_TEXT_LIMITS.check_in_instructions },
  wifi_network: { type: ['string', 'null'], minLength: 1, maxLength: STAY_ARRIVAL_TEXT_LIMITS.wifi_network },
  wifi_password: { type: ['string', 'null'], minLength: 1, maxLength: STAY_ARRIVAL_TEXT_LIMITS.wifi_password },
  directions: { type: ['string', 'null'], minLength: 1, maxLength: STAY_ARRIVAL_TEXT_LIMITS.directions },
  house_manual: { type: ['string', 'null'], minLength: 1, maxLength: STAY_ARRIVAL_TEXT_LIMITS.house_manual },
  checkout_instructions: { type: 'array', items: checkoutInstruction, description: 'What guests do before leaving, in order, each task once; replaces the whole list.' },
}
const homeAddress = { type: ['object', 'null'], properties: { address: text, city: nullableText, state: nullableText, country: { type: 'string', pattern: '^[A-Z]{2}$' }, zip_code: nullableText }, required: ['address', 'city', 'state', 'country', 'zip_code'] }
const photo = { type: 'object', properties: { id: text, kind: { type: 'string', enum: ['image', 'video'] }, url: { ...text, description: 'The picture to show; a video shows its poster frame.' }, width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] }, alt_text: nullableText, position: { type: 'integer', minimum: 0 } },
  required: ['id', 'kind', 'url', 'width', 'height', 'alt_text', 'position'] }
const roomType = { type: 'string', enum: Object.keys(STAY_PHOTO_ROOM_TYPES) }
const sleepingArrangements = { type: ['array', 'null'], maxItems: Object.keys(STAY_BED_TYPES).length, description: 'Room allocations from the declared listing bed total. Null is unanswered; [] explicitly states none. Each bed type occurs once; all room quantities together must fit within a known listing beds total.', items: {
  type: 'object', properties: { type: { type: 'string', enum: Object.keys(STAY_BED_TYPES) }, count: { type: 'integer', minimum: 1, maximum: MAX_STAY_BEDS_PER_TYPE } }, required: ['type', 'count'], additionalProperties: false,
} }
const roomDetailsVersion = { type: 'integer', minimum: 1, description: 'The room details_version from the latest photo_rooms read. A stale version refuses the entire edit.' }
const privateBathroom = { type: ['boolean', 'null'], description: 'Whether this bedroom has a private attached bathroom. Null is unanswered. Only bedrooms may author this fact.' }
const roomAmenities = { ...STAY_LISTING_SCHEMA.amenities, description: 'Amenities assigned to this room, each once. Replaces only this room’s memberships; [] unassigns all. Selected codes are added to the canonical listing amenity set atomically, while unassigning never removes a listing amenity.' }
const accessibilityAnswerSchema = (features: object) => ({ type: 'object', properties: {
  feature: { type: 'string', enum: Object.keys(features) },
  available: { type: ['boolean', 'null'], description: 'The host’s answer, without a review or approval status. Null clears the answer to unknown.' },
  photo_ids: { type: 'array', items: text, uniqueItems: true, maxItems: MAX_ORDERED_MEDIA_ASSETS, description: 'Same-organization active image asset IDs in canonical Product photo order. A true answer needs evidence; false/null requires []. Save appends selected library images to Product photos atomically, preserving existing cover/order without assigning a tour room.' },
}, required: ['feature', 'available', 'photo_ids'], additionalProperties: false,
oneOf: [{ properties: { available: { const: true }, photo_ids: { minItems: 1 } } }, { properties: { available: { enum: [false, null] }, photo_ids: { maxItems: 0 } } }] })
const accessibilityAnswer = accessibilityAnswerSchema(STAY_ROOM_ACCESSIBILITY_FEATURES)
const homeAccessibilityAnswer = accessibilityAnswerSchema(STAY_HOME_ACCESSIBILITY_FEATURES)
export const STAY_HOME_ACCESSIBILITY_SCHEMA = { type: 'array', minItems: Object.keys(STAY_HOME_ACCESSIBILITY_FEATURES).length, maxItems: Object.keys(STAY_HOME_ACCESSIBILITY_FEATURES).length, items: homeAccessibilityAnswer, description: 'All six listing accessibility features in catalog order, including unknown null answers. Written only through update_stay_accessibility; separate from authored room features.' }
export const STAY_PHOTO_ROOM_SCHEMA = { type: 'object', properties: { id: text, type: roomType, photo_ids: { type: 'array', items: text, uniqueItems: true }, details_version: roomDetailsVersion, sleeping_arrangements: sleepingArrangements, private_attached_bathroom: privateBathroom, amenities: roomAmenities, accessibility: { type: 'array', maxItems: Object.keys(STAY_ROOM_ACCESSIBILITY_FEATURES).length, items: accessibilityAnswer, description: 'Both bedroom features in catalog order, including unanswered null rows; [] for other room types.' } }, required: ['id', 'type', 'photo_ids', 'details_version', 'sleeping_arrangements', 'private_attached_bathroom', 'amenities', 'accessibility'], additionalProperties: false }
const movePhotos = { type: 'array', minItems: 1, maxItems: MAX_ORDERED_MEDIA_ASSETS, items: { type: 'object', properties: {
  photo_id: text, expected_room_id: { ...nullableText, description: 'The room from the latest photo_rooms read; null only when the photo is unassigned. A changed membership refuses the whole move.' },
}, required: ['photo_id', 'expected_room_id'], additionalProperties: false } }
export const AIRBNB_UNSYNCED_SCHEMA = { type: 'array', description: 'Airbnb editor links for supplied fields that have a mapped editor page. Each entry identifies a field saved in KrabiClaw for the host to check and edit in Airbnb. Empty when no mapped fields were supplied or the home is not connected.', items: { type: 'object', properties: { field: text, airbnb_url: { type: 'string', format: 'uri' } }, required: ['field', 'airbnb_url'], additionalProperties: false } }
export const stayHomeObject = { type: 'object', properties: { product_id: text, product_updated_at: { ...text, description: 'The Product updated_at value to supply as expected_updated_at when saving listing accessibility.' }, name: text, location_id: text, timezone: text, currency: text, airbnb_listing_id: { ...nullableText, description: 'Mapped Airbnb listing ID; null when no listing is mapped.' }, airbnb_editor_url: { ...nullableText, format: 'uri', description: 'The mapped listing’s Airbnb editor, or null when no listing is mapped.' }, base_price_minor: { type: ['integer', 'null'] }, base_price_tax_behavior: { type: ['string', 'null'], enum: ['unspecified', 'inclusive', 'exclusive', null] }, check_in_time: text, check_in_end_time: { ...nullableText, description: 'The end of the check-in window, local HH:MM; null is a flexible end.' }, check_out_time: text, max_guests: { type: 'integer' }, min_nights: { type: 'integer' },
  description: { type: 'string', description: 'The listing description; empty when none is written.' }, published: { type: 'boolean', description: 'Whether the home is listed on the site.' },
  address: { ...homeAddress, description: "The home's address: street, city, state, ISO country and postal code. Null only for a location saved without one." }, latitude: { type: ['number', 'null'] }, longitude: { type: ['number', 'null'] },
  stay_map_sharing: { type: 'string', enum: [...STAY_MAP_SHARING_MODES], description: 'The shared Location map setting. The street address stays private in either mode; confirmed guests receive the exact Location.' },
  ...STAY_LISTING_SCHEMA, ...STAY_ARRIVAL_SCHEMA,
  smoke_detector_details: { ...nullableText, maxLength: 300, description: 'Where each smoke alarm is located; a projection of Product.details, present only while the amenity is true.' },
  carbon_monoxide_detector_details: { ...nullableText, maxLength: 300, description: 'Where each carbon monoxide alarm is located; a projection of Product.details, present only while the amenity is true.' },
  assigned_member_id: { ...nullableText, description: 'The member (member id) who looks after this home.' }, assigned_team_id: { ...nullableText, description: 'The team that looks after this home.' },
  channel: { type: ['object', 'null'], description: 'The channel this home is connected to; null when it is kept only in KrabiClaw and its night changes go nowhere else.', properties: { provider: { type: 'string', enum: ['channex'] }, status: { type: 'string', enum: ['importing', 'connected', 'disconnected'] } }, required: ['provider', 'status'] },
  photos: { type: 'array', description: "The home's photos in order, the cover first: its product's image, then its gallery. id is the media asset id; set_media, attach_media, reorder_media, remove_media and update_media_asset change them.", items: photo },
  photo_rooms: { type: 'array', description: 'Authored photo-tour rooms and spaces. photo_ids follow the Product photo order; unassigned photos are Additional photos. Counts and amenities never create rooms.', items: STAY_PHOTO_ROOM_SCHEMA }, accessibility: STAY_HOME_ACCESSIBILITY_SCHEMA },
  required: ['product_id', 'product_updated_at', 'name', 'location_id', 'timezone', 'currency', 'airbnb_listing_id', 'airbnb_editor_url', 'base_price_minor', 'base_price_tax_behavior', 'check_in_time', 'check_in_end_time', 'check_out_time', 'max_guests', 'min_nights',
    'description', 'published', 'address', 'latitude', 'longitude', 'stay_map_sharing', ...Object.keys(STAY_LISTING_SCHEMA), ...Object.keys(STAY_ARRIVAL_SCHEMA), 'smoke_detector_details', 'carbon_monoxide_detector_details', 'assigned_member_id', 'assigned_team_id', 'channel', 'photos', 'photo_rooms', 'accessibility'] }
const night = { type: 'object', properties: { date: day, available: { type: 'boolean' }, stay_id: nullableText, held_until: { ...nullableText, description: 'When a guest checkout hold on this night lapses; null when no guest is paying for it. A held night is not available.' }, closed: { type: 'boolean' }, price_minor: { type: ['integer', 'null'] }, min_stay_arrival: { type: ['integer', 'null'] }, min_stay_through: { type: ['integer', 'null'] }, max_stay: { type: ['integer', 'null'] }, closed_to_arrival: { type: 'boolean' }, closed_to_departure: { type: 'boolean' }, source: { type: ['string', 'null'], enum: ['host', 'import', null] },
  calendar: { type: ['string', 'null'], enum: ['vrbo', null], description: 'The linked calendar (Vrbo) that shows this night taken; null when none does. Such a night is not available.' },
  channel: { type: ['object', 'null'], properties: { state: { type: 'string', enum: ['pending', 'pushed', 'needs_review'] }, detail: nullableText }, required: ['state', 'detail'] } },
  required: ['date', 'available', 'stay_id', 'closed', 'price_minor', 'min_stay_arrival', 'min_stay_through', 'max_stay', 'closed_to_arrival', 'closed_to_departure', 'source', 'held_until', 'calendar', 'channel'] }
const calendar = { type: 'object', properties: { home: stayHomeObject, nights: { type: 'array', items: night }, stays: { type: 'array', items: stay }, channel_push: channelPush }, required: ['home', 'nights', 'stays'] }
const guestFields = {
  check_in_date: day, check_out_date: { ...day, description: 'The morning the guest leaves; the stay holds the nights before it.' }, arrival_time: time,
  adults: { type: 'integer', minimum: 1, maximum: 99 }, children: { type: 'integer', minimum: 0, maximum: 99 }, infants: { type: 'integer', minimum: 0, maximum: 99 },
  guest_name: { type: 'string', minLength: 1, maxLength: 200 }, guest_surname: { type: ['string', 'null'], maxLength: 200 }, guest_email: { type: ['string', 'null'] },
  guest_phone: { type: ['string', 'null'], description: PHONE_FORMAT }, total_minor: minor, notes: { type: ['string', 'null'], maxLength: 2000 },
}

export const STAYS_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_stays', domain: 'stays', minimumRole: 'member', description: 'Read guests staying at the organization’s places to stay overlapping a date range, with dates, party, channel and status. Members see only the homes they look after.',
    inputSchema: { from: day, to: { ...day, description: 'Exclusive; at most 400 days after from.' }, product_id: productId, include_cancelled: { type: 'boolean' } }, required: ['from', 'to'],
    outputSchema: { type: 'object', properties: { stays: { type: 'array', items: stay } }, required: ['stays'] } }),
  organizationTool({ name: 'get_stay', domain: 'stays', minimumRole: 'member', description: 'Read one stay with its guest details and, for a stay the host took, the payments recorded against it.',
    inputSchema: { stay_id: stayId }, required: ['stay_id'], outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'get_stay_calendar', domain: 'stays', minimumRole: 'member', description: 'Read every night of a date range at one place to stay: whether it is free, its price and stay rules, and the stay holding it.',
    inputSchema: { product_id: productId, from: day, to: { ...day, description: 'Exclusive; at most 500 days after from.' } }, required: ['product_id', 'from', 'to'], outputSchema: calendar }),
  organizationTool({ name: 'add_stay_photo_room', domain: 'stays', minimumRole: 'admin', description: 'Add an authored room or space to a home’s photo tour. Does not change bedrooms, beds, bathrooms or amenities. Returns the created room’s authoritative ID and the updated home. Saved in KrabiClaw; the connected Airbnb listing’s photo tour and accessibility details are edited in Airbnb.',
    inputSchema: { product_id: productId, type: roomType }, required: ['product_id', 'type'],
    outputSchema: { type: 'object', properties: { home: stayHomeObject, room: STAY_PHOTO_ROOM_SCHEMA }, required: ['home', 'room'] } }),
  organizationTool({ name: 'update_stay_accessibility', domain: 'stays', minimumRole: 'admin', description: 'Save one listing accessibility answer under the Product updated_at value from the latest read. Other feature answers and authored rooms are retained. True requires active same-organization image evidence and atomically appends selected library images to Product photos, preserving existing cover/order and room groups. False/null requires []; null clears to unknown. Evidence photos cannot be removed until replaced or the answer cleared. No review or approval is implied. A stale Product or photo order refuses every change. Saved in KrabiClaw; the connected Airbnb listing’s photo tour and accessibility details are edited in Airbnb.',
    inputSchema: { product_id: productId, expected_updated_at: { ...text, description: 'Product updated_at from list_products, or product_updated_at from the Home. A stale value refuses the entire edit.' }, accessibility: homeAccessibilityAnswer }, required: ['product_id', 'expected_updated_at', 'accessibility'],
    outputSchema: { type: 'object', properties: { home: stayHomeObject }, required: ['home'] } }),
  organizationTool({ name: 'update_stay_photo_room', domain: 'stays', minimumRole: 'admin', description: 'Update one authored room under its details_version: sleeping arrangements, bedroom privacy, amenity memberships or one bedroom accessibility answer. Omitted concerns and other feature answers are retained. Beds allocate the declared listing total; selected amenities join the global listing set while deselection only unassigns. Accessibility true requires image evidence and atomically appends selected library images to Product photos without changing existing cover/order or tour groups. False/null requires no evidence; null clears to unknown. Referenced photos cannot be removed until evidence is replaced or the answer cleared. No review or approval is implied. A stale version or invalid combination refuses every change. Saved in KrabiClaw; the connected Airbnb listing’s photo tour and accessibility details are edited in Airbnb.',
    inputSchema: { product_id: productId, room_id: text, expected_details_version: roomDetailsVersion, sleeping_arrangements: sleepingArrangements, private_attached_bathroom: privateBathroom, amenities: roomAmenities, accessibility: accessibilityAnswer,
      anyOf: [{ required: ['sleeping_arrangements'] }, { required: ['private_attached_bathroom'] }, { required: ['amenities'] }, { required: ['accessibility'] }] }, required: ['product_id', 'room_id', 'expected_details_version'],
    outputSchema: { type: 'object', properties: { home: stayHomeObject, room: STAY_PHOTO_ROOM_SCHEMA }, required: ['home', 'room'] } }),
  organizationTool({ name: 'remove_stay_photo_room', domain: 'stays', minimumRole: 'admin', description: 'Delete one authored photo-tour room. Its photos return to Additional photos; the Product’s cover/gallery and library files are retained. Saved in KrabiClaw; the connected Airbnb listing’s photo tour and accessibility details are edited in Airbnb.',
    inputSchema: { product_id: productId, room_id: text }, required: ['product_id', 'room_id'],
    outputSchema: { type: 'object', properties: { home: stayHomeObject }, required: ['home'] } }),
  organizationTool({ name: 'move_stay_photos', domain: 'stays', minimumRole: 'admin', description: 'Move selected Product photos together to room_id, null for Additional photos, or a new room of new_room_type. Supply exactly one destination. Every photo needs its expected_room_id from photo_rooms; a changed source or removed photo refuses the entire move, including new room creation. Saved in KrabiClaw; the connected Airbnb listing’s photo tour and accessibility details are edited in Airbnb.',
    inputSchema: { product_id: productId, room_id: nullableText, new_room_type: roomType, photos: movePhotos }, required: ['product_id', 'photos'],
    outputSchema: { type: 'object', properties: { home: stayHomeObject }, required: ['home'] } }),
  organizationTool({ name: 'create_stay', domain: 'stays', minimumRole: 'admin', description: 'Add a stay the host took directly, such as by phone, and hold its nights. A night another stay already holds refuses it with STAY_OVERLAP. Takes no payment. Applies existing automatic guest-message schedules and updates availability on the home’s connected Airbnb listing through Channex. A failed channel update reports that the stay was saved; retry with the same idempotency key.',
    inputSchema: { product_id: productId, ...guestFields, idempotency_key: key }, required: ['product_id', 'check_in_date', 'check_out_date', 'adults', 'guest_name', 'total_minor', 'idempotency_key'],
    outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'update_stay', domain: 'stays', minimumRole: 'admin', description: 'Change a host-entered stay’s dates, party, guest details, total or notes under its current version. Omitted fields keep their values. Replans pending automatic guest messages and updates availability on the home’s connected Airbnb listing through Channex. A failed channel update reports that the stay edit was saved. Stays from another channel must be changed on that channel.',
    inputSchema: { stay_id: stayId, expected_version: version, ...guestFields }, required: ['stay_id', 'expected_version'],
    outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'cancel_stay', domain: 'stays', minimumRole: 'admin', description: 'Cancel a host-entered stay under its current version, free its nights, cancel pending automatic guest messages and update availability on the home’s connected Airbnb listing through Channex. A failed channel update reports that cancellation was saved. If a website payment needs a refund, returns financial_action_required with an authenticated dashboard link before cancellation or financial writes. Offline refunds can be recorded separately with record_stay_payment; that record moves no money.',
    inputSchema: { stay_id: stayId, expected_version: version, reason: { type: 'string', maxLength: 500 } }, required: ['stay_id', 'expected_version'],
    outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'record_stay_payment', domain: 'stays', minimumRole: 'admin', description: 'Record money the host received outside KrabiClaw for a stay they took (cash, bank transfer, a card machine). A negative amount records a refund. Moves no money.',
    inputSchema: { stay_id: stayId, amount_minor: { type: 'integer', description: 'Whole minor units; negative for a refund, never zero.' }, method: { type: 'string', enum: [...STAY_PAYMENT_METHODS] }, paid_on: day, reference: { type: 'string', maxLength: 200 }, note: { type: 'string', maxLength: 1000 }, idempotency_key: { ...key, description: 'Caller-supplied durable key. A retry with it returns the stay without a second payment.' } },
    required: ['stay_id', 'amount_minor', 'method', 'paid_on', 'idempotency_key'], outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'delete_stay_payment', domain: 'stays', minimumRole: 'admin', description: 'Remove a payment recorded by mistake from a stay.',
    inputSchema: { stay_id: stayId, payment_id: text }, required: ['stay_id', 'payment_id'], outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'set_stay_nights', domain: 'stays', minimumRole: 'admin', description: 'Close or open nights, set a nightly price, or set stay rules for a date range at one place to stay. Fields left out keep each night’s value; price_minor null returns to the base price; reset removes the range’s overrides. Updates the website’s bookable nights and, when connected, pushes prices, availability and stay rules to the home’s Airbnb listing through Channex. Returns channel_push on success. A failed channel update raises CHANNEL_PUSH_FAILED with committed:true; read the calendar before retrying.',
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
    case 'add_stay_photo_room': return createStayPhotoRoom(db, env, access, requiredString(args, 'product_id'), { type: args.type })
    case 'update_stay_accessibility': return updateStayHomeAccessibility(db, env, access, requiredString(args, 'product_id'), { expected_updated_at: args.expected_updated_at, accessibility: args.accessibility })
    case 'update_stay_photo_room': return updateStayPhotoRoom(db, env, access, requiredString(args, 'product_id'), requiredString(args, 'room_id'), {
      expected_details_version: args.expected_details_version,
      ...(Object.hasOwn(args, 'sleeping_arrangements') ? { sleeping_arrangements: args.sleeping_arrangements } : {}),
      ...(Object.hasOwn(args, 'private_attached_bathroom') ? { private_attached_bathroom: args.private_attached_bathroom } : {}),
      ...(Object.hasOwn(args, 'amenities') ? { amenities: args.amenities } : {}),
      ...(Object.hasOwn(args, 'accessibility') ? { accessibility: args.accessibility } : {}),
    })
    case 'remove_stay_photo_room': return { home: await removeStayPhotoRoom(db, env, access, requiredString(args, 'product_id'), requiredString(args, 'room_id')) }
    case 'move_stay_photos': return { home: await moveStayPhotos(db, env, access, requiredString(args, 'product_id'), { ...(Object.hasOwn(args, 'room_id') ? { room_id: args.room_id } : {}), ...(Object.hasOwn(args, 'new_room_type') ? { new_room_type: args.new_room_type } : {}), photos: args.photos }) }
    case 'create_stay': return { stay: await createStay(db, env, access, { ...args, product_id: requiredString(args, 'product_id'), idempotency_key: requiredString(args, 'idempotency_key') }) }
    case 'update_stay': {
      const { stay_id: _id, ...patch } = args
      return { stay: await updateStay(db, env, access, requiredString(args, 'stay_id'), patch as Record<string, unknown> & { expected_version: unknown }) }
    }
    case 'cancel_stay': return { stay: await cancelStay(db, env, access, requiredString(args, 'stay_id'), { expected_version: args.expected_version, reason: args.reason, financial_writes_allowed: false }) }
    case 'record_stay_payment': return { stay: await recordStayPayment(db, env, access, requiredString(args, 'stay_id'), args) }
    case 'delete_stay_payment': return { stay: await deleteStayPayment(db, env, access, requiredString(args, 'stay_id'), requiredString(args, 'payment_id')) }
    case 'set_stay_nights': return setStayNights(db, env, access, { ...args, product_id: requiredString(args, 'product_id'), from: args.from, to: args.to })
    default: return NOT_HANDLED
  }
}
