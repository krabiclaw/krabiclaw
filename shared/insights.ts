import { z } from 'zod'
import { REVIEW_SUBJECTS } from './review-questions'

/**
 * Insights: Airbnb's Performance pages for every kind of business. Each page is
 * one URL, `/dashboard/:org/insights/<section>/<page>`, and one read: its two
 * or three headline numbers, each one's series over the range, and the list
 * underneath. The page list and its words follow what the business books.
 * Web, iOS and the MCP tool read the same pages.
 */

/** What a business books. A menu (dishes) is not booked: it appears only under Page views and Top pages. */
export const INSIGHTS_KINDS = ['stay', 'experience', 'service', 'table'] as const
export type InsightsKind = typeof INSIGHTS_KINDS[number]
export type InsightsKindFilter = InsightsKind | 'all'

export const INSIGHTS_KIND_LABELS: Record<InsightsKind, string> = {
  stay: 'Places to stay', experience: 'Experiences', service: 'Consultations', table: 'Tables',
}

/**
 * The website clicks Booking conversion counts beside views and bookings under All, by the
 * conversion events that record them, for the verticals whose sites have them (`null`: every site
 * lists a phone). An offering's external link is a click to order at a restaurant and to book
 * anywhere else; a consultation button is a click to book.
 */
export const INSIGHTS_CLICKS = [
  { key: 'clicked_to_book', label: 'Clicked to book', events: ['consultation_cta_click', 'product_order_external_click'], verticals: ['service', 'experience'] },
  { key: 'clicked_to_call', label: 'Clicked to call', events: ['phone_click'], verticals: null },
  { key: 'clicked_to_order', label: 'Clicked to order', events: ['product_order_external_click'], verticals: ['restaurant'] },
] as const satisfies ReadonlyArray<{ key: string; label: string; events: readonly string[]; verticals: readonly string[] | null }>
export type InsightsClickEvent = typeof INSIGHTS_CLICKS[number]['events'][number]
export const isInsightsClick = (event: string): event is InsightsClickEvent => INSIGHTS_CLICKS.some(click => (click.events as readonly string[]).includes(event))
/** A click's day count: the dimension day [interaction, event name, '']. */
export const clickKey = (event: string) => JSON.stringify(['interaction', event, ''])

/** Which filters a page reads; the rest are not offered on it. */
type PageFilters = 'kind_location' | 'kind' | 'range'

interface PageDefinition {
  id: string
  section: 'quality' | 'rates' | 'conversion' | 'marketing'
  /** The kinds the page describes. `null`: it is about the business and its website, whatever it books. */
  kinds: readonly InsightsKind[] | null
  filters: PageFilters
}

export const INSIGHTS_PAGES = [
  { id: 'quality/overall-rating', section: 'quality', kinds: null, filters: 'kind_location' },
  { id: 'rates/occupancy-rate', section: 'rates', kinds: ['stay'], filters: 'kind_location' },
  { id: 'rates/bookings', section: 'rates', kinds: ['experience', 'service', 'table'], filters: 'kind_location' },
  { id: 'rates/cancellation-rate', section: 'rates', kinds: INSIGHTS_KINDS, filters: 'kind_location' },
  { id: 'rates/length-of-stay', section: 'rates', kinds: ['stay'], filters: 'kind_location' },
  { id: 'rates/party-size', section: 'rates', kinds: ['experience', 'table'], filters: 'kind_location' },
  { id: 'rates/nightly-rate', section: 'rates', kinds: ['stay'], filters: 'kind_location' },
  { id: 'rates/average-value', section: 'rates', kinds: ['experience', 'service', 'table'], filters: 'kind_location' },
  { id: 'rates/income-by-channel', section: 'rates', kinds: INSIGHTS_KINDS, filters: 'kind_location' },
  { id: 'conversion/booking-conversion', section: 'conversion', kinds: INSIGHTS_KINDS, filters: 'kind' },
  { id: 'conversion/lead-time', section: 'conversion', kinds: INSIGHTS_KINDS, filters: 'kind_location' },
  { id: 'conversion/returning', section: 'conversion', kinds: INSIGHTS_KINDS, filters: 'kind_location' },
  { id: 'conversion/page-views', section: 'conversion', kinds: null, filters: 'range' },
  { id: 'conversion/top-pages', section: 'conversion', kinds: null, filters: 'range' },
  { id: 'conversion/sources', section: 'conversion', kinds: null, filters: 'range' },
  { id: 'marketing/instagram', section: 'marketing', kinds: null, filters: 'range' },
  { id: 'marketing/google-ads', section: 'marketing', kinds: null, filters: 'range' },
] as const satisfies readonly PageDefinition[]

