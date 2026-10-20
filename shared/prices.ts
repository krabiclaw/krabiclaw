import { instantDate } from '../utils/timezone.ts'
import { currencyFractionDigits, type CurrencyCode } from './currencies.ts'

// Billing recurrence. This describes when the customer is CHARGED, never when
// a class runs: a weekly pottery course is product_availability_rules, not a
// weekly recurring price. The set lives here rather than as a CHECK because D1
// cannot alter a CHECK on a referenced table.
export const PRICE_TYPES = ['one_time', 'recurring'] as const
export type PriceType = typeof PRICE_TYPES[number]

export const PRICE_RECURRING_INTERVALS = ['day', 'week', 'month', 'year'] as const
export type PriceRecurringInterval = typeof PRICE_RECURRING_INTERVALS[number]

export const PRICE_TAX_BEHAVIORS = ['unspecified', 'inclusive', 'exclusive'] as const
export type PriceTaxBehavior = typeof PRICE_TAX_BEHAVIORS[number]

// A monetary offer on one variant. The product is reached through the variant;
// there is no product_id here, because two writable parents can disagree.
export interface Price {
  id: string
  organization_id: string
  product_variant_id: string
  // A declared scope. NULL means "this offer applies wherever the product is
  // offered" — it is not a missing association and not a wildcard fallback.
  location_id: string | null
  active: boolean
  currency: CurrencyCode
  // Integer amount in the currency's smallest unit.
  unit_amount: number
  type: PriceType
  recurring_interval: PriceRecurringInterval | null
  recurring_interval_count: number | null
  tax_behavior: PriceTaxBehavior
  compare_at_unit_amount: number | null
  valid_from_at: string | null
  valid_until_at: string | null
  source: string
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
}

export interface PriceInput {
  /**
   * The identity of a price that already exists. A caller restating a price it
   * loaded keeps that row: an edit to a product's description must not retire
   * every offer and mint new ones with today's date on them.
   */
  id?: string
  unit_amount: number
  /** Omitted when the price takes the site's own currency, which the writer resolves. */
  currency?: CurrencyCode
  location_id?: string | null
  active?: boolean
  type?: PriceType
  recurring_interval?: PriceRecurringInterval | null
  recurring_interval_count?: number | null
  tax_behavior?: PriceTaxBehavior
  compare_at_unit_amount?: number | null
  valid_from_at?: string | null
  valid_until_at?: string | null
  source?: string
}

// The billing terms a caller is asking for. Selection never guesses these: a
// surface that shows one-time prices asks for one-time prices.
export type PriceBilling =
  | { type: 'one_time' }
  | { type: 'recurring'; interval: PriceRecurringInterval; interval_count: number }

export interface PriceSelection {
  currency: CurrencyCode
  // The location context. `null` means there is no location context, and only
  // location-neutral offers apply. Passing a location does NOT silently widen
  // to neutral offers as a second source — see the precedence rule below.
  location_id: string | null
  at?: string
  billing?: PriceBilling
}

export class AmbiguousPriceError extends Error {
  readonly candidates: readonly string[]
  constructor(candidates: readonly string[]) {
    super(`price selection is ambiguous between ${candidates.length} offers: ${candidates.join(', ')}`)
    this.name = 'AmbiguousPriceError'
    this.candidates = candidates
  }
}

function assertInstant(value: string, field: string): void {
  if (instantDate(value).toISOString() !== value) throw new Error(`${field} must be an ISO UTC instant`)
}

export function assertPriceShape(price: Pick<Price, 'type' | 'recurring_interval' | 'recurring_interval_count' | 'unit_amount' | 'compare_at_unit_amount' | 'currency' | 'valid_from_at' | 'valid_until_at'>): void {
  if (!Number.isSafeInteger(price.unit_amount) || price.unit_amount < 0) {
    throw new Error('unit_amount must be a non-negative integer in the currency minor unit')
  }
  if (price.compare_at_unit_amount !== null && price.compare_at_unit_amount <= price.unit_amount) {
    throw new Error('compare_at_unit_amount must exceed unit_amount')
  }
  if (!/^[A-Z]{3}$/.test(price.currency)) throw new Error('currency must be a normalized ISO 4217 code')
  if (price.valid_from_at) assertInstant(price.valid_from_at, 'valid_from_at')
  if (price.valid_until_at) assertInstant(price.valid_until_at, 'valid_until_at')
  if (price.valid_from_at && price.valid_until_at && price.valid_until_at <= price.valid_from_at) {
    throw new Error('price validity interval must be positive')
  }
  if (price.type === 'recurring') {
    if (!price.recurring_interval || !PRICE_RECURRING_INTERVALS.includes(price.recurring_interval)) {
      throw new Error(`recurring price requires one of: ${PRICE_RECURRING_INTERVALS.join(', ')}`)
    }
    if (!Number.isSafeInteger(price.recurring_interval_count) || (price.recurring_interval_count ?? 0) < 1) {
      throw new Error('recurring_interval_count must be a positive integer')
    }
    return
  }
  if (!PRICE_TYPES.includes(price.type)) throw new Error(`unsupported billing type: ${String(price.type)}`)
  if (price.recurring_interval !== null || price.recurring_interval_count !== null) {
    throw new Error('a one-time price must not carry recurrence fields')
  }
}

function billingOf(price: Pick<Price, 'type' | 'recurring_interval' | 'recurring_interval_count'>): PriceBilling {
  return price.type === 'recurring'
    ? { type: 'recurring', interval: price.recurring_interval!, interval_count: price.recurring_interval_count! }
    : { type: 'one_time' }
}

