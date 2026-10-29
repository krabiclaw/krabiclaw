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
import { cancelStay, createStay, createStayPhotoRoom, deleteStayPayment, getStay, listStays, moveStayPhotos, readStayCalendar, recordStayPayment, removeStayPhotoRoom, setStayNights, stayAccessFor, updateStay, updateStayHomeAccessibility, updateStayPhotoRoom, STAY_STATUSES, type StayHome, type StayDetail } from '~/server/domain/stays'
import { STAY_CHANNELS, STAY_PAYMENT_METHODS } from '~/shared/bookings'

const text = { type: 'string', minLength: 1 }
const nullableText = { type: ['string', 'null'] }
const day = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const time = { type: ['string', 'null'], pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }
const minor = { type: 'integer', minimum: 0, description: 'Whole minor units of the organization currency, e.g. cents.' }
const productId = { type: 'string', minLength: 1, description: 'The place to stay: a product of kind stay, from list_products.' }
const stayId = { type: 'string', minLength: 1, description: 'Stay ID from list_stays.' }
const version = { type: 'integer', minimum: 1, description: 'stay.version from the latest get_stay call; a stale version is refused.' }
const key = { type: 'string', minLength: 1, maxLength: 200, description: 'Caller-supplied durable idempotency key. Reuse only for identical operation arguments.' }

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
const channelPush = { ...CHANNEL_PUSH_SCHEMA, description: "What the home's connected channel took from this change: null when no channel push is needed; pushed when delivery completed; pending, with the reason, while it waits out Channex's rate limit or an unconfirmed attempt it sends again. A refused channel update returns a committed error." }
const onlinePayment = { type: ['object', 'null'], description: 'The Stripe payment the guest made when booking this stay on the site; null for a stay booked any other way. paid_minor counts it net of refunds.',
  properties: { payment_id: text, state: { type: 'string', enum: ['pending', 'captured', 'failed', 'recovery', 'refunded'] }, currency: text, amount_minor: { type: 'integer' }, captured_minor: { type: 'integer' }, refunded_minor: { type: 'integer' }, receipt_url: nullableText, created_at: text },
  required: ['payment_id', 'state', 'currency', 'amount_minor', 'captured_minor', 'refunded_minor', 'receipt_url', 'created_at'] }
export const stayDetail = { type: 'object', properties: { ...stayProperties, guest_image_url: { ...nullableText, description: 'The linked Better Auth account’s current portrait. Null for guests without an account portrait.' }, payments: { type: 'array', items: payment }, online_payment: onlinePayment, paid_minor: { type: 'integer' }, payment_status: { type: ['string', 'null'], enum: ['unpaid', 'partial', 'paid', 'overpaid', null] }, channel_push: channelPush },
  required: [...Object.keys(stayProperties), 'guest_image_url', 'payments', 'online_payment', 'paid_minor', 'payment_status'] }