export type InsightsPageId = typeof INSIGHTS_PAGES[number]['id']
export type InsightsPageDefinition = typeof INSIGHTS_PAGES[number]
/** The pages read from KrabiClaw's own records; the Marketing pages are read from Instagram and Google Ads. */
export type InsightsStoredPageId = Exclude<InsightsPageId, 'marketing/instagram' | 'marketing/google-ads'>
export const INSIGHTS_STORED_PAGE_IDS = INSIGHTS_PAGES.filter(page => page.section !== 'marketing').map(page => page.id) as InsightsStoredPageId[]

export function insightsPage(id: string): InsightsPageDefinition | null {
  return INSIGHTS_PAGES.find(page => page.id === id) ?? null
}

/** The kinds a page reads under a filter: the chosen one, or under All every kind it describes. */
export function pageKinds(page: InsightsPageDefinition, kind: InsightsKindFilter): readonly InsightsKind[] {
  const kinds = page.kinds ?? INSIGHTS_KINDS
  return kind === 'all' ? kinds : kinds.filter(candidate => candidate === kind)
}

/**
 * Whether a page belongs to a business booking `booked`, under the kind filter.
 * All shows the numbers every kind shares and hides a page that describes only
 * some of them; a kind shows its own pages. A business that books nothing has
 * only its reviews, its website and its marketing.
 */
export function pageShown(page: InsightsPageDefinition, booked: readonly InsightsKind[], kind: InsightsKindFilter): boolean {
  if (page.kinds === null) return true
  const kinds: readonly InsightsKind[] = page.kinds
  if (kind !== 'all') return booked.includes(kind) && kinds.includes(kind)
  return booked.length > 0 && booked.every(candidate => kinds.includes(candidate))
}

/** The kinds a filter covers for wording: the chosen one, or every kind booked. */
const wordingKinds = (booked: readonly InsightsKind[], kind: InsightsKindFilter) => kind === 'all' ? booked : [kind]
const only = (kinds: readonly InsightsKind[], kind: InsightsKind) => kinds.length > 0 && kinds.every(candidate => candidate === kind)

/** The people who book, in the business's words. */
export function bookerWord(booked: readonly InsightsKind[], kind: InsightsKindFilter): string {
  const kinds = wordingKinds(booked, kind)
  return only(kinds, 'service') ? 'clients' : only(kinds, 'table') ? 'diners' : 'guests'
}

/** What one row of a page's offering list is. */
export function offeringsWord(booked: readonly InsightsKind[], kind: InsightsKindFilter): string {
  const kinds = wordingKinds(booked, kind)
  return only(kinds, 'stay') ? 'Homes' : only(kinds, 'service') ? 'Practice areas' : only(kinds, 'experience') ? 'Experiences' : only(kinds, 'table') ? 'Tables' : 'Offerings'
}

export function sectionTitle(section: InsightsPageDefinition['section'], booked: readonly InsightsKind[], kind: InsightsKindFilter): string {
  if (section === 'quality') return 'Quality'
  if (section === 'conversion') return 'Conversion'
  if (section === 'marketing') return 'Marketing'
  return only(wordingKinds(booked, kind), 'stay') ? 'Occupancy & rates' : 'Bookings & rates'
}

