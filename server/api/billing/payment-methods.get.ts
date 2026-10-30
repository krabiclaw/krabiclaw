import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { listCustomerCards, resolveBillingCustomer, type PaymentMethodRow } from '~/server/utils/billing-customer'

/** Airbnb's "Payment methods": the cards on this business's Stripe customer. */
export default defineHandler(async (event) => {
  const query = getQuery(event)
  if (typeof query.organizationId !== 'string' || !query.organizationId) throw new HTTPError({ statusCode: 400, statusMessage: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'organizationId' } })
  try {
  const { stripe, customerId } = await resolveBillingCustomer(event, query.organizationId)
  const payment_methods: PaymentMethodRow[] = customerId ? await listCustomerCards(stripe, customerId) : []
  return jsonResponse({ payment_methods }, { headers: { 'cache-control': 'private, no-store' } })
  } catch (cause) {
    if (cause instanceof HTTPError) throw cause
    throw new HTTPError({ statusCode: 502, statusMessage: 'Billing cards could not be read', data: { code: 'BILLING_CARDS_UNAVAILABLE', field: 'payment_methods' }, cause })
  }
})
