import { defineHandler, HTTPError } from 'nitro'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { resolveBillingCustomer } from '~/server/utils/billing-customer'
import { listServices } from '~/server/utils/organization-services'

/** Remove: the card is detached at Stripe from this customer; nothing about it is kept here. */
export default defineHandler(async (event) => {
  const body = await readRequiredBody<{ organizationId?: string; payment_method_id?: string }>(event)
  if (typeof body.payment_method_id !== 'string' || !/^pm_[A-Za-z0-9]+$/.test(body.payment_method_id)) throw new HTTPError({ statusCode: 400, statusMessage: 'Payment method is required' })
  if (typeof body.organizationId !== 'string' || !body.organizationId) throw new HTTPError({ statusCode: 400, statusMessage: 'Organization is required' })
  const { stripe, customerId } = await resolveBillingCustomer(event, body.organizationId)
  if (!customerId) throw new HTTPError({ statusCode: 404, statusMessage: 'Payment method not found' })
  const method = await stripe.paymentMethods.retrieve(body.payment_method_id)
  if ((typeof method.customer === 'string' ? method.customer : method.customer?.id) !== customerId) throw new HTTPError({ statusCode: 404, statusMessage: 'Payment method not found' })
  if ((await listServices(cloudflareEnv(event).DB, body.organizationId)).managed_ads) {
    const customer = await stripe.customers.retrieve(customerId)
    if (customer.deleted) throw new HTTPError({ statusCode: 409, statusMessage: 'The billing customer was deleted at Stripe' })
    const defaultMethod = customer.invoice_settings.default_payment_method
    if ((typeof defaultMethod === 'string' ? defaultMethod : defaultMethod?.id) === body.payment_method_id) {
      throw new HTTPError({ statusCode: 409, message: 'Set another default payment method before removing this one while managed ads is on.' })
    }
  }
  await stripe.paymentMethods.detach(body.payment_method_id)
  return jsonResponse({ removed: true })
})
