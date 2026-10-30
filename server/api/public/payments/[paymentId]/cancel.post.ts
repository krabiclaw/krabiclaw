import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { paymentsStripe } from '~/server/utils/stripe-connect'
import { requirePayment } from '~/server/domain/payments'
import { cancelStayPayment } from '~/server/domain/payments/intent'

/** The purchase claim authorizes releasing only this buyer's unpaid stay checkout. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const paymentId = getRouterParam(event, 'paymentId')
  const body = await readRequiredBody<{ claim?: unknown }>(event)
  if (!organizationId || !paymentId || typeof body.claim !== 'string') return jsonResponse({ error: 'Payment not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  return jsonResponse(await cancelStayPayment(env.DB, paymentsStripe(env, Boolean((await requirePayment(env.DB, organizationId, paymentId)).livemode)), env, organizationId, paymentId, body.claim))
})
