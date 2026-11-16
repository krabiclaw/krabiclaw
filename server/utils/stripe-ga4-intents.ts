import { execute, queryFirst, type DbClient } from '~/server/db'
import type { StripeGa4IntentAction } from '~/shared/stripe-ga4'
import type { AttributionTouch } from '~/utils/analytics-attribution'

/** The visitor's native attribution when checkout began. */
export interface CheckoutAttribution { touch: AttributionTouch; attributedAt: string }

export interface StripeGa4Intent {
  id: string
  organizationId: string
  userId: string
  stripeSubscriptionId: string | null
  action: StripeGa4IntentAction
  clientId: string | null
  sessionId: string | null
  sessionCapturedAt: number | null
  previousPriceId: string | null
  newPriceId: string | null
  effectiveTiming: 'immediate' | 'period_end'
  source: string
  status: 'pending' | 'consumed' | 'expired'
  lifecycleSentAt: string | null
  consumedAt: string | null
  consumedEventId: string | null
  expiresAt: string
  createdAt: string
}

export interface CreateStripeGa4IntentInput {
  organizationId: string
  userId: string
  stripeSubscriptionId?: string | null
  action: StripeGa4IntentAction
  clientId?: string | null
  sessionId?: string | null
  sessionCapturedAt?: number | null
  attribution?: CheckoutAttribution | null
  previousPriceId?: string | null
  newPriceId?: string | null
  effectiveTiming?: 'immediate' | 'period_end'
  source?: string
}

function isoAfterHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

function normalizeOptional(value: string | null | undefined, maxLength = 255): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null
}

