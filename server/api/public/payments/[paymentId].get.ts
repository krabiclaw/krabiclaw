import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { createStripeClient } from '~/server/utils/stripe-client'
import { paymentsStripeKeys } from '~/server/utils/stripe-connect'
import { requirePayment } from '~/server/domain/payments'
import { paymentHandoff } from '~/server/domain/payments/intent'

/** The pay page: what it is for, what it costs, and the Stripe context its Payment Element mounts in. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const paymentId = getRouterParam(event, 'paymentId')
  const claim = getQuery(event).claim
  if (!organizationId || !paymentId || typeof claim !== 'string') return jsonResponse({ error: 'Payment not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  const keys = paymentsStripeKeys(env, Boolean((await requirePayment(env.DB, organizationId, paymentId)).livemode))
  if (!keys) return jsonResponse({ error: 'Stripe is not configured' }, { status: 503 })
  return jsonResponse(await paymentHandoff(env.DB, createStripeClient(keys.secretKey, 'payments'), keys.publishableKey ?? '', organizationId, paymentId, claim), { headers: { 'cache-control': 'private, no-store' } })
})
