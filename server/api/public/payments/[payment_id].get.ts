import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { paymentHandoff, type preparePaymentHandoff } from '~/server/domain/payments/intent'

/** The pay page: what it is for, what it costs, and the Stripe context its Payment Element mounts in. */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const paymentId = getRouterParam(event, 'payment_id')
  const claim = getQuery(event).claim
  if (!organizationId || !paymentId || typeof claim !== 'string') return jsonResponse({ error: 'Payment not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  const preloaded = event.context.paymentHandoff as { paymentId: string; plan: Awaited<ReturnType<typeof preparePaymentHandoff>>; row: unknown } | undefined
  const handoff = preloaded?.paymentId === paymentId ? await preloaded.plan.read(env, preloaded.row)
    : await paymentHandoff(env.DB, env, organizationId, paymentId, claim)
  return jsonResponse(handoff, { headers: { 'cache-control': 'private, no-store' } })
})
