// The one event catalog. Every conversion the platform records — native row,
// GA4 projection, report grouping — takes its meaning from this table. The DB
// CHECK constraint only validates shape, so a new event is added here and in
// the unique-index predicate in server/db/schema.ts when it has an entity.
//
// Themes render UI and call shared behavior; they never define conversion
// semantics.

export const CONVERSION_STAGES = ['schedule_navigation', 'external_booking_handoff', 'submitted', 'external_handoff', 'completed', 'viewed', 'started', 'occurred'] as const
export type ConversionStage = typeof CONVERSION_STAGES[number]

export const CONVERSION_ENTITY_TYPES = ['request', 'product', 'content_block', 'content_document', 'user', 'organization', 'invoice', 'refund', 'payment', 'booking'] as const
export type ConversionEntityType = typeof CONVERSION_ENTITY_TYPES[number]

// quoted: the price the guest was shown when the booking was created — not revenue.
// purchase / refund: verified provider payment evidence.
export const CONVERSION_VALUE_BASES = ['quoted', 'purchase', 'refund'] as const
export type ConversionValueBasis = typeof CONVERSION_VALUE_BASES[number]

// Distinguishes the business domain of a submission or payment. A documented
// custom dimension, not a Google-defined revenue switch.
export const CONVERSION_TYPES = ['contact', 'reservation', 'booking', 'subscription'] as const
export type ConversionType = typeof CONVERSION_TYPES[number]

export interface ConversionEventDefinition {
  /**
   * conversion: a business outcome. interaction: something a visitor or user did that is not an
   * outcome, and never counted as a successful conversion (a handoff click, a product view, a
   * checkout start, a product-usage event).
   */
  kind: 'conversion' | 'interaction'
  /** Who may produce the event. 'browser' events are the only ones the public and authenticated interaction endpoints accept. */
  producer: 'browser' | 'server'
  /** 'public': an anonymous visitor on a tenant site. 'authenticated': a signed-in user of the platform. */
  origin: 'public' | 'authenticated'
  stages: readonly ConversionStage[]
  /** The business subject the event counts; null when the event has no entity. */
  entityType: ConversionEntityType | null
  /** The value semantics the event may carry; null means it never carries a value. */
  valueBasis: ConversionValueBasis | null
  conversionType: ConversionType | null
  /** The GA4 event this fact projects to, or null when it is a handoff with no GA4 meaning. */
  ga4: { name: string } | null
  /** Which sender owns the GA4 event: the visitor's browser or Measurement Protocol. Exactly one. */
  ga4Sender: 'browser' | 'measurement_protocol'
  /** Session conversion rate numerators: interactions and refunds are not outcomes. */
  outcome: boolean
  /**
   * The flat scalar properties an interaction may carry, and nothing else. Free text, prompts,
   * error messages, file names and other private content are never collected.
   */
  properties?: readonly string[]
}

// Keeps each definition's literal types, so a name's origin and producer are known to the compiler.
function interaction<const Definition extends Pick<ConversionEventDefinition, 'origin' | 'stages' | 'entityType' | 'ga4' | 'ga4Sender' | 'properties'>>(definition: Definition) {
  return { kind: 'interaction', producer: 'browser', outcome: false, valueBasis: null, conversionType: null, ...definition } as const
}

