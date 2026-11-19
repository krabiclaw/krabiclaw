import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { ensureInteractionUser } from '~/server/utils/auth'
import { completePaymentReturn, type preparePaymentReturn } from '~/server/domain/payments/intent'

/** The buyer is back from paying on this site: the purchase is verified, attached to the site's buyer and its receipt named. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const paymentId = getRouterParam(event, 'payment_id')
  if (event.context.checkoutBodyError) throw event.context.checkoutBodyError
  const body = (event.context.checkoutBody as { claim?: unknown } | undefined) ?? await readRequiredBody<{ claim?: unknown }>(event)
  if (!organizationId || !paymentId || typeof body.claim !== 'string') return jsonResponse({ error: 'Payment not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  const prepared = event.context.paymentReturn as { paymentId: string; plan: Awaited<ReturnType<typeof preparePaymentReturn>>; row: unknown } | undefined
  return jsonResponse(await completePaymentReturn(env.DB, env, organizationId, paymentId, body.claim, async () => (await ensureInteractionUser(event, env)).id,
    prepared?.paymentId === paymentId ? prepared : undefined), { headers: { 'cache-control': 'private, no-store' } })
})
