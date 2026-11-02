/**
 * An ISO 4217 currency code. Which of them a business can charge in is
 * Stripe's to answer: a price, deposit or PaymentIntent in a currency Stripe
 * does not support for the connected account is refused by Stripe, and that
 * refusal reaches the caller.
 */
export type CurrencyCode = string

const ISO_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'))

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && ISO_CURRENCIES.has(value)
}

// Stripe's minor units for API amounts: https://docs.stripe.com/currencies#zero-decimal
// Every currency not listed is two-decimal. ISK and UGX are zero-decimal
// currencies Stripe still represents with two decimals, so they stay at 2.
const STRIPE_ZERO_DECIMAL: ReadonlySet<string> = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])
const STRIPE_THREE_DECIMAL: ReadonlySet<string> = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND'])

/** The number of decimals in a Stripe API amount of this currency. */
export function currencyFractionDigits(currency: CurrencyCode): 0 | 2 | 3 {
  if (!isCurrencyCode(currency)) throw new Error(`${currency} is not an ISO 4217 currency code`)
  return STRIPE_ZERO_DECIMAL.has(currency) ? 0 : STRIPE_THREE_DECIMAL.has(currency) ? 3 : 2
}

const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' })

export const CURRENCY_OPTIONS: Array<{ label: string; value: CurrencyCode }> = [...ISO_CURRENCIES]
  .map(code => ({ label: `${currencyNames.of(code)} (${code})`, value: code }))
  .sort((a, b) => a.label.localeCompare(b.label, 'en'))
