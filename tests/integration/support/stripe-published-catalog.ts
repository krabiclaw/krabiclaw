import { BILLING_METER_KEYS, BILLING_METERS, type BillingMeterKey } from '../../../shared/billing-model.ts'

// Stripe's published metered catalog, as its list endpoints return it: each
// meter's one active product, its monthly price at the published tiers or
// rate, and its active meter. Answers null for any other request.

function price(key: BillingMeterKey) {
  const definition = BILLING_METERS[key]
  return {
    object: 'price', id: `price-${key}`, product: `prod-${key}`, active: true, currency: 'usd', type: 'recurring',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'metered', meter: `mtr-${key}` },
    ...('tiers' in definition
      ? { billing_scheme: 'tiered', tiers_mode: 'graduated', unit_amount: null, tiers: definition.tiers.map(tier => ({ up_to: tier.up_to === 'inf' ? null : tier.up_to, unit_amount: tier.unit_amount, flat_amount: null })) }
      : { billing_scheme: 'per_unit', unit_amount: null, unit_amount_decimal: Number(definition.unitAmountDecimal).toFixed(12) }),
  }
}

export function publishedCatalogResponse(url: URL): Response | null {
  const list = (data: unknown[]) => Response.json({ object: 'list', data, has_more: false })
  if (url.pathname === '/v1/products') return list(BILLING_METER_KEYS.map(key => ({ object: 'product', id: `prod-${key}`, active: true, metadata: { product_family: key, monthly_price_id: `price-${key}` } })))
  if (url.pathname === '/v1/prices') return list(BILLING_METER_KEYS.map(price))
  if (url.pathname === '/v1/billing/meters') return list(BILLING_METER_KEYS.map(key => ({ object: 'billing.meter', id: `mtr-${key}`, status: 'active', event_name: BILLING_METERS[key].eventName, default_aggregation: { formula: BILLING_METERS[key].formula } })))
  return null
}