export const CONVERSION_EVENT_CATALOG = {
  consultation_cta_click: interaction({ origin: 'public', stages: ['schedule_navigation', 'external_booking_handoff'], entityType: null, ga4: { name: 'consultation_cta_click' }, ga4Sender: 'browser' }),
  product_order_external_click: interaction({ origin: 'public', stages: ['external_handoff'], entityType: 'product', ga4: { name: 'product_order_external_click' }, ga4Sender: 'browser' }),
  link_click: interaction({ origin: 'public', stages: ['external_handoff'], entityType: 'content_block', ga4: { name: 'link_click' }, ga4Sender: 'browser' }),
  donation_click: interaction({ origin: 'public', stages: ['external_handoff'], entityType: 'content_document', ga4: { name: 'donation_click' }, ga4Sender: 'browser' }),
  // A product was viewed / a booking was started. Interactions: neither is a sale nor a booking.
  product_view: interaction({ origin: 'public', stages: ['viewed'], entityType: 'product', ga4: { name: 'view_item' }, ga4Sender: 'browser' }),
  checkout_start: interaction({ origin: 'public', stages: ['started'], entityType: null, ga4: { name: 'begin_checkout' }, ga4Sender: 'browser' }),
  // The universal announcement modal (organization-level, not tied to a page or product).
  announcement_view: interaction({ origin: 'public', stages: ['viewed'], entityType: null, ga4: { name: 'announcement_view' }, ga4Sender: 'browser' }),
  announcement_cta_click: interaction({ origin: 'public', stages: ['external_handoff'], entityType: null, ga4: { name: 'announcement_cta_click' }, ga4Sender: 'browser' }),
  contact_submit: { kind: 'conversion', producer: 'server', origin: 'public', stages: ['submitted'], entityType: 'request', valueBasis: null, conversionType: 'contact', ga4: { name: 'generate_lead' }, ga4Sender: 'browser', outcome: true },
  reservation_submit: { kind: 'conversion', producer: 'server', origin: 'public', stages: ['submitted'], entityType: 'request', valueBasis: null, conversionType: 'reservation', ga4: { name: 'reservation_submit' }, ga4Sender: 'browser', outcome: true },
  booking_submit: { kind: 'conversion', producer: 'server', origin: 'public', stages: ['submitted'], entityType: 'request', valueBasis: 'quoted', conversionType: 'booking', ga4: { name: 'booking_submit' }, ga4Sender: 'browser', outcome: true },
  sign_up: { kind: 'conversion', producer: 'server', origin: 'authenticated', stages: ['completed'], entityType: 'user', valueBasis: null, conversionType: null, ga4: { name: 'sign_up' }, ga4Sender: 'measurement_protocol', outcome: true },
  onboarding_complete: { kind: 'conversion', producer: 'server', origin: 'authenticated', stages: ['completed'], entityType: 'organization', valueBasis: null, conversionType: null, ga4: { name: 'tutorial_complete' }, ga4Sender: 'measurement_protocol', outcome: true },
  purchase: { kind: 'conversion', producer: 'server', origin: 'authenticated', stages: ['completed'], entityType: 'invoice', valueBasis: 'purchase', conversionType: 'subscription', ga4: { name: 'purchase' }, ga4Sender: 'measurement_protocol', outcome: true },
  refund: { kind: 'conversion', producer: 'server', origin: 'authenticated', stages: ['completed'], entityType: 'refund', valueBasis: 'refund', conversionType: 'subscription', ga4: { name: 'refund' }, ga4Sender: 'measurement_protocol', outcome: false },
  // Product usage by signed-in KrabiClaw users, measured on the platform organization. The subject
  // is the organization being worked on; the actor is the user. Only the listed scalars are kept.
  organization_created: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'organization_created' }, ga4Sender: 'browser' }),
  domain_connected: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'domain_connected' }, ga4Sender: 'browser', properties: ['domain'] }),
  subscription_upgrade: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'subscription_upgrade' }, ga4Sender: 'browser', properties: ['plan'] }),
  subscription_downgrade: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'subscription_downgrade' }, ga4Sender: 'browser', properties: ['plan'] }),
  subscription_checkout_success: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'subscription_checkout_success' }, ga4Sender: 'browser', properties: ['plan'] }),
  post_created: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'post_created' }, ga4Sender: 'browser', properties: ['content_id', 'content_type'] }),
  post_published: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'post_published' }, ga4Sender: 'browser', properties: ['content_id', 'content_type'] }),
  image_uploaded: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'image_uploaded' }, ga4Sender: 'browser', properties: ['file_size', 'provider', 'media_type'] }),
  video_uploaded: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'video_uploaded' }, ga4Sender: 'browser', properties: ['file_size', 'provider', 'media_type'] }),
  media_library_viewed: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'media_library_viewed' }, ga4Sender: 'browser' }),
  dashboard_visited: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: 'organization', ga4: { name: 'dashboard_visited' }, ga4Sender: 'browser', properties: ['dashboard_section'] }),
  error_encountered: interaction({ origin: 'authenticated', stages: ['occurred'], entityType: null, ga4: { name: 'error_encountered' }, ga4Sender: 'browser', properties: ['error_type', 'error_context'] }),
  // Paid bookings and orders on a business's own site, recorded by the server where each thing
  // happens. `member_id` is the team member the booking is with; the money is the business's, in minor units.
  payment_checkout_started: { kind: 'interaction', producer: 'server', origin: 'public', stages: ['started'], entityType: 'payment', valueBasis: 'quoted', conversionType: 'booking', ga4: null, ga4Sender: 'measurement_protocol', outcome: false, properties: ['member_id', 'saved_cards_offered'] },
  payment_checkout_expired: { kind: 'interaction', producer: 'server', origin: 'public', stages: ['occurred'], entityType: 'payment', valueBasis: null, conversionType: 'booking', ga4: null, ga4Sender: 'measurement_protocol', outcome: false, properties: ['member_id'] },
  payment_paid: { kind: 'conversion', producer: 'server', origin: 'public', stages: ['completed'], entityType: 'payment', valueBasis: 'purchase', conversionType: 'booking', ga4: null, ga4Sender: 'measurement_protocol', outcome: true, properties: ['member_id', 'saved_card'] },
  payment_refunded: { kind: 'conversion', producer: 'server', origin: 'authenticated', stages: ['completed'], entityType: 'refund', valueBasis: 'refund', conversionType: 'booking', ga4: null, ga4Sender: 'measurement_protocol', outcome: false, properties: ['member_id', 'full', 'with_cancellation', 'approval_seconds'] },
  booking_confirmed: { kind: 'conversion', producer: 'server', origin: 'authenticated', stages: ['completed'], entityType: 'booking', valueBasis: null, conversionType: 'booking', ga4: null, ga4Sender: 'measurement_protocol', outcome: false, properties: ['member_id', 'decision_seconds'] },
  booking_declined: { kind: 'conversion', producer: 'server', origin: 'authenticated', stages: ['completed'], entityType: 'booking', valueBasis: null, conversionType: 'booking', ga4: null, ga4Sender: 'measurement_protocol', outcome: false, properties: ['member_id', 'decision_seconds'] },
  booking_cancelled: { kind: 'conversion', producer: 'server', origin: 'public', stages: ['completed'], entityType: 'booking', valueBasis: null, conversionType: 'booking', ga4: null, ga4Sender: 'measurement_protocol', outcome: false, properties: ['member_id', 'cancelled_by'] },
  booking_change_accepted: { kind: 'conversion', producer: 'server', origin: 'public', stages: ['completed'], entityType: 'request', valueBasis: null, conversionType: 'booking', ga4: null, ga4Sender: 'measurement_protocol', outcome: false, properties: ['member_id'] },
  booking_change_declined: { kind: 'conversion', producer: 'server', origin: 'public', stages: ['completed'], entityType: 'request', valueBasis: null, conversionType: 'booking', ga4: null, ga4Sender: 'measurement_protocol', outcome: false, properties: ['member_id'] },
  // The platform's side of Payments, measured on the platform organization: the volume each business
  // reports to its Stripe meter. `tenant_organization_id` is the business.
  payments_volume_billed: { kind: 'interaction', producer: 'server', origin: 'authenticated', stages: ['occurred'], entityType: 'payment', valueBasis: null, conversionType: null, ga4: null, ga4Sender: 'measurement_protocol', outcome: false, properties: ['tenant_organization_id', 'volume_minor', 'currency'] },
} as const satisfies Record<string, ConversionEventDefinition>