export function pageTitle(id: InsightsPageId, booked: readonly InsightsKind[], kind: InsightsKindFilter): string {
  const kinds = wordingKinds(booked, kind)
  switch (id) {
    case 'quality/overall-rating': return 'Overall rating'
    case 'rates/occupancy-rate': return 'Occupancy rate'
    case 'rates/bookings': return only(kinds, 'service') ? 'Consultations' : only(kinds, 'table') ? 'Reservations' : 'Bookings'
    case 'rates/cancellation-rate': return 'Cancellation rate'
    case 'rates/length-of-stay': return 'Length of stay'
    case 'rates/party-size': return 'Party size'
    case 'rates/nightly-rate': return 'Nightly rate'
    case 'rates/average-value': return 'Average value'
    case 'rates/income-by-channel': return 'Income by channel'
    case 'conversion/booking-conversion': return 'Booking conversion'
    case 'conversion/lead-time': return 'Booking lead time'
    case 'conversion/returning': return `Returning ${bookerWord(booked, kind)}`
    case 'conversion/page-views': return 'Page views'
    case 'conversion/top-pages': return 'Top pages'
    case 'conversion/sources': return 'Sources'
    case 'marketing/instagram': return 'Instagram'
    case 'marketing/google-ads': return 'Google Ads'
  }
}

/** How a number reads. Money is in the minor units of the page's currency. */
export const INSIGHTS_FORMATS = ['count', 'percent', 'rating', 'money', 'nights', 'days', 'people', 'text'] as const
export type InsightsFormat = typeof INSIGHTS_FORMATS[number]

const format = z.enum(INSIGHTS_FORMATS)
const number = z.number().nullable()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const insightsIndexSchema = z.object({
  /** What the business books; a kind filter is offered when there is more than one. */
  kinds: z.array(z.enum(INSIGHTS_KINDS)),
  /** Whether the business has a menu; its dishes count only as pages viewed. */
  has_menu: z.boolean(),
  /** The places a location filter chooses between, offered when there is more than one. */
  locations: z.array(z.object({ id: z.string(), title: z.string() })),
  /** The pages this member may open. A member who reads no analytics reads Quality for the visits they look after. */
  pages: z.array(z.enum(INSIGHTS_PAGES.map(page => page.id) as [InsightsPageId, ...InsightsPageId[]])),
})
export type InsightsIndex = z.infer<typeof insightsIndexSchema>

export const insightsReviewSchema = z.object({
  id: z.string(),
  author: z.string(),
  rating: z.number().int().min(1).max(5),
  /** The offering reviewed, or the location of a review left without one. */
  subject: z.string().nullable(),
  /** The review questions it answered, when it reviewed a booked visit. */
  questions: z.enum(REVIEW_SUBJECTS).nullable(),
  source: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'private']),
  /** The local day the review was written. */
  date,
  title: z.string().nullable(),
  content: z.string().nullable(),
  private_feedback: z.string().nullable(),
  categories: z.array(z.object({ key: z.string(), label: z.string(), rating: z.number().int().min(1).max(5) })),
})
export type InsightsReview = z.infer<typeof insightsReviewSchema>

export const insightsPageSchema = z.object({
  page: z.enum(INSIGHTS_STORED_PAGE_IDS as [InsightsStoredPageId, ...InsightsStoredPageId[]]),
  title: z.string(),
  section: z.string(),
  /** What the numbers cover when it is not every booking, such as "Website bookings". */
  subtitle: z.string().nullable(),
  period: z.object({ start_date: date, end_date: date, timezone: z.string() }),
  filters: z.object({ kind: z.enum(['all', ...INSIGHTS_KINDS]), location_id: z.string().nullable() }),
  /** The currency every money number on the page is in; null when the page has none. */
  currency: z.string().nullable(),
  metrics: z.array(z.object({ key: z.string(), label: z.string(), value: number, format, text: z.string().nullable() })),
  /** Each headline number's value on each day of the range; a metric absent here has no chart. Null is a day with nothing to measure. */
  series: z.object({ dates: z.array(date), values: z.record(z.string(), z.array(number)) }),
  list: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('rows'),
      heading: z.string(),
      columns: z.array(z.object({ label: z.string(), format })),
      rows: z.array(z.object({ key: z.string(), label: z.string(), values: z.array(number) })),
    }),
    z.object({ kind: z.literal('reviews'), reviews: z.array(insightsReviewSchema) }),
  ]),
})
export type InsightsPage = z.infer<typeof insightsPageSchema>
