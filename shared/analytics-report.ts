import { z } from 'zod'
import { SUPPORTED_CURRENCIES } from './currencies'

const count = z.number().int().nonnegative()
const amount = z.number()
const text = z.string()
const nullableText = text.nullable()
const currency = z.enum(SUPPORTED_CURRENCIES)
const attribution = { source: text, medium: text, campaign: nullableText, content: nullableText }
const observedAttribution = { ...attribution, source: nullableText, medium: nullableText }
const money = { currency, collectedMinor: amount, refundedMinor: amount, netMinor: amount }

/** The native D1 report contract, shared by its producer, dashboard and MCP. */
export const analyticsReportSchema = z.object({
  period: z.object({ startDate: text, endDate: text, timezone: text, analyticsDataStartAt: nullableText }),
  metrics: z.object({
    pageViews: count, uniqueSessions: count, uniqueVisitors: count, returningVisitors: count,
    avgSessionDuration: z.number().nonnegative(), pagesPerSession: z.number().nonnegative(), changePercent: z.number().nullable(),
  }),
  dailyData: z.array(z.object({ date: text, pageViews: count, sessions: count, avgDuration: z.number().nonnegative() })),
  dailyConversions: z.array(z.object({ date: text, events: count })),
  topPages: z.array(z.object({ path: text, views: count, percentOfTotal: z.number() })),
  // Sessions and converting sessions share the same population. Outcomes below instead
  // use their immutable attribution snapshot; their counts have no session denominator.
  attribution: z.array(z.object({ ...attribution, sessions: count, outcomeEvents: count, convertingSessions: count, sessionConversionRate: z.number().nullable() })),
  outcomeAttribution: z.array(z.object({ ...attribution, eventName: text, events: count, distinctEntities: count })),
  attributedValue: z.array(z.object({ ...observedAttribution, ...money, purchases: count })),
  conversions: z.array(z.object({
    eventName: text, stage: text, conversionType: nullableText, events: count, distinctEntities: count,
    convertingSessions: count, nonbrowserEvents: count, sessionConversionRate: z.number().nullable(),
  })),
  // Values are minor units per currency. Quoted booking value is not revenue;
  // cash collected/refunded includes tax, while valueMinor excludes tax.
  values: z.array(z.object({ eventName: text, basis: z.enum(['quoted', 'purchase', 'refund']), currency, events: count, valueMinor: amount, collectedMinor: amount.nullable() })),
  bookingValue: z.array(z.object({ productId: nullableText, productName: nullableText, locationId: nullableText, currency: currency.nullable(), bookings: count, valuedBookings: count, quotedValueMinor: amount })),
  net: z.array(z.object(money)),
  signupCohort: z.object({
    observedThrough: text, signups: count, onboardedSignups: count, firstPaidSignups: count,
    bySignupAttribution: z.array(z.object({ ...observedAttribution, signups: count, onboardedSignups: count, firstPaidSignups: count, revenue: z.array(z.object(money)) })),
    onboardedBusinesses: count, firstPaidBusinesses: count,
  }),
  coverage: z.object({
    measurementContractStartedAt: nullableText, outcomeEventsWithoutAttribution: count,
    ga4Delivery: z.array(z.object({ eventName: text, status: text, count })),
  }),
  countries: z.array(z.object({ country: text, countryCode: text, views: count, percentOfTotal: z.number() })),
  cities: z.array(z.object({ city: text, region: nullableText, countryCode: text, views: count })),
  referrers: z.array(z.object({ source: text, views: count, percentOfTotal: z.number() })),
  devices: z.array(z.object({ type: text, views: count, percentOfTotal: z.number() })),
  adSpend: z.object({
    totalSpendMicros: count,
    clicks: count,
    impressions: count,
    conversions: count,
    costPerClickMicros: count,
    error: nullableText.optional(),
  }).optional(),
})

export const organizationAnalyticsSchema = z.object({
  organizationId: text,
  report: analyticsReportSchema,
  reviews: z.object({
    total: count, average: z.number().nullable(),
    distribution: z.array(z.object({ rating: z.number(), count })),
    recent: z.array(z.object({ id: text, author: text, rating: z.number(), title: nullableText, content: nullableText, createdAt: text })),
  }),
})

export type AnalyticsReport = z.infer<typeof analyticsReportSchema>
export type OrganizationAnalyticsReport = z.infer<typeof organizationAnalyticsSchema>
