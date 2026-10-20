import type Stripe from 'stripe'
import { currencyFractionDigits, isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { isRecord } from '~/server/utils/type-guards'

/** Stripe's informative quote, retained with the amount it prices for USD billing. */
export interface StripeFxQuote {
  id: string
  object: 'fx_quote'
  created: number
  to_currency: 'usd'
  lock_duration: 'none'
  rates: Record<string, { exchange_rate: number; rate_details: { base_rate: number; fx_fee_rate: number } }>
}
export interface PaymentsBillingBasis {
  currency: 'USD'
  amount: number
  source_currency: CurrencyCode
  source_amount: number
  fx_quote: StripeFxQuote | null
  cost_totals?: { before: number; after: number }
}

export function requireBillingFxQuote(value: unknown, currency: CurrencyCode): StripeFxQuote | null {
  if (currency === 'USD') {
    if (value !== undefined && value !== null) throw new Error('USD billing does not require an FX quote')
    return null
  }
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.startsWith('fxq_') || value.object !== 'fx_quote'
    || typeof value.created !== 'number' || !Number.isFinite(value.created) || value.to_currency !== 'usd' || value.lock_duration !== 'none'
    || !isRecord(value.rates)) throw new Error('A native Stripe FX Quote is required for foreign-currency billing')
  const rate = value.rates[currency.toLowerCase()]
  if (!isRecord(rate) || typeof rate.exchange_rate !== 'number' || !Number.isFinite(rate.exchange_rate) || rate.exchange_rate <= 0
    || !isRecord(rate.rate_details) || typeof rate.rate_details.base_rate !== 'number' || !Number.isFinite(rate.rate_details.base_rate) || rate.rate_details.base_rate <= 0
    || typeof rate.rate_details.fx_fee_rate !== 'number' || !Number.isFinite(rate.rate_details.fx_fee_rate) || rate.rate_details.fx_fee_rate < 0) throw new Error('Stripe did not quote the offering currency into USD')
  return value as unknown as StripeFxQuote
}

export async function quotePaymentsBillingFx(stripe: Stripe, currency: CurrencyCode): Promise<StripeFxQuote | null> {
  if (currency === 'USD') return null
  const quote: unknown = await stripe.rawRequest('POST', '/v1/fx_quotes', { from_currencies: [currency.toLowerCase()], to_currency: 'usd', lock_duration: 'none' }, { apiVersion: '2025-07-30.preview' })
  return requireBillingFxQuote(quote, currency)
}

/** Convert gross principal at the quoted base rate; processor FX fees stay in the actual-cost ledger. */
export function paymentsBillingBasis(amount: number, currency: string, fxQuote?: unknown): PaymentsBillingBasis {
  if (!Number.isSafeInteger(amount) || !isCurrencyCode(currency)) throw new Error('Billing requires exact supported currency minor units')
  const quote = requireBillingFxQuote(fxQuote, currency)
  if (!quote) return { currency: 'USD', amount, source_currency: currency, source_amount: amount, fx_quote: null }
  const decimal = String(quote.rates[currency.toLowerCase()]!.rate_details.base_rate)
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(decimal)
  if (!match) throw new Error('Stripe FX base rate is not a positive decimal')
  const fractional = match[2] ?? ''
  const scale = fractional.length - Number(match[3] ?? 0)
  const numerator = BigInt(Math.abs(amount)) * BigInt(match[1]! + fractional) * 100n * (scale < 0 ? 10n ** BigInt(-scale) : 1n)
  const denominator = 10n ** BigInt(currencyFractionDigits(currency) + Math.max(scale, 0))
  const converted = Number((numerator + denominator / 2n) / denominator) * Math.sign(amount)
  if (!Number.isSafeInteger(converted)) throw new Error('Quoted USD amount exceeds exact minor units')
  return { currency: 'USD', amount: converted, source_currency: currency, source_amount: amount, fx_quote: quote }
}

export function readPaymentsBillingBasis(json: string | null | undefined, amount: number, currency: string): PaymentsBillingBasis {
  if (!json) return paymentsBillingBasis(amount, currency)
  const stored: unknown = JSON.parse(json)
  if (!isRecord(stored) || stored.currency !== 'USD' || stored.source_currency !== currency || stored.source_amount !== amount || !Number.isSafeInteger(stored.amount)) throw new Error('Billing basis does not match its provider amount')
  let calculated: PaymentsBillingBasis
  if (stored.cost_totals === undefined) {
    calculated = paymentsBillingBasis(amount, currency, stored.fx_quote)
  } else {
    const totals = stored.cost_totals
    if (!isRecord(totals) || typeof totals.before !== 'number' || !Number.isSafeInteger(totals.before)
      || typeof totals.after !== 'number' || !Number.isSafeInteger(totals.after) || totals.after - totals.before !== amount) {
      throw new Error('Cost adjustment does not match its native report totals')
    }
    calculated = paymentsCostBillingBasis(totals.before, totals.after, currency, stored.fx_quote)
  }
  if (calculated.amount !== stored.amount) throw new Error('Billing basis does not match its native FX quote')
  return calculated
}

/** Report revisions adjust the converted cumulative total, retaining the first quote and avoiding rounding drift. */
export function paymentsCostBillingBasis(before: number, after: number, currency: string, quote?: unknown): PaymentsBillingBasis {
  const old = paymentsBillingBasis(before, currency, quote)
  const current = paymentsBillingBasis(after, currency, quote)
  return { ...current, amount: current.amount - old.amount, source_amount: after - before, cost_totals: { before, after } }
}
