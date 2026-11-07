import type Stripe from 'stripe'
import type { DbClient } from '~/server/db'
import { notifyStripeAccountAttention } from '~/server/domain/payments/notifications'
import type { CloudflareEnv } from '~/server/utils/auth'
import { getStripeConnectedAccountByStripeId, refreshStripeConnectedAccount } from '~/server/utils/stripe-connect'
import { processStripeWebhookEvent } from '~/server/utils/stripe-webhook-events'

const CONNECT_ACCOUNT_EVENT_TYPES = new Set([
  'v2.core.account.updated',
  'v2.core.account[configuration.merchant].capability_status_updated',
  'v2.core.account[configuration.merchant].updated',
  'v2.core.account[identity].updated',
  'v2.core.account[requirements].updated',
  'v2.core.account_link.returned',
])

async function connectedAccountId(notification: Stripe.V2.Core.EventNotification): Promise<string | null> {
  if (notification.type === 'v2.core.account_link.returned') {
    return (await notification.fetchEvent()).data.account_id
  }
  if (!CONNECT_ACCOUNT_EVENT_TYPES.has(notification.type)) return null
  return 'related_object' in notification && notification.related_object
    ? notification.related_object.id
    : null
}

export async function processStripeConnectEvent(
  db: DbClient,
  stripe: Stripe,
  env: CloudflareEnv,
  notification: Stripe.V2.Core.EventNotification,
  payload: string,
): Promise<boolean> {
  return await processStripeWebhookEvent(db, {
    id: notification.id,
    type: notification.type,
    payload,
    processor: 'connect_marketplace',
  }, async () => {
    const stripeAccountId = await connectedAccountId(notification)
    if (!stripeAccountId) {
      console.info('stripe_connect_event_ignored', { stripeEventId: notification.id, eventType: notification.type })
      return
    }
    const connected = await getStripeConnectedAccountByStripeId(db, stripeAccountId)
    if (!connected) {
      console.info('stripe_connect_event_account_not_managed', { stripeEventId: notification.id, stripeAccountId })
      return
    }
    const account = await refreshStripeConnectedAccount(db, stripe, connected, notification.context)
    await notifyStripeAccountAttention(db, env, notification, account)
  })
}
