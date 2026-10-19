import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { ensureInteractionUser } from '~/server/utils/auth'
import { paymentsStripe } from '~/server/utils/stripe-connect'
import { requirePayment } from '~/server/domain/payments'
import { completePaymentReturn } from '~/server/domain/payments/intent'

/** The buyer is back from paying on this site: the purchase is verified, attached to the site's buyer and its receipt named. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const paymentId = getRouterParam(event, 'paymentId')
  const body = await readRequiredBody<{ claim?: unknown }>(event)
  if (!organizationId || !paymentId || typeof body.claim !== 'string') return jsonResponse({ error: 'Payment not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  const stripe = paymentsStripe(env, Boolean((await requirePayment(env.DB, organizationId, paymentId)).livemode))
  return jsonResponse(await completePaymentReturn(env.DB, stripe, env, organizationId, paymentId, body.claim, () => ensureInteractionUser(event, env)), { headers: { 'cache-control': 'private, no-store' } })
})
