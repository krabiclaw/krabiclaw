import type { CloudflareEnv } from '~/server/utils/auth'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { createStripeClient } from '~/server/utils/stripe-client'
import { stripeLivemodeFromKey } from '~/server/utils/stripe-connect'
import { requestStripeFeeReport } from '~/server/domain/payments/costs'

export default defineScheduledTask<{ skipped?: string; status?: 'test_mode_unavailable' | 'live_mode' }>({
  meta: {
    name: 'payments:stripe-fee-report-request',
    description: 'Request the itemized Stripe fee report; Stripe delivers it by webhook',
  },
  async run({ context }) {
    const env = (context as { cloudflare?: { env?: CloudflareEnv } } | undefined)?.cloudflare?.env
    if (!env?.DB) throw new Error('DB is required')
    if (!env.STRIPE_SECRET_KEY) return { result: { skipped: 'Stripe is not configured' } }
    // Stripe report runs are requested, not pushed, so this is the one call the
    // provider cannot make for us. The finished run arrives at the platform
    // webhook as `reporting.report_run.succeeded` and is ingested there.
    return { result: await requestStripeFeeReport(env.DB, createStripeClient(env.STRIPE_SECRET_KEY, 'payments'), stripeLivemodeFromKey(env.STRIPE_SECRET_KEY)) }
  },
})
