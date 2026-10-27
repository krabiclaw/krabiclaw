import type { CurrencyCode } from '~/shared/currencies'
import { paymentMoney } from '~/shared/payment-display'
import type { NotificationAction, NotificationFact, NotificationMessage } from './messages'

export interface PaymentNotificationInput {
  organizationName: string | null
  organizationLogoUrl?: string | null
  /** The native amount in the currency's smallest unit. */
  amount: number
  currency: CurrencyCode
  productTitle?: string | null
  /** The caller supplies the actual receipt, purchase or provider action. */
  action?: NotificationAction | null
  /** Why a refund happened when the guest did not ask for it. */
  refundReason?: string | null
}

export type GuestPaymentNotificationKind =
  | 'payment_captured'
  | 'payment_failed'
  | 'refund_pending'
  | 'refund_succeeded'
  | 'refund_failed'
  | 'refund_canceled'

export type GuestPaymentNotificationEvent = PaymentNotificationInput & { kind: GuestPaymentNotificationKind }

export type PaymentNotificationEvent = PaymentNotificationInput & (
  | { kind: GuestPaymentNotificationKind }
  | { kind: 'dispute_needs_response'; responseDueBy?: string | null }
  | { kind: 'dispute_won' | 'dispute_lost' | 'dispute_closed' }
  | { kind: 'payout_paid'; arrivalDate?: string | null }
  | { kind: 'payout_failed' }
)

function paymentMessage(event: PaymentNotificationEvent, audience: 'owner' | 'guest'): NotificationMessage {
  if (!Number.isSafeInteger(event.amount) || event.amount < 0) throw new Error('Payments notification requires a non-negative native minor-unit amount')
  const organizationName = event.organizationName === null ? null : event.organizationName.trim()
  if (organizationName === '') throw new Error('Payments notification requires its merchant name')
  if (audience === 'owner' && !organizationName) throw new Error('Merchant Payments notification requires its merchant name')
  const amount = `${paymentMoney(event.amount, event.currency)} ${event.currency}`
  const guest = audience === 'guest'
  let title: string
  let intro: string | undefined
  let amountLabel: string
  const facts: NotificationFact[] = []

  switch (event.kind) {
    case 'payment_captured':
      title = guest ? 'Your payment was received' : 'Payment received'
      amountLabel = 'Amount paid'
      break
    case 'payment_failed':
      title = guest ? 'Your payment failed' : 'Payment failed'
      amountLabel = 'Payment amount'
      intro = guest ? (organizationName ? `Review your payment with ${organizationName}.` : undefined) : 'Review the payment in Stripe.'
      break
    case 'refund_pending':
      title = guest ? 'Your refund is pending' : 'Refund pending'
      amountLabel = 'Refund amount'
      intro = guest ? event.refundReason ?? undefined : undefined
      break
    case 'refund_succeeded':
      title = guest ? 'Your refund was processed' : 'Refund processed'
      amountLabel = 'Refund amount'
      intro = guest ? event.refundReason ?? undefined : undefined
      break
    case 'refund_failed':
      title = guest ? 'Your refund failed' : 'Refund failed'
      amountLabel = 'Refund amount'
      intro = guest ? (organizationName ? `Contact ${organizationName} about the refund.` : undefined) : 'Review the refund in Stripe.'
      break
    case 'refund_canceled':
      title = guest ? 'Your refund was canceled' : 'Refund canceled'
      amountLabel = 'Refund amount'
      break
    case 'dispute_needs_response':
      title = 'A dispute needs your response'
      amountLabel = 'Disputed amount'
      intro = 'Review the dispute and submit evidence in Stripe.'
      if (event.responseDueBy?.trim()) facts.push({ key: 'responseDueBy', label: 'Respond by', value: event.responseDueBy.trim() })
      break
    case 'dispute_won':
      title = 'Dispute won'
      amountLabel = 'Disputed amount'
      break
    case 'dispute_lost':
      title = 'Dispute lost'
      amountLabel = 'Disputed amount'
      break
    case 'dispute_closed':
      title = 'Dispute closed'
      amountLabel = 'Disputed amount'
      break
    case 'payout_paid':
      title = 'Payout paid'
      amountLabel = 'Payout amount'
      if (event.arrivalDate?.trim()) facts.push({ key: 'arrivalDate', label: 'Arrival date', value: event.arrivalDate.trim() })
      break
    case 'payout_failed':
      title = 'Payout failed'
      amountLabel = 'Payout amount'
      intro = 'Review your payout details in Stripe.'
      break
    default:
      throw new Error('Unsupported Payments notification event')
  }

  facts.unshift({ key: 'amount', label: amountLabel, value: amount, lead: true })
  if (event.productTitle?.trim()) facts.splice(1, 0, { key: 'productTitle', label: 'Item', value: event.productTitle.trim(), lead: true })
  const activity = event.kind.startsWith('refund_') ? 'refund'
    : event.kind.startsWith('dispute_') ? 'dispute'
      : event.kind.startsWith('payout_') ? 'payout' : 'payment'
  return {
    title,
    preheader: organizationName ? `${amount} · ${organizationName}` : amount,
    hero: null,
    intro,
    facts,
    primaryAction: event.action ?? undefined,
    category: 'organization_and_billing',
    emailPurpose: 'transactional',
    emailReason: guest
      ? `You received this email because it updates your ${activity}${organizationName ? ` with ${organizationName}` : ''}.`
      : `You received this email because you receive ${activity} notifications for ${organizationName}.`,
    organizationName,
    organizationLogoUrl: event.organizationLogoUrl,
  }
}

export function ownerPaymentMessage(event: PaymentNotificationEvent): NotificationMessage {
  return paymentMessage(event, 'owner')
}

export function guestPaymentMessage(event: GuestPaymentNotificationEvent): NotificationMessage {
  return paymentMessage(event, 'guest')
}
