import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { createStripeClient } from '~/server/utils/stripe-client'
import { reviewPayment } from '~/server/domain/payments/intent'

/** The buyer chose a payment method: Stripe says what it may carry, and the final amount comes back for consent. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const paymentId = getRouterParam(event, 'paymentId')
  const body = await readRequiredBody<{ claim?: unknown; payment_method_id?: unknown }>(event)
  if (!organizationId || !paymentId || typeof body.claim !== 'string' || typeof body.payment_method_id !== 'string') return jsonResponse({ error: 'Payment not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Stripe is not configured' }, { status: 503 })
  return jsonResponse(await reviewPayment(env.DB, createStripeClient(env.STRIPE_SECRET_KEY, 'payments'), organizationId, paymentId, body.claim, body.payment_method_id))
})
