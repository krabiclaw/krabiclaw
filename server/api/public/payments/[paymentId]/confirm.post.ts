import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { paymentsStripe } from '~/server/utils/stripe-connect'
import { requirePayment } from '~/server/domain/payments'
import { confirmPayment } from '~/server/domain/payments/intent'
import { resolvePublicOrigin } from '~/server/utils/platform-llm'

/** The buyer confirmed the reviewed amount on the reviewed method; a method that leaves the site returns to this one. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const paymentId = getRouterParam(event, 'paymentId')
  const body = await readRequiredBody<{ claim?: unknown; payment_method_id?: unknown; total?: unknown }>(event)
  if (!organizationId || !paymentId || typeof body.claim !== 'string' || typeof body.payment_method_id !== 'string' || !Number.isSafeInteger(body.total)) return jsonResponse({ error: 'Payment not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  return jsonResponse(await confirmPayment(env.DB, paymentsStripe(env, Boolean((await requirePayment(env.DB, organizationId, paymentId)).livemode)), env, organizationId, paymentId, body.claim, { payment_method_id: body.payment_method_id, total: body.total as number }, resolvePublicOrigin(event)))
})