export type OrganizationConversionEventName = keyof typeof CONVERSION_EVENT_CATALOG

export const ORGANIZATION_CONVERSION_EVENT_NAMES = Object.keys(CONVERSION_EVENT_CATALOG) as OrganizationConversionEventName[]

/** Events whose row is unique per (organization, event, entity). Mirrors the unique index predicate. */
export const ENTITY_UNIQUE_CONVERSION_EVENT_NAMES = ORGANIZATION_CONVERSION_EVENT_NAMES.filter(
  name => CONVERSION_EVENT_CATALOG[name].producer === 'server',
)

/** Events a browser may report (public interactions and signed-in usage); the server owns every other one. */
export const BROWSER_INTERACTION_EVENT_NAMES = ORGANIZATION_CONVERSION_EVENT_NAMES.filter(
  name => CONVERSION_EVENT_CATALOG[name].producer === 'browser',
)

export interface ConversionItem {
  item_id: string
  item_name: string
  item_variant?: string
  item_category?: string
  item_category2?: string
  item_category3?: string
  quantity: number
  /**
   * The line's total in minor units (an integer): net of the line's discounts and of any tax
   * included in its price. The unit price is derived from it at projection, so a line of 1,000
   * across three seats keeps its exact total instead of a rounded unit amount.
   */
  amount_minor: number
}

/** The immutable event-time value snapshot. Amounts stay in minor units; providers convert once. */
export interface ConversionValue {
  basis: ConversionValueBasis
  /** The event's value: what a quote showed, what a purchase earned excluding tax and shipping, or what a refund returned. */
  amount_minor: number
  /** Purchases and refunds: the cash actually moved (collected or returned), tax included. Reported separately from the tax-exclusive `amount_minor`. */
  collected_minor?: number
  currency: string
  transaction_id?: string
  items?: ConversionItem[]
}
