import type Stripe from 'stripe'
import { queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { isCurrencyCode } from '~/shared/currencies'
import { ownerPaymentMessage, guestPaymentMessage, type GuestPaymentNotificationKind, type PaymentNotificationEvent } from '~/server/notifications/payment-events'
import { notifyFinancialNotification } from '~/server/utils/notifications'
import { appendEntry } from '~/server/domain/guest-threads/entries'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { dashboardOrigin } from '~/server/utils/dashboard-notification-links'
import type { Payment } from './index'
import { buyerPaymentActivityPath } from './buyer'

export async function notifyPaymentFinancialEvent(db: DbClient, stripe: Stripe, env: CloudflareEnv, payment: Payment, input: {
  kind: GuestPaymentNotificationKind | 'dispute_needs_response' | 'dispute_won' | 'dispute_lost' | 'dispute_closed'
  nativeId: string
  status: string
  amount: number
  /** The buyer's email as Stripe has it; read from the charge when the caller has not. */
  email?: string | null
  responseDueBy?: string | null
}) {
  const organization = await queryFirst<{ name: string; slug: string }>(db, 'SELECT name,slug FROM organization WHERE id=?', [payment.organization_id])
  if (!organization && !await queryFirst(db, 'SELECT organization_id FROM payment_servicing_tenants WHERE organization_id=? AND stripe_account_id=? AND livemode=?', [payment.organization_id, payment.stripe_account_id, payment.livemode])) throw new Error('Payments notification has no tenant or retained servicing identity')
  // A booking, reservation or stay paid on the site is confirmed to its guest by
  // the confirmation email, which states what they paid. A failure is told here:
  // a bank or pay-later method can fail after the guest has left the pay page.
  const checkout = payment.subject_type === 'booking' || payment.subject_type === 'reservation' || payment.subject_type === 'stay'
  const guestKind = (input.kind.startsWith('refund_') || input.kind === 'payment_failed' || (!checkout && input.kind.startsWith('payment_'))) ? input.kind as GuestPaymentNotificationKind : null
  // A deleted merchant and an unclaimed contact have no application audience.
  // The verified return can still claim the purchase and then notify its buyer.
  if (!organization && (!payment.buyer_user_id || !guestKind)) return
  const snapshot = JSON.parse(payment.price_snapshot_json) as { title?: unknown; stay?: { guest?: { email?: unknown } } }
  if (typeof snapshot.title !== 'string' || !snapshot.title.trim() || !isCurrencyCode(payment.currency)) throw new Error('Payments notification requires its immutable item and currency')
  let email: string | null = null
  if (guestKind && checkout) {
    // The address the guest booked with, which their confirmation went to.
    const booked = payment.subject_type === 'stay'
      ? snapshot.stay?.guest?.email
      : (await queryFirst<{ email: string | null }>(db, `SELECT json_extract(r.payload_json, '$.guest.email') AS email FROM payment_checkout_holds h JOIN requests r ON r.id = h.request_id AND r.organization_id = h.organization_id WHERE h.payment_id = ? AND h.organization_id = ?`, [payment.id, payment.organization_id]))?.email
    if (typeof booked !== 'string' || !booked) throw new Error('Paid checkout has no guest email to notify')
    email = booked
  } else if (guestKind) {
    // The address the buyer gave Stripe with the card, from the charge the intent made.
    if (input.email !== undefined) email = input.email
    else if (payment.stripe_charge_id) {
      const charge = await stripe.charges.retrieve(payment.stripe_charge_id, {}, { stripeAccount: payment.stripe_account_id })
      if (charge.livemode !== Boolean(payment.livemode) || charge.currency.toUpperCase() !== payment.currency || (payment.stripe_payment_intent_id && charge.payment_intent !== payment.stripe_payment_intent_id)) throw new Error('Stripe charge does not match the payment')
      email = charge.billing_details.email ?? null
    }
  }
  const eventKey = `payments:${payment.stripe_account_id}:${payment.livemode}:${input.nativeId}:${input.status}:${input.kind}`
  const visitKind = payment.subject_type === 'booking' || payment.subject_type === 'reservation' ? payment.subject_type : null
  const hold = visitKind && organization ? await queryFirst<{ request_id: string | null }>(db, 'SELECT request_id FROM payment_checkout_holds WHERE payment_id=? AND organization_id=?', [payment.id, payment.organization_id]) : null
  if (visitKind && organization && !hold?.request_id) throw new Error('Booking payment notification has no canonical guest request')
  // A stay's conversation opens when its payment is captured; it is the stay's, not the hold's.
  const stayThread = payment.subject_type === 'stay' && payment.subject_id && organization ? await queryFirst<{ request_id: string | null }>(db, 'SELECT request_id FROM stays WHERE organization_id=? AND id=?', [payment.organization_id, payment.subject_id]) : null
  const threadId = hold?.request_id ?? stayThread?.request_id ?? null
  const booking=visitKind&&payment.subject_id&&organization?await queryFirst<{request_id:string|null}>(db,`SELECT request_id FROM ${visitKind==='booking'?'bookings':'reservations'} WHERE organization_id=? AND id=?`,[payment.organization_id,payment.subject_id]):null
  if(booking&&booking.request_id!==threadId)throw new Error('Booking payment notification request does not match its operational booking')
  const deepLink = organization ? `${dashboardOrigin(env, { orgSlug: organization.slug, locationSlug: null })}${booking?.request_id?`/bookings/${visitKind}/${encodeURIComponent(booking.request_id)}`:stayThread?`/bookings/stay/${encodeURIComponent(payment.subject_id!)}`:`/earnings/transactions/${encodeURIComponent(payment.id)}`}` : null
  const details = {
    organizationName: organization?.name ?? null, amount: input.amount, currency: payment.currency, productTitle: snapshot.title, action: deepLink ? { url: deepLink, label: 'View details' } : null,
    // A checkout whose booking was taken before the payment completed is refunded without being asked.
    refundReason: payment.state !== 'recovery' ? null
      : input.kind === 'refund_pending' ? 'What you paid for was taken before your payment completed, so your booking could not be made and your payment will be refunded in full.'
        : input.kind === 'refund_succeeded' ? 'What you paid for was taken before your payment completed, so your booking could not be made and your payment has been refunded in full.' : null,
  }
  const event: PaymentNotificationEvent = input.kind === 'dispute_needs_response' ? { ...details, kind: input.kind, responseDueBy: input.responseDueBy } : { ...details, kind: input.kind }
  const ownerMessage = organization ? ownerPaymentMessage(event) : undefined
  let sourceEntryId: string | null = null
  if (threadId && ownerMessage) {
    const entry = await appendEntry(db, {
      threadId, kind: 'operation', actorKind: 'system', channel: 'system',
      eventName: `payment.${input.kind}`,
      body: [ownerMessage.title, ...ownerMessage.facts.filter(fact => fact.key === 'amount' || fact.key === 'productTitle').map(fact => `${fact.label}: ${fact.value}`)].join('\n'),
      payloadJson: { payment_id: payment.id, native_object_id: input.nativeId, status: input.status, amount: input.amount, currency: payment.currency },
      dedupeKey: `financial-operation:${eventKey}`,
    })
    sourceEntryId = entry.id
    await publishGuestInboxThreadEvent(env, db, { threadId, type: 'thread.changed' })
  }
  // An account opens its own activity; a guest who never made one reads Stripe's receipt.
  const buyer = guestKind ? payment.buyer_user_id : null
  const account = buyer ? await queryFirst<{ isAnonymous: number }>(db, 'SELECT isAnonymous FROM user WHERE id=?', [buyer]) : null
  const guestAction = buyer && account && !account.isAnonymous
    ? {url:new URL(await buyerPaymentActivityPath(db,buyer,payment.id),env.NUXT_PUBLIC_PLATFORM_DOMAIN).toString(),label:'View details'}
    : payment.receipt_url?{url:payment.receipt_url,label:'View receipt'}:null
  await notifyFinancialNotification(env, db, {
    organizationId: organization ? payment.organization_id : null,
    eventKey, ownerMessage, sourceEntryId, threadId, deepLink,
    guest: guestKind ? { userId: payment.buyer_user_id, email, message: guestPaymentMessage({ ...details, kind: guestKind, action: guestAction }) } : undefined,
  })
}

type PayoutScope = { organizationId: string; stripeAccountId: string; livemode: boolean }

export async function reconcilePayoutEvent(db: DbClient, stripe: Stripe, env: CloudflareEnv, scope: PayoutScope, event: Stripe.Event) {
  if ((event.type !== 'payout.paid' && event.type !== 'payout.failed') || event.livemode !== scope.livemode || (event.account && event.account !== scope.stripeAccountId)) throw new Error('Payout event native scope mismatch')
  const object = event.data.object as Stripe.Payout
  if (object.object !== 'payout' || !object.id) throw new Error('Payout event has no native payout identity')
  const payout = await stripe.payouts.retrieve(object.id, {}, { stripeAccount: scope.stripeAccountId })
  if (payout.id !== object.id) throw new Error('Payout native identity mismatch')
  await notifyPayoutState(db, env, scope, payout)
}

export async function notifyPayoutState(db: DbClient, env: CloudflareEnv, scope: PayoutScope, payout: Stripe.Payout) {
  if (payout.livemode !== scope.livemode) throw new Error('Payout notification native mode mismatch')
  if (payout.status !== 'paid' && payout.status !== 'failed') return
  const organization = await queryFirst<{ name: string; slug: string }>(db, 'SELECT name,slug FROM organization WHERE id=?', [scope.organizationId])
  if (!organization) {
    if (!await queryFirst(db, 'SELECT organization_id FROM payment_servicing_tenants WHERE organization_id=? AND stripe_account_id=? AND livemode=?', [scope.organizationId, scope.stripeAccountId, Number(scope.livemode)])) throw new Error('Payout notification has no tenant or retained servicing identity')
    return
  }
  const currency = payout.currency.toUpperCase()
  if (!isCurrencyCode(currency)) throw new Error('Payout currency is unsupported')
  const deepLink = `${dashboardOrigin(env, { orgSlug: organization.slug, locationSlug: null })}/earnings/payouts`
  const details = { organizationName: organization.name, amount: payout.amount, currency, action: { url: deepLink, label: 'View payout' } }
  const event: PaymentNotificationEvent = payout.status === 'paid'
    ? { ...details, kind: 'payout_paid', arrivalDate: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(payout.arrival_date * 1000)) }
    : { ...details, kind: 'payout_failed' }
  await notifyFinancialNotification(env, db, {
    organizationId: scope.organizationId,
    eventKey: `payments:${scope.stripeAccountId}:${Number(scope.livemode)}:${payout.id}:${payout.status}`,
    ownerMessage: ownerPaymentMessage(event),
    deepLink,
  })
}
