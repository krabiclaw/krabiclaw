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
