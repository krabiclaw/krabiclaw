import { BUSINESS_PLAN_ID, GROWTH_PLAN_ID, SERVICES, type NewSalePlanId } from './billing-model'

/**
 * What KrabiClaw offers a business that does not have it yet: a plan
 * capability, or one of Chris and Julia's services. Each is described once —
 * its illustration, headline, one line and how it works — and every surface
 * that offers something (Menu, Today, a locked leaf, Plan and billing) reads
 * it from here. Before this, Insights, booking settings and the upgrade page
 * each wrote their own.
 *
 * The order is the order of offering: the first capability the plan lacks is
 * the one Menu and Today show.
 */
export type OfferId = 'calendar_sync' | 'airbnb_sync' | 'google_ads' | 'payments' | 'custom_domain' | 'managed_ads' | 'strategy'

export interface OfferStep { icon: string; title: string; text: string }

export interface Offer {
  id: OfferId
  /** The plan capability the offer unlocks, or the service it starts. */
  unlock: { entitlement: string; plan: NewSalePlanId } | { service: keyof typeof SERVICES }
  name: string
  headline: string
  line: string
  illustration: string
  steps: readonly OfferStep[]
  /** The leaf the offer leads to once it is on. */
  path: string
}

const ILLUSTRATIONS = '/images/offers'

