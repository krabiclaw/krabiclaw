export const STRIPE_GA4_PURCHASE_TYPES = [
  'initial_subscription',
  'subscription_renewal',
  'upgrade',
  'downgrade',
  'plan_change',
  'resubscription',
] as const

export type StripeGa4PurchaseType = typeof STRIPE_GA4_PURCHASE_TYPES[number]
export type StripeGa4IntentAction = Exclude<StripeGa4PurchaseType, 'subscription_renewal' | 'plan_change' | 'resubscription'>

export interface StripeGa4MetadataContext {
  gaClientId?: string | null
  gaSessionId?: string | null
  gaSessionCapturedAt?: number | string | null
}

function boundedMetadataValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

export function buildStripeSubscriptionMetadata(
  action: StripeGa4IntentAction,
  context: StripeGa4MetadataContext,
  userId?: string | null,
  previousPriceId?: string | null,
  newPriceId?: string | null,
): Record<string, string> {
  const gaClientId = boundedMetadataValue(context.gaClientId, 255)
  const gaSessionId = boundedMetadataValue(context.gaSessionId, 64)
  const gaSessionCapturedAt = context.gaSessionCapturedAt == null
    ? null
    : boundedMetadataValue(String(context.gaSessionCapturedAt), 32)
  const metadata: Record<string, string> = { analytics_action: action }
  const optionalValues: Array<[string, unknown, number]> = [
    ['user_id', userId, 255],
    ['ga_client_id', gaClientId, 255],
    ['ga_session_id', gaSessionId, 64],
    ['ga_session_captured_at', gaSessionCapturedAt, 32],
    ['previous_price_id', previousPriceId, 255],
    ['new_price_id', newPriceId, 255],
  ]
  for (const [key, value, maxLength] of optionalValues) {
    const normalized = boundedMetadataValue(value, maxLength)
    if (normalized) metadata[key] = normalized
  }
  return metadata
}

// Retired contracts can still move to a current offer or cancel. Their rank
// remains part of those transitions even though they are no longer for sale.
const PLAN_RANK: Record<string, number> = { free: 0, growth: 1, commerce: 2, marketing: 3, business: 3 }

export function classifyStripePlanChange(
  currentPlan: string | null | undefined,
  nextPlan: string,
  hasSubscription: boolean,
): StripeGa4IntentAction | null {
  const normalizedNext = nextPlan.trim().toLowerCase()
  const normalizedCurrent = currentPlan?.trim().toLowerCase() || 'free'
  const nextRank = PLAN_RANK[normalizedNext]
  if (typeof nextRank !== 'number') return null
  if (!hasSubscription && normalizedCurrent === 'free') {
    return normalizedNext === 'free' ? null : 'initial_subscription'
  }
  if (normalizedCurrent === normalizedNext) return null

  const currentRank = PLAN_RANK[normalizedCurrent]
  if (typeof currentRank !== 'number') return null
  return nextRank >= currentRank ? 'upgrade' : 'downgrade'
}

export function isStripeGa4PurchaseType(value: unknown): value is StripeGa4PurchaseType {
  return typeof value === 'string'
    && (STRIPE_GA4_PURCHASE_TYPES as readonly string[]).includes(value)
}

export function isStripeGa4IntentAction(value: unknown): value is StripeGa4IntentAction {
  return value === 'initial_subscription' || value === 'upgrade' || value === 'downgrade'
}
