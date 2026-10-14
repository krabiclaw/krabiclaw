import type { CloudflareEnv } from '~/server/utils/auth'
import { queryAll } from '~/server/db'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { createStripeClient } from '~/server/utils/stripe-client'
import { requirePayment } from '~/server/domain/payments'
import { reconcilePaymentIntent } from '~/server/domain/payments/events'

/**
 * A hosted Checkout expired itself; a PaymentIntent waits until someone cancels
 * it. Once a buyer's time to pay has run out, the intent is abandoned at Stripe,
 * and Stripe's answer is settled through the one path its webhook also takes:
 * the payment fails, the capacity hold is released, the expiry is recorded.
 */
export default defineScheduledTask<{ skipped?: string; expired?: number }>({
  meta: { name: 'payments:expire-attempts', description: 'Abandon PaymentIntents whose time to pay has run out' },
  async run({ context }) {
    const env = (context as { cloudflare?: { env?: CloudflareEnv } } | undefined)?.cloudflare?.env
    if (!env?.DB) throw new Error('DB is required')
    if (!env.STRIPE_SECRET_KEY) return { result: { skipped: 'Stripe is not configured' } }
    const stripe = createStripeClient(env.STRIPE_SECRET_KEY, 'payments')
    const due = await queryAll<{ organization_id: string; payment_id: string; stripe_payment_intent_id: string; stripe_account_id: string }>(env.DB, `SELECT p.organization_id,a.payment_id,a.stripe_payment_intent_id,p.stripe_account_id FROM payment_attempts a JOIN payments p ON p.id=a.payment_id
      WHERE a.status='open' AND a.stripe_payment_intent_id IS NOT NULL AND a.expires_at<=? AND p.captured_amount=0 ORDER BY a.expires_at LIMIT 100`, [new Date().toISOString()])
    for (const row of due) {
      const payment = await requirePayment(env.DB, row.organization_id, row.payment_id)
      const current = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, {}, { stripeAccount: row.stripe_account_id })
      // A payment that completed while its webhook is still on the way settles from the intent as it is.
      const intent = current.status === 'succeeded' || current.status === 'canceled' || current.status === 'processing'
        ? current
        : await stripe.paymentIntents.cancel(row.stripe_payment_intent_id, { cancellation_reason: 'abandoned' }, { stripeAccount: row.stripe_account_id })
      if (intent.status === 'processing') continue
      await reconcilePaymentIntent(env.DB, stripe, payment, intent, env)
    }
    return { result: { expired: due.length } }
  },
})