function billingMatches(price: Pick<Price, 'type' | 'recurring_interval' | 'recurring_interval_count'>, billing: PriceBilling): boolean {
  const actual = billingOf(price)
  if (actual.type !== billing.type) return false
  if (actual.type === 'one_time' || billing.type === 'one_time') return true
  return actual.interval === billing.interval && actual.interval_count === billing.interval_count
}

function coversInstant(price: Pick<Price, 'valid_from_at' | 'valid_until_at'>, at: string): boolean {
  if (price.valid_from_at && price.valid_from_at > at) return false
  if (price.valid_until_at && at >= price.valid_until_at) return false
  return true
}

// The scope key a price competes within. Two prices sharing this key and an
// overlapping validity window are a conflict, because nothing distinguishes
// which one the customer pays.
function scopeKey(price: Price): string {
  const billing = billingOf(price)
  const terms = billing.type === 'recurring' ? `recurring:${billing.interval}:${billing.interval_count}` : 'one_time'
  return `${price.product_variant_id}|${price.currency}|${price.location_id ?? ''}|${terms}`
}

// Write-time guard: refuse a price set in which two active offers of the same
// scope are simultaneously valid. Called before persisting, so the conflict
// surfaces to the person creating it rather than to a customer at checkout.
export function assertNoConflictingPrices(prices: readonly Price[]): void {
  const byScope = new Map<string, Price[]>()
  for (const price of prices) {
    assertPriceShape(price)
    if (!price.active) continue
    const key = scopeKey(price)
    const group = byScope.get(key)
    if (group) group.push(price)
    else byScope.set(key, [price])
  }
  for (const group of byScope.values()) {
    const ordered = [...group].sort((left, right) => (left.valid_from_at ?? '').localeCompare(right.valid_from_at ?? ''))
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!
      const current = ordered[index]!
      const previousEnd = previous.valid_until_at
      const currentStart = current.valid_from_at ?? ''
      if (previousEnd === null || previousEnd > currentStart) {
        throw new AmbiguousPriceError([previous.id, current.id])
      }
    }
  }
}

// The one price-selection contract. Every surface — public pages, CMS, MCP,
// ChowBot, WhatsApp, Stripe export — resolves an amount through this and
// nowhere else.
//
// The rule, in full:
//   1. Discard inactive offers, offers in another currency, offers outside
//      their validity window at `at`, and offers whose billing terms are not
//      the ones asked for.
//   2. Discard location-scoped offers for any other location.
//   3. SCOPE PRECEDENCE: if a location context was given and any offer is
//      scoped to exactly that location, only those compete. Location-neutral
//      offers are a broader declared scope, not a second source consulted when
//      the narrow one is empty — when a location-specific offer exists it is
//      the answer, and when none does the neutral offer was always the answer.
//   4. If more than one offer survives, throw. Ordering the survivors and
//      taking the first would be picking a price for the customer.
//   5. If none survives, return null. The caller renders an explicit "not
//      purchasable" state. It does NOT substitute another currency, another
//      location, a lapsed offer, or prose.
export function selectPrice<T extends Pick<Price, 'id' | 'active' | 'currency' | 'location_id' | 'type' | 'recurring_interval' | 'recurring_interval_count' | 'valid_from_at' | 'valid_until_at'>>(prices: readonly T[], selection: PriceSelection): T | null {
  const at = selection.at ?? new Date().toISOString()
  assertInstant(at, 'at')
  const billing: PriceBilling = selection.billing ?? { type: 'one_time' }

  const applicable = prices.filter(price =>
    price.active
    && price.currency === selection.currency
    && coversInstant(price, at)
    && billingMatches(price, billing)
    && (price.location_id === null || price.location_id === selection.location_id),
  )

  const specific = selection.location_id === null
    ? []
    : applicable.filter(price => price.location_id === selection.location_id)
  const candidates = specific.length > 0 ? specific : applicable.filter(price => price.location_id === null)

  if (candidates.length === 0) return null
  if (candidates.length > 1) throw new AmbiguousPriceError(candidates.map(price => price.id))
  return candidates[0]!
}

export function majorAmountToMinor(value: string, currency: CurrencyCode): number {
  const digits = currencyFractionDigits(currency)
  const pattern = digits === 0 ? /^(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/
  if (!pattern.test(value)) throw new Error(`${currency} amounts must use at most ${digits} fraction digits`)
  const [whole, fraction = ''] = value.split('.')
  const minor = Number(whole) * (10 ** digits) + Number(fraction.padEnd(digits, '0') || 0)
  if (!Number.isSafeInteger(minor)) throw new Error('amount exceeds safe integer range')
  return minor
}

export function formatMinorAmount(unitAmount: number, currency: CurrencyCode, locale = 'en-US'): string {
  if (!Number.isSafeInteger(unitAmount) || unitAmount < 0) throw new Error('unit_amount must be a non-negative safe integer')
  const digits = currencyFractionDigits(currency)
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(unitAmount / (10 ** digits))
}

export function minorAmountToMajor(unitAmount: number, currency: CurrencyCode): string {
  if (!Number.isSafeInteger(unitAmount) || unitAmount < 0) throw new Error('unit_amount must be a non-negative safe integer')
  const digits = currencyFractionDigits(currency)
  return digits === 0 ? String(unitAmount) : (unitAmount / (10 ** digits)).toFixed(digits)
}

