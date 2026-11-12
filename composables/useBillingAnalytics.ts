import type { BillingAnalyticsContext } from '~/composables/useAnalytics'
import type { useDashboardApi } from '~/composables/dashboardFetch'
import type { StripeGa4IntentAction } from '~/shared/stripe-ga4'

export interface BillingAnalyticsIntentInput extends BillingAnalyticsContext {
  organizationId: string
  subscriptionId?: string | null
  action: StripeGa4IntentAction
  previousPriceId?: string | null
  newPriceId?: string | null
  effectiveTiming?: 'immediate' | 'period_end'
  source?: 'browser' | 'server'
}

export async function recordBillingAnalyticsIntent(
  dashboardApi: ReturnType<typeof useDashboardApi>,
  input: BillingAnalyticsIntentInput,
): Promise<void> {
  await dashboardApi<{ success: true; intent_id: string }>('/api/billing/analytics-intent', {
    method: 'POST',
    body: {
      organizationId: input.organizationId,
      subscriptionId: input.subscriptionId ?? null,
      action: input.action,
      gaClientId: input.gaClientId ?? null,
      gaSessionId: input.gaSessionId ?? null,
      gaSessionCapturedAt: input.gaSessionCapturedAt ?? null,
      previousPriceId: input.previousPriceId ?? null,
      newPriceId: input.newPriceId ?? null,
      effectiveTiming: input.effectiveTiming ?? 'immediate',
      source: input.source ?? 'browser',
    },
    validate: (value): value is { success: true; intent_id: string } =>
      isRecord(value) && value.success === true && typeof value.intent_id === 'string',
  })
}
