import { execute, queryFirst, type DbClient } from '~/server/db'

export type StripeWebhookProcessor = 'connect_marketplace' | 'tenant_payments'

export interface StripeWebhookEventInput {
  id: string
  type: string
  payload: string
  processor: StripeWebhookProcessor
}

/**
 * Process a Stripe event unless its processor already has. Each event keeps
 * its id across deliveries, and Stripe retries a delivery that failed, so a
 * failure is recorded with its error and thrown; the redelivery runs it again.
 * https://docs.stripe.com/webhooks#automatic-retries
 */
export async function processStripeWebhookEvent(
  db: DbClient,
  event: StripeWebhookEventInput,
  work: () => Promise<void>,
): Promise<void> {
  await execute(db, `
    INSERT OR IGNORE INTO stripe_webhook_events (id, stripe_event_id, event_type, processor, status, payload, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `, [crypto.randomUUID(), event.id, event.type, event.processor, event.payload, new Date().toISOString()])
  const receipt = await queryFirst<{ status: string }>(db, `
    SELECT status FROM stripe_webhook_events WHERE stripe_event_id = ? AND processor = ?
  `, [event.id, event.processor])
  if (!receipt) throw new Error(`Stripe event ${event.id} is recorded for another processor than ${event.processor}`)
  if (receipt.status === 'processed') return
  try {
    await work()
  } catch (error) {
    await execute(db, `
      UPDATE stripe_webhook_events SET status = 'failed', error = ?
      WHERE stripe_event_id = ? AND processor = ? AND status <> 'processed'
    `, [error instanceof Error ? error.message : String(error), event.id, event.processor])
    throw error
  }
  await execute(db, `
    UPDATE stripe_webhook_events SET status = 'processed', error = NULL, payload = NULL
    WHERE stripe_event_id = ? AND processor = ?
  `, [event.id, event.processor])
}