const nullableCode = (vocabulary: Record<string, unknown>, description: string) => ({ type: ['string', 'null'], enum: [...Object.keys(vocabulary), null], description })
/** What a home is and offers: public product stay settings. */
export const STAY_LISTING_SCHEMA = {
  property_type_group: nullableCode(STAY_PROPERTY_TYPE_GROUPS, `Airbnb's property group: ${Object.entries(STAY_PROPERTY_TYPE_GROUPS).map(([code, group]) => `${code} (${group.label}: ${group.types.join(', ')})`).join('; ')}.`),
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
  amenities: { type: 'array', uniqueItems: true, items: { type: 'string', enum: Object.keys(STAY_AMENITIES) }, description: 'Amenity codes the home offers. Empty means no positive amenity answers.' },
  amenity_answers: { type: 'array', items: { type: 'object', properties: { code: { type: 'string', enum: Object.keys(STAY_AMENITIES) }, available: { type: 'boolean' } }, required: ['code', 'available'], additionalProperties: false }, description: 'Explicit amenity reports, each code once, in catalog order. Missing codes are unknown. amenities is the true-only projection.' },
  cancellation_policy: { type: 'string', enum: Object.keys(STAY_CANCELLATION_POLICIES), description: 'Policy shown to guests for stays under 28 nights. A home always has one: a new home starts on Flexible, as a new Airbnb listing does, and an Airbnb import takes the listing’s own. It does not refund by itself.' },
  long_term_cancellation_policy: { type: 'string', enum: Object.keys(STAY_LONG_TERM_CANCELLATION_POLICIES), description: 'Policy shown to guests for stays of 28 nights or more. A home always has one: a new home starts on Firm Long Term, as a new Airbnb listing does, and an Airbnb import takes the listing’s own.' },
}
export const STAY_LISTING_WRITE_SCHEMA = { ...STAY_LISTING_SCHEMA,
  property_type_group: { ...STAY_LISTING_SCHEMA.property_type_group, description: `${STAY_LISTING_SCHEMA.property_type_group.description} Supply property_type with it; both are set or both null.` },
  amenities: { ...STAY_LISTING_SCHEMA.amenities, description: 'Amenity codes the home offers; replaces the whole positive list. Empty offers none.' }, amenity_answers: { ...STAY_LISTING_SCHEMA.amenity_answers,
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
const roomDetailsVersion = { type: 'integer', minimum: 1, description: 'Revision of this room’s details.' }
const expectedRoomDetailsVersion = { ...roomDetailsVersion, description: 'details_version of this room from get_product → product.stay.photo_rooms. A stale value refuses the entire edit.' }
const privateBathroom = { type: ['boolean', 'null'], description: 'Whether this bedroom has a private attached bathroom. Null is unanswered. Only bedrooms may author this fact.' }
const roomAmenities = { ...STAY_LISTING_SCHEMA.amenities, description: 'Amenities assigned to this room, each once.' }
const roomAmenitiesWrite = { ...roomAmenities, description: 'Replaces this room’s amenity memberships; [] unassigns all. Selected codes also join the home’s amenity set. Unassigning does not remove a home amenity.' }
const accessibilityAnswerSchema = (features: object) => ({ type: 'object', properties: {
  feature: { type: 'string', enum: Object.keys(features) },
  available: { type: ['boolean', 'null'], description: 'The host’s answer, without a review or approval status. Null clears the answer to unknown.' },
  photo_ids: { type: 'array', items: text, uniqueItems: true, maxItems: MAX_ORDERED_MEDIA_ASSETS, description: 'Same-organization active image asset IDs in canonical Product photo order. A true answer needs evidence; false/null requires []. Save appends selected library images to Product photos atomically, preserving existing cover/order without assigning a tour room.' },
}, required: ['feature', 'available', 'photo_ids'], additionalProperties: false,
oneOf: [{ properties: { available: { const: true }, photo_ids: { minItems: 1 } } }, { properties: { available: { enum: [false, null] }, photo_ids: { maxItems: 0 } } }] })
const accessibilityAnswer = accessibilityAnswerSchema(STAY_ROOM_ACCESSIBILITY_FEATURES)
const homeAccessibilityAnswer = accessibilityAnswerSchema(STAY_HOME_ACCESSIBILITY_FEATURES)
const accessibilityAnswerReadSchema = (answer: ReturnType<typeof accessibilityAnswerSchema>) => ({ ...answer, properties: { ...answer.properties,
  available: { type: ['boolean', 'null'], description: 'The host’s answer; null is unanswered. No review or approval is implied.' },
  photo_ids: { type: 'array', items: text, uniqueItems: true, maxItems: MAX_ORDERED_MEDIA_ASSETS, description: 'Evidence image IDs in the home’s Product photo order. Empty for false or unknown answers.' },
} })
export const STAY_HOME_ACCESSIBILITY_SCHEMA = { type: 'array', minItems: Object.keys(STAY_HOME_ACCESSIBILITY_FEATURES).length, maxItems: Object.keys(STAY_HOME_ACCESSIBILITY_FEATURES).length, items: accessibilityAnswerReadSchema(homeAccessibilityAnswer), description: 'All six home accessibility features in catalog order, including unanswered null rows.' }
const roomIdentityProperties = { id: text, type: roomType, photo_ids: { type: 'array', items: text, uniqueItems: true }, details_version: roomDetailsVersion }
const roomIdentity = { type: 'object', properties: roomIdentityProperties, required: Object.keys(roomIdentityProperties), additionalProperties: false }
export const STAY_PHOTO_ROOM_SCHEMA = { type: 'object', properties: { ...roomIdentityProperties, sleeping_arrangements: { ...sleepingArrangements, description: 'This room’s allocated beds. Null is unanswered; [] explicitly states none.' }, private_attached_bathroom: privateBathroom, amenities: roomAmenities, accessibility: { type: 'array', maxItems: Object.keys(STAY_ROOM_ACCESSIBILITY_FEATURES).length, items: accessibilityAnswerReadSchema(accessibilityAnswer), description: 'Both bedroom features in catalog order, including unanswered null rows; [] for other room types.' } }, required: ['id', 'type', 'photo_ids', 'details_version', 'sleeping_arrangements', 'private_attached_bathroom', 'amenities', 'accessibility'], additionalProperties: false }
const movePhotos = { type: 'array', minItems: 1, maxItems: MAX_ORDERED_MEDIA_ASSETS, items: { type: 'object', properties: {
  photo_id: { ...text, description: 'Image or video asset ID already placed on this home: get_product → product.image.asset_id or product.gallery[].asset_id.' }, expected_room_id: { ...nullableText, description: 'Containing room’s id from get_product → product.stay.photo_rooms; null if no room contains this photo. A changed membership refuses the whole assignment.' },
}, required: ['photo_id', 'expected_room_id'], additionalProperties: false } }
export const AIRBNB_UNSYNCED_SCHEMA = { type: 'array', description: 'Airbnb editor links for supplied fields that have a mapped editor page. Each entry identifies a field saved in KrabiClaw for the host to check and edit in Airbnb. Empty when no mapped fields were supplied or the home is not connected.', items: { type: 'object', properties: { field: text, airbnb_url: { type: 'string', format: 'uri' } }, required: ['field', 'airbnb_url'], additionalProperties: false } }
export const stayHomeObject = { type: 'object', properties: { product_id: text, product_updated_at: { ...text, description: 'The Product updated_at value to supply as expected_updated_at when saving listing accessibility.' }, name: text, location_id: text, timezone: text, currency: text, airbnb_listing_id: { ...nullableText, description: 'Mapped Airbnb listing ID; null when no listing is mapped.' }, airbnb_editor_url: { ...nullableText, format: 'uri', description: 'The mapped listing’s Airbnb editor, or null when no listing is mapped.' }, base_price_minor: { type: ['integer', 'null'] }, base_price_tax_behavior: { type: ['string', 'null'], enum: ['unspecified', 'inclusive', 'exclusive', null] }, check_in_time: text, check_in_end_time: { ...nullableText, description: 'The end of the check-in window, local HH:MM; null is a flexible end.' }, check_out_time: text, max_guests: { type: 'integer' }, min_nights: { type: 'integer' },
  description: { type: 'string', description: 'The listing description; empty when none is written.' }, published: { type: 'boolean', description: 'Whether the home is listed on the site.' },
  address: { ...homeAddress, description: "The home's address: street, city, state, ISO country and postal code. Null only for a location saved without one." }, latitude: { type: ['number', 'null'] }, longitude: { type: ['number', 'null'] },
  stay_map_sharing: { type: 'string', enum: [...STAY_MAP_SHARING_MODES], description: 'The shared Location map setting. The street address stays private in either mode; confirmed guests receive the exact Location.' },
  ...STAY_LISTING_SCHEMA, ...STAY_ARRIVAL_SCHEMA,
  checkout_instructions: { ...STAY_ARRIVAL_SCHEMA.checkout_instructions, description: 'What guests do before leaving, in order, each task once.' },
  smoke_detector_details: { ...nullableText, maxLength: 300, description: 'Where each smoke alarm is located; a projection of Product.details, present only while the amenity is true.' },
  carbon_monoxide_detector_details: { ...nullableText, maxLength: 300, description: 'Where each carbon monoxide alarm is located; a projection of Product.details, present only while the amenity is true.' },
  assigned_member_id: { ...nullableText, description: 'Better Auth organization membership ID of the home’s assigned host, not a user ID. The assignment also grants access to its stays.' }, assigned_team_id: { ...nullableText, description: 'Better Auth team ID assigned to host and look after this home; the assignment also grants access to its stays.' },
  channel: { type: ['object', 'null'], description: 'The channel this home is connected to; null when it is kept only in KrabiClaw and its night changes go nowhere else.', properties: { provider: { type: 'string', enum: ['channex'] }, status: { type: 'string', enum: ['importing', 'connected', 'disconnected'] } }, required: ['provider', 'status'] },
  photos: { type: 'array', description: "The home's photos in order, the cover first: its product's image, then its gallery. id is the media asset id; set_media, attach_media, reorder_media, remove_media and update_media_asset change them.", items: photo },
  photo_rooms: { type: 'array', description: 'Authored photo-tour rooms and spaces. photo_ids follow the Product photo order; unassigned photos are Additional photos. Counts and amenities never create rooms.', items: STAY_PHOTO_ROOM_SCHEMA }, accessibility: STAY_HOME_ACCESSIBILITY_SCHEMA },
  required: ['product_id', 'product_updated_at', 'name', 'location_id', 'timezone', 'currency', 'airbnb_listing_id', 'airbnb_editor_url', 'base_price_minor', 'base_price_tax_behavior', 'check_in_time', 'check_in_end_time', 'check_out_time', 'max_guests', 'min_nights',
    'description', 'published', 'address', 'latitude', 'longitude', 'stay_map_sharing', ...Object.keys(STAY_LISTING_SCHEMA), ...Object.keys(STAY_ARRIVAL_SCHEMA), 'smoke_detector_details', 'carbon_monoxide_detector_details', 'assigned_member_id', 'assigned_team_id', 'channel', 'photos', 'photo_rooms', 'accessibility'] }
const night = { type: 'object', properties: { date: day, available: { type: 'boolean' }, stay_id: nullableText, held_until: { ...nullableText, description: 'When a guest checkout hold on this night lapses; null when no guest is paying for it. A held night is not available.' }, closed: { type: 'boolean' }, price_minor: { type: ['integer', 'null'] }, min_stay_arrival: { type: ['integer', 'null'] }, min_stay_through: { type: ['integer', 'null'] }, max_stay: { type: ['integer', 'null'] }, closed_to_arrival: { type: 'boolean' }, closed_to_departure: { type: 'boolean' }, source: { type: ['string', 'null'], enum: ['host', 'import', null] },
  calendar: { type: ['string', 'null'], enum: ['vrbo', null], description: 'The linked calendar (Vrbo) that shows this night taken; null when none does. Such a night is not available.' },
  channel: { type: ['object', 'null'], properties: { state: { type: 'string', enum: ['pending', 'pushed', 'needs_review'] }, detail: nullableText }, required: ['state', 'detail'] } },
  required: ['date', 'available', 'stay_id', 'closed', 'price_minor', 'min_stay_arrival', 'min_stay_through', 'max_stay', 'closed_to_arrival', 'closed_to_departure', 'source', 'held_until', 'calendar', 'channel'] }
const calendarHomeProperties = { product_id: text, name: text, location_id: text, timezone: text, currency: text, base_price_minor: stayHomeObject.properties.base_price_minor, base_price_tax_behavior: stayHomeObject.properties.base_price_tax_behavior,
  check_in_time: text, check_in_end_time: stayHomeObject.properties.check_in_end_time, check_out_time: text, max_guests: { type: 'integer' }, min_nights: { type: 'integer' }, channel: stayHomeObject.properties.channel }
const calendarHome = { type: 'object', properties: calendarHomeProperties, required: Object.keys(calendarHomeProperties), additionalProperties: false }
const calendarStayProperties = Object.fromEntries(['id', 'product_id', 'channel', 'owner', 'status', 'overbooked', 'check_in_date', 'check_out_date', 'arrival_time', 'adults', 'children', 'infants', 'guest_name', 'guest_surname'].map(field => [field, stayProperties[field as keyof typeof stayProperties]]))
const calendarStay = { type: 'object', properties: calendarStayProperties, required: Object.keys(calendarStayProperties), additionalProperties: false }
const calendar = { type: 'object', properties: { home: calendarHome, nights: { type: 'array', items: night }, stays: { type: 'array', items: calendarStay }, channel_push: channelPush }, required: ['home', 'nights', 'stays'] }
const stayListProperties = { ...calendarStayProperties, location_id: text, timezone: text, request_id: stayProperties.request_id, version: stayProperties.version }
const stayListItem = { type: 'object', properties: stayListProperties, required: Object.keys(stayListProperties), additionalProperties: false }
const stayReceiptProperties = { id: text, product_id: text, request_id: nullableText, status: stayProperties.status, version: stayProperties.version, updated_at: text, check_in_date: day, check_out_date: day }
const stayReceipt = { type: 'object', properties: stayReceiptProperties, required: Object.keys(stayReceiptProperties), additionalProperties: false }
const stayMutation = { type: 'object', properties: { stay: stayReceipt, channel_push: channelPush }, required: ['stay', 'channel_push'], additionalProperties: false }
const paymentBalanceProperties = { stay_id: text, currency: text, paid_minor: { type: 'integer' }, payment_status: stayDetail.properties.payment_status }
const paymentReceiptProperties = { id: text, stay_id: text, amount_minor: { type: 'integer' }, currency: text, method: payment.properties.method, paid_on: day, reference: nullableText, note: nullableText, created_at: text }
const nightSettingFields = ['closed', 'price_minor', 'min_stay_arrival', 'min_stay_through', 'max_stay', 'closed_to_arrival', 'closed_to_departure']
const roomResult = { type: 'object', properties: { product_id: text, room: roomIdentity }, required: ['product_id', 'room'], additionalProperties: false }
const roomDetailsResult = { type: 'object', properties: { product_id: text, product_updated_at: text, room: STAY_PHOTO_ROOM_SCHEMA }, required: ['product_id', 'product_updated_at', 'room'], additionalProperties: false }
const roomDeletionResult = { type: 'object', properties: { product_id: text, deleted_room_id: text, photo_memberships: { type: 'array', description: 'Every photo retained on this home in Product photo order, with its current room assignment. Null means Additional photos.', items: { type: 'object', properties: { photo_id: text, room_id: nullableText }, required: ['photo_id', 'room_id'], additionalProperties: false } } }, required: ['product_id', 'deleted_room_id', 'photo_memberships'], additionalProperties: false }
const photoAssignmentResult = { type: 'object', properties: { product_id: text, destination_room_id: { ...nullableText, description: 'The saved destination room; null means Additional photos.' }, created_room_id: { ...nullableText, description: 'The newly created room’s ID when new_room_type was supplied; otherwise null.' }, moved_photo_ids: { type: 'array', items: text, minItems: 1, uniqueItems: true, description: 'The selected photo IDs whose assignment was saved.' } }, required: ['product_id', 'destination_room_id', 'created_room_id', 'moved_photo_ids'], additionalProperties: false }
const guestFields = {
  check_in_date: day, check_out_date: { ...day, description: 'The morning the guest leaves; the stay holds the nights before it.' }, arrival_time: time,
  adults: { type: 'integer', minimum: 1, maximum: 99 }, children: { type: 'integer', minimum: 0, maximum: 99 }, infants: { type: 'integer', minimum: 0, maximum: 99 },
  guest_name: { type: 'string', minLength: 1, maxLength: 200 }, guest_surname: { type: ['string', 'null'], maxLength: 200 }, guest_email: { type: ['string', 'null'] },
  guest_phone: { type: ['string', 'null'], description: PHONE_FORMAT }, total_minor: minor, notes: { type: ['string', 'null'], maxLength: 2000 },
}

function calendarResult<T extends { home: StayHome; stays: unknown[] }>(result: T) {
  const home = result.home
  return { ...result, home: {
    product_id: home.product_id, name: home.name, location_id: home.location_id, timezone: home.timezone, currency: home.currency,
    base_price_minor: home.base_price_minor, base_price_tax_behavior: home.base_price_tax_behavior,
    check_in_time: home.check_in_time, check_in_end_time: home.check_in_end_time, check_out_time: home.check_out_time, max_guests: home.max_guests, min_nights: home.min_nights, channel: home.channel,
  }, stays: result.stays.map(entry => Object.fromEntries(Object.keys(calendarStayProperties).map(field => [field, (entry as Record<string, unknown>)[field]]))) }
}

function roomIdentityResult(room: StayHome['photo_rooms'][number]) {
  return { id: room.id, type: room.type, photo_ids: room.photo_ids, details_version: room.details_version }
}

function stayMutationReceipt(stay: StayDetail & { channel_push: unknown }) {
  return { stay: { id: stay.id, product_id: stay.product_id, request_id: stay.request_id, status: stay.status, version: stay.version, updated_at: stay.updated_at, check_in_date: stay.check_in_date, check_out_date: stay.check_out_date }, channel_push: stay.channel_push }
}

export const STAYS_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_stays', domain: 'stays', minimumRole: 'member', description: 'Read guests staying at the organization’s homes overlapping a date range, with dates, party, channel and status. Members see only assigned homes. Use get_stay for one stay’s contact, notes and payment details.',
    inputSchema: { from: day, to: { ...day, description: 'Exclusive; at most 400 days after from.' }, product_id: productId, include_cancelled: { type: 'boolean' } }, required: ['from', 'to'],
    outputSchema: { type: 'object', properties: { stays: { type: 'array', items: stayListItem } }, required: ['stays'] } }),
  organizationTool({ name: 'get_stay', domain: 'stays', minimumRole: 'member', description: 'Read one stay with its guest details and, for a stay the host took, the payments recorded against it.',
    inputSchema: { stay_id: stayId }, required: ['stay_id'], outputSchema: { type: 'object', properties: { stay: stayDetail }, required: ['stay'] } }),
  organizationTool({ name: 'get_stay_calendar', domain: 'stays', minimumRole: 'member', description: 'Read every night of a date range at one home: availability, nightly price, booking restrictions and the stays holding those nights. Returns scheduling details; use get_stay for one booking’s contact and payment details, or get_product for the home’s photos and room groups.',
    inputSchema: { product_id: productId, from: day, to: { ...day, description: 'Exclusive; at most 500 days after from.' } }, required: ['product_id', 'from', 'to'], outputSchema: calendar }),
  organizationTool({ name: 'create_home_room', domain: 'stays', minimumRole: 'admin', description: 'Create an empty room or space, such as Bedroom or Patio, for grouping an existing home’s photos. This creates a room group, not a photo or business location, and requires no amenity answers. Use assign_home_photos_to_room to group existing home photos afterward; save_media_attachment saves new attachments and attach_media adds library images to the home’s gallery. Returns the new room ID. Each call creates a new room; if the outcome is uncertain, read get_product before retrying. Changes only KrabiClaw; it does not update Airbnb. Edit Airbnb’s photo tour separately in Airbnb.',
    inputSchema: { product_id: productId, type: { ...roomType, description: 'Type of the empty room or space to create.' } }, required: ['product_id', 'type'], outputSchema: roomResult }),
  organizationTool({ name: 'update_home_accessibility', domain: 'stays', minimumRole: 'admin', description: 'Change one home accessibility answer. First call get_product for product.updated_at and product.stay.accessibility. True requires evidence images in this organization; saving appends selected library images to this home’s Product photos without changing the cover, existing order or room assignments. False/null requires []; null clears the answer. Evidence photos remain protected until the answer is cleared or the evidence replaced. A stale Product revision or photo order refuses the entire change. Changes only KrabiClaw; it does not update Airbnb. Edit Airbnb accessibility separately in Airbnb.',
    inputSchema: { product_id: productId, expected_updated_at: { ...text, description: 'product.updated_at from the latest get_product call. A stale value refuses the entire change.' }, accessibility: homeAccessibilityAnswer }, required: ['product_id', 'expected_updated_at', 'accessibility'],
    outputSchema: { type: 'object', properties: { product_id: text, product_updated_at: text, accessibility: STAY_HOME_ACCESSIBILITY_SCHEMA }, required: ['product_id', 'product_updated_at', 'accessibility'], additionalProperties: false } }),
  organizationTool({ name: 'update_home_room', domain: 'stays', minimumRole: 'admin', description: 'Change a room’s beds, bedroom bathroom privacy, amenity assignments or one bedroom accessibility answer. First call get_product for product.stay.photo_rooms and the selected room’s details_version. Omitted fields remain unchanged. Bed allocations must fit the home’s declared total; assigning an amenity also adds it to the home’s amenity set, while unassigning only removes its room membership. Accessibility evidence may append library images to the home’s gallery. A stale room revision or invalid combination refuses the entire change. Returns the saved room details. Changes only KrabiClaw; it does not update Airbnb. Edit Airbnb room details separately in Airbnb.',
    inputSchema: { product_id: productId, room_id: { ...text, description: 'Room ID from get_product → product.stay.photo_rooms.' }, expected_details_version: expectedRoomDetailsVersion, sleeping_arrangements: sleepingArrangements, private_attached_bathroom: privateBathroom, amenities: roomAmenitiesWrite, accessibility: accessibilityAnswer,
      anyOf: [{ required: ['sleeping_arrangements'] }, { required: ['private_attached_bathroom'] }, { required: ['amenities'] }, { required: ['accessibility'] }] }, required: ['product_id', 'room_id', 'expected_details_version'],
    outputSchema: roomDetailsResult }),
  organizationTool({ name: 'delete_home_room', domain: 'stays', minimumRole: 'admin', description: 'Delete a room or space group from a home. First call get_product for product.stay.photo_rooms and choose its exact room ID. Its photos become Additional photos; the home’s cover, gallery and library files remain. Returns the removed ID and current photo memberships. Changes only KrabiClaw; it does not update Airbnb. Delete an Airbnb room separately in Airbnb.',
    inputSchema: { product_id: productId, room_id: { ...text, description: 'Room ID from get_product → product.stay.photo_rooms.' } }, required: ['product_id', 'room_id'], outputSchema: roomDeletionResult }),
  organizationTool({ name: 'assign_home_photos_to_room', domain: 'stays', minimumRole: 'admin', description: 'Assign existing home photos to one room group, to Additional photos, or to a newly created room. First call get_product: photo IDs are product.image.asset_id and product.gallery[].asset_id; current room membership is product.stay.photo_rooms. Supply exactly one destination: room_id with an existing ID, explicit room_id:null for Additional photos, or new_room_type. Omitting room_id does not mean null. Each selected photo needs its current expected_room_id; changed membership or a removed photo refuses the whole assignment, including new room creation. Returns the destination ID, new room ID if created and moved photo IDs. Changes only KrabiClaw; it does not update Airbnb. Edit Airbnb’s photo tour separately in Airbnb.',
    inputSchema: { product_id: productId, room_id: { ...nullableText, minLength: 1, description: 'Existing room ID from get_product → product.stay.photo_rooms, or explicit null for Additional photos. Omit only when supplying new_room_type.' }, new_room_type: { ...roomType, description: 'Create this room type and assign the photos to it. Omit room_id when using this destination.' }, photos: movePhotos,
      oneOf: [{ required: ['room_id'], not: { required: ['new_room_type'] } }, { required: ['new_room_type'], not: { required: ['room_id'] } }] }, required: ['product_id', 'photos'], outputSchema: photoAssignmentResult }),
  organizationTool({ name: 'create_stay', domain: 'stays', minimumRole: 'admin', description: 'Add a stay the host took directly and hold its nights. Read get_product for the home’s ID, capacity and currency. Children and infants default to zero; omitted arrival time, surname, contacts and notes remain unset. Another stay or checkout hold refuses overlapping nights. Takes no payment. Applies automatic guest-message schedules and updates connected Airbnb availability through Channex. Returns the saved stay’s identity, dates, version and channel completion; use get_stay for full details. Retry identical arguments with the same key. The retry checks current saved details, so later edits can cause IDEMPOTENCY_CONFLICT; read get_stay before another change.',
    inputSchema: { product_id: productId, ...guestFields, idempotency_key: key }, required: ['product_id', 'check_in_date', 'check_out_date', 'adults', 'guest_name', 'total_minor', 'idempotency_key'],
    outputSchema: stayMutation }),
  organizationTool({ name: 'update_stay', domain: 'stays', minimumRole: 'admin', description: 'Change a host-entered stay’s dates, party, guest details, total or notes using stay.version from get_stay. Supply at least one changed field; empty and unchanged edits are refused. Omitted fields keep their values. Returns a compact stay receipt and the saved values of supplied fields. Replans pending automatic guest messages and updates connected Airbnb availability through Channex. A failed channel update reports the committed edit; read get_stay before retrying. Channel-owned stays must be edited on their channel.',
    inputSchema: { stay_id: stayId, expected_version: version, ...guestFields, anyOf: Object.keys(guestFields).map(field => ({ required: [field] })) }, required: ['stay_id', 'expected_version'],
    outputSchema: { ...stayMutation, properties: { ...stayMutation.properties, saved_fields: { type: 'object', properties: Object.fromEntries(Object.keys(guestFields).map(field => [field, stayProperties[field as keyof typeof stayProperties]])), minProperties: 1, additionalProperties: false } }, required: [...stayMutation.required, 'saved_fields'] } }),
  organizationTool({ name: 'cancel_stay', domain: 'stays', minimumRole: 'admin', description: 'Cancel a host-entered stay under its current version, free its nights, cancel pending automatic guest messages and update availability on the home’s connected Airbnb listing through Channex. A failed channel update reports that cancellation was saved. If a website payment needs a refund, returns financial_action_required with an authenticated dashboard link before cancellation or financial writes. Offline refunds can be recorded separately with record_stay_payment; that record moves no money.',
    inputSchema: { stay_id: stayId, expected_version: version, reason: { type: 'string', maxLength: 500 } }, required: ['stay_id', 'expected_version'],
    outputSchema: { ...stayMutation, properties: { ...stayMutation.properties, stay: { ...stayReceipt, properties: { ...stayReceiptProperties, cancelled_at: nullableText, cancellation_reason: nullableText }, required: [...stayReceipt.required, 'cancelled_at', 'cancellation_reason'] } } } }),
  organizationTool({ name: 'record_stay_payment', domain: 'stays', minimumRole: 'admin', description: 'Record money received outside KrabiClaw for a host-entered stay, such as cash or a bank transfer. Read get_stay for the stay ID and currency. A negative amount records an offline refund. Returns the exact recorded payment and current paid amount/status, without unrelated guest details or payment history. Moves no money.',
    inputSchema: { stay_id: stayId, amount_minor: { type: 'integer', not: { const: 0 }, description: 'Whole minor units of the stay’s currency from get_stay; negative records an offline refund, never zero.' }, method: { type: 'string', enum: [...STAY_PAYMENT_METHODS] }, paid_on: day, reference: { type: 'string', maxLength: 200 }, note: { type: 'string', maxLength: 1000 }, idempotency_key: { ...key, description: 'Reuse only for the identical amount, method, date, reference and note on this stay. Returns the exact recorded payment without a second entry.' } },
    required: ['stay_id', 'amount_minor', 'method', 'paid_on', 'idempotency_key'], outputSchema: { type: 'object', properties: { ...paymentBalanceProperties, payment: { type: 'object', properties: paymentReceiptProperties, required: Object.keys(paymentReceiptProperties), additionalProperties: false } }, required: [...Object.keys(paymentBalanceProperties), 'payment'], additionalProperties: false } }),
  organizationTool({ name: 'delete_stay_payment', domain: 'stays', minimumRole: 'admin', description: 'Remove one offline payment record entered by mistake. First call get_stay for its payment ID. Returns the removed payment ID and current paid amount/status. Does not refund or move money, and cannot remove the guest’s Stripe payment.',
    inputSchema: { stay_id: stayId, payment_id: { ...text, description: 'ID from get_stay → stay.payments[].id, or record_stay_payment → payment.id. Removes an offline record, not a Stripe payment or actual money.' } }, required: ['stay_id', 'payment_id'], outputSchema: { type: 'object', properties: { ...paymentBalanceProperties, deleted_payment_id: text }, required: [...Object.keys(paymentBalanceProperties), 'deleted_payment_id'], additionalProperties: false } }),
  organizationTool({ name: 'set_stay_nights', domain: 'stays', minimumRole: 'admin', description: 'Close or open nights, set a nightly price, or set stay rules for a date range at one place to stay. Fields left out keep each night’s value; price_minor null returns to the base price; reset removes the range’s overrides. Updates the website’s bookable nights and, when connected, pushes prices, availability and stay rules to the home’s Airbnb listing through Channex. Returns channel_push on success. A failed channel update raises CHANNEL_PUSH_FAILED with committed:true; read the calendar before retrying.',
    inputSchema: { product_id: productId, from: day, to: { ...day, description: 'Exclusive; at most 500 days after from.' }, closed: { type: 'boolean' }, price_minor: { type: ['integer', 'null'], minimum: 0 },
      min_stay_arrival: { type: ['integer', 'null'], minimum: 1 }, min_stay_through: { type: ['integer', 'null'], minimum: 1 }, max_stay: { type: ['integer', 'null'], minimum: 1 },
      closed_to_arrival: { type: 'boolean' }, closed_to_departure: { type: 'boolean' }, reset: { type: 'boolean', description: 'True removes all nightly overrides in the range and cannot be combined with night settings. False or omitted requires at least one night setting.' },
      // At least one change; reset with night settings is refused by the stay domain.
      anyOf: ['reset', ...nightSettingFields].map(field => ({ required: [field] })) },
    required: ['product_id', 'from', 'to'], outputSchema: calendar }),
]