export async function recordStripeGa4Intent(
  db: DbClient,
  input: CreateStripeGa4IntentInput,
): Promise<StripeGa4Intent> {
  const now = new Date().toISOString()
  const id = `stripe-ga4-intent-${crypto.randomUUID()}`
  const clientId = normalizeOptional(input.clientId)
  const sessionId = normalizeOptional(input.sessionId, 64)
  const sessionCapturedAt = typeof input.sessionCapturedAt === 'number'
    && Number.isSafeInteger(input.sessionCapturedAt)
    && input.sessionCapturedAt > 0
    ? input.sessionCapturedAt
    : null
  const effectiveTiming: 'immediate' | 'period_end' = input.effectiveTiming === 'period_end' ? 'period_end' : 'immediate'
  const row = {
    id,
    organizationId: input.organizationId,
    userId: input.userId,
    stripeSubscriptionId: normalizeOptional(input.stripeSubscriptionId),
    action: input.action,
    
    clientId,
    sessionId,
    sessionCapturedAt,
    attribution: input.attribution ?? null,
    previousPriceId: normalizeOptional(input.previousPriceId),
    newPriceId: normalizeOptional(input.newPriceId),
    effectiveTiming,
    source: normalizeOptional(input.source, 64) ?? 'browser',
    status: 'pending' as const,
    lifecycleSentAt: null,
    consumedAt: null,
    consumedEventId: null,
    expiresAt: isoAfterHours(24 * 7),
    createdAt: now,
  }

  await execute(db, `
    INSERT INTO stripe_ga4_subscription_intents
      (id, organization_id, user_id, stripe_subscription_id, action,
       client_id, session_id, session_captured_at, attribution_json, previous_price_id, new_price_id,
       effective_timing, source, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    row.id,
    row.organizationId,
    row.userId,
    row.stripeSubscriptionId,
    row.action,
    row.clientId,
    row.sessionId,
    row.sessionCapturedAt,
    row.attribution ? JSON.stringify({ touch: row.attribution.touch, attributedAt: row.attribution.attributedAt }) : null,
    row.previousPriceId,
    row.newPriceId,
    row.effectiveTiming,
    row.source,
    row.status,
    row.expiresAt,
    row.createdAt,
    row.createdAt,
  ])

  return row
}

function mapIntent(row: StripeGa4IntentRow | null): StripeGa4Intent | null {
  if (!row) return null
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    action: row.action,
    
    clientId: row.clientId,
    sessionId: row.sessionId,
    sessionCapturedAt: row.sessionCapturedAt,
    previousPriceId: row.previousPriceId,
    newPriceId: row.newPriceId,
    effectiveTiming: row.effectiveTiming,
    source: row.source,
    status: row.status,
    lifecycleSentAt: row.lifecycleSentAt,
    consumedAt: row.consumedAt,
    consumedEventId: row.consumedEventId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}

type StripeGa4IntentRow = StripeGa4Intent

const INTENT_SELECT = `
  SELECT id,
         organization_id AS organizationId,
         user_id AS userId,
         stripe_subscription_id AS stripeSubscriptionId,
         action,
         client_id AS clientId,
         session_id AS sessionId,
         session_captured_at AS sessionCapturedAt,
         previous_price_id AS previousPriceId,
         new_price_id AS newPriceId,
         effective_timing AS effectiveTiming,
         source,
         status,
         lifecycle_sent_at AS lifecycleSentAt,
         consumed_at AS consumedAt,
         consumed_event_id AS consumedEventId,
         expires_at AS expiresAt,
         created_at AS createdAt
    FROM stripe_ga4_subscription_intents
`

export async function findPendingStripeGa4Intent(
  db: DbClient,
  stripeSubscriptionId: string,
  now = new Date().toISOString(),
): Promise<StripeGa4Intent | null> {
  return mapIntent(await queryFirst<StripeGa4IntentRow>(db, `${INTENT_SELECT}
    WHERE stripe_subscription_id = ? AND status = 'pending' AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1
  `, [stripeSubscriptionId, now]))
}

export async function findConsumedStripeGa4CancellationIntent(
  db: DbClient,
  stripeSubscriptionId: string,
): Promise<StripeGa4Intent | null> {
  return mapIntent(await queryFirst<StripeGa4IntentRow>(db, `${INTENT_SELECT}
    WHERE stripe_subscription_id = ?
      AND action = 'downgrade'
      AND new_price_id IS NULL
      AND effective_timing = 'period_end'
      AND status = 'consumed'
      AND lifecycle_sent_at IS NOT NULL
    ORDER BY consumed_at DESC, created_at DESC LIMIT 1
  `, [stripeSubscriptionId]))
}

export async function findPendingInitialStripeGa4Intent(
  db: DbClient,
  organizationId: string,
  userId?: string | null,
  now = new Date().toISOString(),
): Promise<StripeGa4Intent | null> {
  const userClause = userId ? 'AND user_id = ?' : ''
  const params = userId ? [organizationId, now, userId] : [organizationId, now]
  return mapIntent(await queryFirst<StripeGa4IntentRow>(db, `${INTENT_SELECT}
    WHERE organization_id = ? AND action = 'initial_subscription'
      AND stripe_subscription_id IS NULL AND status = 'pending' AND expires_at > ?
      ${userClause}
    ORDER BY created_at DESC LIMIT 1
  `, params))
}

export async function attachStripeGa4IntentToSubscription(
  db: DbClient,
  intentId: string,
  stripeSubscriptionId: string,
): Promise<void> {
  await execute(db, `
    UPDATE stripe_ga4_subscription_intents
       SET stripe_subscription_id = ?, updated_at = ?
     WHERE id = ? AND status = 'pending' AND stripe_subscription_id IS NULL
  `, [stripeSubscriptionId, new Date().toISOString(), intentId])
}

export async function markStripeGa4IntentLifecycleSent(db: DbClient, intentId: string): Promise<void> {
  const now = new Date().toISOString()
  await execute(db, `
    UPDATE stripe_ga4_subscription_intents
       SET lifecycle_sent_at = COALESCE(lifecycle_sent_at, ?), updated_at = ?
     WHERE id = ? AND status = 'pending'
  `, [now, now, intentId])
}

export async function consumeStripeGa4Intent(
  db: DbClient,
  intentId: string,
  eventId: string,
): Promise<void> {
  const now = new Date().toISOString()
  await execute(db, `
    UPDATE stripe_ga4_subscription_intents
       SET status = 'consumed', consumed_at = ?, consumed_event_id = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'
  `, [now, eventId, now, intentId])
}
export const STRIPE_GA4_CONSUMED_RETENTION_DAYS = 90

export async function expireStripeGa4Intents(
  db: DbClient,
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString()
  await execute(db, `
    UPDATE stripe_ga4_subscription_intents
       SET status = 'expired', updated_at = ?
     WHERE status = 'pending' AND expires_at <= ?
  `, [nowIso, nowIso])
  const retentionCutoff = new Date(now.getTime() - STRIPE_GA4_CONSUMED_RETENTION_DAYS * 86_400_000).toISOString()
  await execute(db, `
    DELETE FROM stripe_ga4_subscription_intents
     WHERE status = 'consumed' AND consumed_at IS NOT NULL AND consumed_at <= ?
  `, [retentionCutoff])
}

/**
 * The attribution the checkout observed, found through the exact subscription and the kind of
 * checkout that produced the payment, whatever the intent's status or expiry: a first payment after
 * a trial or delayed collection arrives long after the seven-day pending window.
 */
export async function findStripeGa4CheckoutAttribution(
  db: DbClient,
  stripeSubscriptionId: string,
  purchaseType: string,
): Promise<CheckoutAttribution | null> {
  const action = purchaseType === 'initial_subscription' || purchaseType === 'resubscription' ? 'initial_subscription'
    : purchaseType === 'upgrade' || purchaseType === 'downgrade' ? purchaseType
      : null
  if (!action) return null
  const row = await queryFirst<{ attribution: string | null }>(db, `SELECT attribution_json AS attribution FROM stripe_ga4_subscription_intents
    WHERE stripe_subscription_id = ? AND action = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [stripeSubscriptionId, action])
  return row?.attribution != null ? JSON.parse(row.attribution) as CheckoutAttribution : null
}
