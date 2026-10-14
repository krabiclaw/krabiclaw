import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { createStripeClient } from '~/server/utils/stripe-client'
import { confirmPayment } from '~/server/domain/payments/intent'

/** The buyer confirmed the reviewed amount on the reviewed method. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const paymentId = getRouterParam(event, 'paymentId')
  const body = await readRequiredBody<{ claim?: unknown; payment_method_id?: unknown; total?: unknown }>(event)
  if (!organizationId || !paymentId || typeof body.claim !== 'string' || typeof body.payment_method_id !== 'string' || !Number.isSafeInteger(body.total)) return jsonResponse({ error: 'Payment not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Stripe is not configured' }, { status: 503 })
  return jsonResponse(await confirmPayment(env.DB, createStripeClient(env.STRIPE_SECRET_KEY, 'payments'), env, organizationId, paymentId, body.claim, { payment_method_id: body.payment_method_id, total: body.total as number }))
})
