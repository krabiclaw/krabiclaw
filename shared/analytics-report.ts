import { z } from 'zod'
import { isCurrencyCode } from './currencies'
import { ATTRIBUTION_CHANNELS } from '../utils/analytics-attribution'

const count = z.number().int().nonnegative()
const amount = z.number()
const text = z.string()
const nullableText = text.nullable()
const currency = z.string().refine(isCurrencyCode, 'ISO 4217 currency code')
const attribution = { source: text, medium: text, campaign: nullableText, content: nullableText }
const observedAttribution = { ...attribution, source: nullableText, medium: nullableText }
const money = { currency, collected_minor: amount, refunded_minor: amount, net_minor: amount }
// Visits are sessions; viewed and intent are events; submitted and confirmed are requests; paid is
// payments, with the cash collected per currency (never added across currencies).
const funnelCounts = {
  visits: count, viewed: count, intent: count, submitted: count, confirmed: count, paid: count,
  paid_collected: z.array(z.object({ currency, collected_minor: amount })),
}

/** The native D1 report contract, shared by its producer, dashboard and MCP. */
export const analyticsReportSchema = z.object({
  // partial: the range began before the business's own analytics did, and counts from analytics_data_start_at.
  period: z.object({ start_date: text, end_date: text, timezone: text, analytics_data_start_at: nullableText, native_coverage: z.enum(['full', 'partial']) }),
  metrics: z.object({
    page_views: count, unique_sessions: count, unique_visitors: count, returning_visitors: count,
    avg_session_duration: z.number().nonnegative(), pages_per_session: z.number().nonnegative(), change_percent: z.number().nullable(),
  }),
  daily_data: z.array(z.object({ date: text, page_views: count, sessions: count, avg_duration: z.number().nonnegative() })),
  daily_conversions: z.array(z.object({ date: text, events: count })),
  top_pages: z.array(z.object({ path: text, views: count, percent_of_total: z.number() })),
  // Sessions and converting sessions share the same population. Outcomes below instead
  // use their immutable attribution snapshot; their counts have no session denominator.
  attribution: z.array(z.object({ ...attribution, sessions: count, outcome_events: count, converting_sessions: count, session_conversion_rate: z.number().nullable() })),
  outcome_attribution: z.array(z.object({ ...attribution, event_name: text, events: count, distinct_entities: count })),
  attributed_value: z.array(z.object({ ...observedAttribution, ...money, purchases: count })),
  conversions: z.array(z.object({
    event_name: text, stage: text, conversion_type: nullableText, events: count, distinct_entities: count,
    converting_sessions: count, nonbrowser_events: count, session_conversion_rate: z.number().nullable(),
  })),
  // Values are minor units per currency. Quoted booking value is not revenue;
  // cash collected/refunded includes tax, while value_minor excludes tax.
  values: z.array(z.object({ event_name: text, basis: z.enum(['quoted', 'purchase', 'refund']), currency, events: count, value_minor: amount, collected_minor: amount.nullable() })),
  booking_value: z.array(z.object({ product_id: nullableText, product_name: nullableText, location_id: nullableText, currency: currency.nullable(), bookings: count, valued_bookings: count, quoted_value_minor: amount })),
  net: z.array(z.object(money)),
  funnel: z.object({
    ...funnelCounts,
    by_source: z.array(z.object({ channel: z.enum(ATTRIBUTION_CHANNELS), ...funnelCounts })),
    by_location: z.array(z.object({ location_id: nullableText, ...funnelCounts })),
  }),
  signup_cohort: z.object({
    observed_through: text, signups: count, onboarded_signups: count, first_paid_signups: count,
    by_signup_attribution: z.array(z.object({ ...observedAttribution, signups: count, onboarded_signups: count, first_paid_signups: count, revenue: z.array(z.object(money)) })),
    onboarded_businesses: count, first_paid_businesses: count,
  }),
  coverage: z.object({
    measurement_contract_started_at: nullableText, outcome_events_without_attribution: count,
    ga4_delivery: z.array(z.object({ event_name: text, status: text, count })),
  }),
  countries: z.array(z.object({ country: text, country_code: text, views: count, percent_of_total: z.number() })),
  cities: z.array(z.object({ city: text, region: nullableText, country_code: text, views: count })),
  referrers: z.array(z.object({ source: text, views: count, percent_of_total: z.number() })),
  devices: z.array(z.object({ type: text, views: count, percent_of_total: z.number() })),
  ad_spend: z.object({
    total_spend_micros: count,
    clicks: count,
    impressions: count,
    conversions: count,
    cost_per_click_micros: count,
    error: nullableText.optional(),
  }).optional(),
})

export const organizationAnalyticsSchema = z.object({
  organization_id: text,
  report: analyticsReportSchema,
  reviews: z.object({
    total: count, average: z.number().nullable(),
    distribution: z.array(z.object({ rating: z.number(), count })),
    recent: z.array(z.object({ id: text, author_name: text, rating: z.number(), title: nullableText, content: nullableText, source: text, created_at: text })),
  }),
})

export type AnalyticsReport = z.infer<typeof analyticsReportSchema>
export type OrganizationAnalyticsReport = z.infer<typeof organizationAnalyticsSchema>