export const OFFERS: readonly Offer[] = [
  {
    id: 'calendar_sync', unlock: { entitlement: 'calendar_sync', plan: BUSINESS_PLAN_ID },
    name: 'Google Calendar sync', headline: 'Never get double-booked',
    line: 'Busy on your calendar? Booked out on your website. New bookings show up on your calendar.',
    illustration: `${ILLUSTRATIONS}/calendar.webp`, path: 'integrations/google-calendar',
    steps: [
      { icon: 'i-lucide-calendar', title: 'Connect your calendar', text: 'Each team member connects Google once. Only busy times are read, never what an event is.' },
      { icon: 'i-lucide-circle-check', title: 'Busy means booked out', text: 'Clients only see times when the right person is actually free.' },
      { icon: 'i-lucide-refresh-cw', title: 'Bookings land on your calendar', text: 'Every new booking appears in Google. Move it there and it moves here, and your client is told.' },
    ],
  },
  {
    id: 'airbnb_sync', unlock: { entitlement: 'channel_sync', plan: BUSINESS_PLAN_ID },
    name: 'Airbnb sync', headline: 'Your Airbnb homes, one calendar',
    line: 'Reservations, nightly rates and open dates stay in step with Airbnb, so no night is sold twice.',
    illustration: `${ILLUSTRATIONS}/home.webp`, path: 'integrations/airbnb',
    steps: [
      { icon: 'i-lucide-link', title: 'Connect your Airbnb account', text: 'Choose the listings to sync. Their photos, descriptions and house rules come across.' },
      { icon: 'i-lucide-calendar-days', title: 'One calendar for every channel', text: 'A night booked on Airbnb is closed on your website, and the other way round.' },
      { icon: 'i-lucide-message-circle', title: 'Guest messages in one inbox', text: 'Airbnb guests write to you here, beside the guests who booked direct.' },
    ],
  },
  {
    id: 'google_ads', unlock: { entitlement: 'google_ads_management', plan: BUSINESS_PLAN_ID },
    name: 'Google Ads campaigns', headline: 'Run Google Ads from your dashboard',
    line: 'Create Search campaigns, change budgets and see the bookings they bring in.',
    illustration: `${ILLUSTRATIONS}/megaphone.webp`, path: 'integrations/google-ads',
    steps: [
      { icon: 'i-lucide-link', title: 'Connect Google Ads', text: 'Link the account you advertise from. Ad spend stays billed by Google.' },
      { icon: 'i-lucide-megaphone', title: 'Create campaigns here or in ChatGPT', text: 'Search campaigns, status and daily budgets, without opening Google Ads.' },
      { icon: 'i-lucide-chart-no-axes-column', title: 'See what they bring in', text: 'Spend, clicks and the bookings that followed, in Insights.' },
    ],
  },
  {
    id: 'payments', unlock: { entitlement: 'payments', plan: BUSINESS_PLAN_ID },
    name: 'Online payments', headline: 'Get paid when clients book',
    line: 'Guests pay on your website when they book. Stays, bookings and one-time orders.',
    illustration: `${ILLUSTRATIONS}/card.webp`, path: 'billing/payments',
    steps: [
      { icon: 'i-lucide-landmark', title: 'Set up your Stripe account', text: 'Payouts go to your bank. Stripe verifies the business once.' },
      { icon: 'i-lucide-credit-card', title: 'Guests pay as they book', text: 'Cards, wallets and local methods, with a receipt they can find again.' },
      { icon: 'i-lucide-receipt', title: 'Refunds and payouts in one place', text: 'Earnings shows every payment, refund, dispute and payout.' },
    ],
  },
  {
    id: 'custom_domain', unlock: { entitlement: 'custom_domains', plan: GROWTH_PLAN_ID },
    name: 'Your own domain', headline: 'Your website at your own address',
    line: 'Connect a domain you own. Visitors and search engines see your name, not ours.',
    illustration: `${ILLUSTRATIONS}/pen.webp`, path: 'website/domains',
    steps: [
      { icon: 'i-lucide-globe', title: 'Name the domain you own', text: 'Any registrar works.' },
      { icon: 'i-lucide-list-checks', title: 'Add two DNS records', text: 'We show exactly what to paste, and check them for you.' },
      { icon: 'i-lucide-shield-check', title: 'Secure and live', text: 'The certificate is issued automatically, and the old address keeps working.' },
    ],
  },
  {
    id: 'managed_ads', unlock: { service: 'managed_ads' },
    name: SERVICES.managed_ads.name, headline: 'Get more from this budget',
    line: 'Chris hand-manages your campaigns — budgets, creative direction and conversion rate — and meets with you weekly.',
    illustration: `${ILLUSTRATIONS}/chart.webp`, path: 'billing/managed-ads',
    steps: [
      { icon: 'i-lucide-link', title: 'Connect Google Ads', text: 'Chris works in the account you already advertise from.' },
      { icon: 'i-lucide-sliders-horizontal', title: 'Budgets, creative and conversion rate', text: 'Hand-managed against your real results, with a weekly meeting.' },
      { icon: 'i-lucide-receipt', title: 'Billed with your plan', text: `${SERVICES.managed_ads.price}, ${SERVICES.managed_ads.billing.charAt(0).toLowerCase()}${SERVICES.managed_ads.billing.slice(1)}` },
    ],
  },
  {
    id: 'strategy', unlock: { service: 'strategy' },
    name: SERVICES.strategy.name, headline: 'Rank for what your clients search',
    line: 'Julia leads your SEO strategy, hand-writes posts built to rank and meets with you weekly.',
    illustration: `${ILLUSTRATIONS}/briefcase.webp`, path: 'billing/strategy',
    steps: [
      { icon: 'i-lucide-search', title: 'A strategy for your market', text: 'Julia maps what your clients search for and where you can win.' },
      { icon: 'i-lucide-pen-line', title: 'Articles written to rank', text: 'Hand-written blog posts, published on your site.' },
      { icon: 'i-lucide-messages-square', title: 'Weekly, and on chat', text: SERVICES.strategy.billing },
    ],
  },
]

export function offer(id: OfferId): Offer {
  const found = OFFERS.find(item => item.id === id)
  if (!found) throw new Error(`Unknown offer ${id}`)
  return found
}

/** The plan capabilities a plan lacks, in the order they are offered. */
export function planOffers(entitlements: Record<string, unknown>): Offer[] {
  return OFFERS.filter(item => 'entitlement' in item.unlock && entitlements[item.unlock.entitlement] !== true)
}