export async function handleStaysTools(ctx: McpExecutorContext): Promise<unknown> {
  const { organization, args, toolName } = ctx
  const { db, env } = organization
  const access = await stayAccessFor(memberAccessPrincipal(organization.membership, { env }))
  switch (toolName) {
    case 'list_stays': return { stays: (await listStays(db, access, { from: args.from, to: args.to, productId: args.product_id as string | undefined, includeCancelled: args.include_cancelled === true })).map(stay => Object.fromEntries(Object.keys(stayListProperties).map(field => [field, stay[field as keyof typeof stay]]))) }
    case 'get_stay': return { stay: await getStay(db, access, requiredString(args, 'stay_id')) }
    case 'get_stay_calendar': return calendarResult(await readStayCalendar(db, access, { productId: requiredString(args, 'product_id'), from: args.from, to: args.to }))
    case 'create_home_room': {
      const { home, room } = await createStayPhotoRoom(db, env, access, requiredString(args, 'product_id'), { type: args.type })
      return { product_id: home.product_id, room: roomIdentityResult(room) }
    }
    case 'update_home_accessibility': {
      const { home } = await updateStayHomeAccessibility(db, env, access, requiredString(args, 'product_id'), { expected_updated_at: args.expected_updated_at, accessibility: args.accessibility })
      return { product_id: home.product_id, product_updated_at: home.product_updated_at, accessibility: home.accessibility }
    }
    case 'update_home_room': {
      const { home, room } = await updateStayPhotoRoom(db, env, access, requiredString(args, 'product_id'), requiredString(args, 'room_id'), {
        expected_details_version: args.expected_details_version,
        ...(Object.hasOwn(args, 'sleeping_arrangements') ? { sleeping_arrangements: args.sleeping_arrangements } : {}),
        ...(Object.hasOwn(args, 'private_attached_bathroom') ? { private_attached_bathroom: args.private_attached_bathroom } : {}),
        ...(Object.hasOwn(args, 'amenities') ? { amenities: args.amenities } : {}),
        ...(Object.hasOwn(args, 'accessibility') ? { accessibility: args.accessibility } : {}),
      })
      return { product_id: home.product_id, product_updated_at: home.product_updated_at, room }
    }
    case 'delete_home_room': {
      const roomId = requiredString(args, 'room_id')
      const home = await removeStayPhotoRoom(db, env, access, requiredString(args, 'product_id'), roomId)
      return { product_id: home.product_id, deleted_room_id: roomId, photo_memberships: home.photos.map(photo => ({ photo_id: photo.id, room_id: home.photo_rooms.find(room => room.photo_ids.includes(photo.id))?.id ?? null })) }
    }
    case 'assign_home_photos_to_room': {
      const { home, ...assignment } = await moveStayPhotos(db, env, access, requiredString(args, 'product_id'), { ...(Object.hasOwn(args, 'room_id') ? { room_id: args.room_id } : {}), ...(Object.hasOwn(args, 'new_room_type') ? { new_room_type: args.new_room_type } : {}), photos: args.photos })
      return { product_id: home.product_id, ...assignment }
    }
    case 'create_stay': return stayMutationReceipt(await createStay(db, env, access, { ...args, product_id: requiredString(args, 'product_id'), idempotency_key: requiredString(args, 'idempotency_key') }))
    case 'update_stay': {
      const { stay_id: _id, ...patch } = args
      const stay = await updateStay(db, env, access, requiredString(args, 'stay_id'), patch as Record<string, unknown> & { expected_version: unknown })
      return { ...stayMutationReceipt(stay), saved_fields: Object.fromEntries(Object.keys(guestFields).filter(field => Object.hasOwn(patch, field)).map(field => [field, stay[field as keyof typeof stay]])) }
    }
    case 'cancel_stay': {
      const stay = await cancelStay(db, env, access, requiredString(args, 'stay_id'), { expected_version: args.expected_version, reason: args.reason, financial_writes_allowed: false })
      const result = stayMutationReceipt(stay)
      return { ...result, stay: { ...result.stay, cancelled_at: stay.cancelled_at, cancellation_reason: stay.cancellation_reason } }
    }
    case 'record_stay_payment': {
      const { stay, payment: { created_by: _createdBy, ...payment } } = await recordStayPayment(db, env, access, requiredString(args, 'stay_id'), args)
      return { stay_id: stay.id, payment, currency: stay.currency, paid_minor: stay.paid_minor, payment_status: stay.payment_status }
    }
    case 'delete_stay_payment': {
      const paymentId = requiredString(args, 'payment_id')
      const stay = await deleteStayPayment(db, env, access, requiredString(args, 'stay_id'), paymentId)
      return { stay_id: stay.id, deleted_payment_id: paymentId, currency: stay.currency, paid_minor: stay.paid_minor, payment_status: stay.payment_status }
    }
    case 'set_stay_nights': return calendarResult(await setStayNights(db, env, access, { ...args, product_id: requiredString(args, 'product_id'), from: args.from, to: args.to }))
    default: return NOT_HANDLED
  }
}
