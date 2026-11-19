import type Stripe from 'stripe'

const KEYS = {
  payment: { current: 'blawby_payment_id', legacy: 'krabiclaw_payment_id' },
  refund: { current: 'blawby_refund_id', legacy: 'krabiclaw_refund_id' },
} as const

export function stripeMetadataId(kind: keyof typeof KEYS, metadata: Record<string, string> | null | undefined): string | undefined {
  const keys = KEYS[kind]
  const current = metadata?.[keys.current]
  const legacy = metadata?.[keys.legacy]
  if (current && legacy && current !== legacy) throw new Error(`Stripe ${kind} metadata has conflicting IDs`)
  return current || legacy || undefined
}

/** Stripe rejects a different payload for an existing key before executing it.
 * Replay the historical payload only when Stripe rejected that parameter change.
 * The caller supplies the same account and idempotency key to either request.
 */
export async function createWithStripeMetadata<T>(
  stripe: Stripe,
  kind: keyof typeof KEYS,
  id: string,
  mayReplayLegacy: boolean,
  create: (metadata: Record<string, string>) => Promise<T>,
): Promise<T> {
  const keys = KEYS[kind]
  try {
    return await create({ [keys.current]: id })
  } catch (error) {
    if (!mayReplayLegacy || !(error instanceof stripe.errors.StripeIdempotencyError) || error.statusCode !== 400 || error.code) throw error
    return await create({ [keys.legacy]: id })
  }
}
