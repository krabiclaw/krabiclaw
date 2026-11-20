import type { CurrencyCode } from '~/shared/currencies'
import { paymentMoney } from '~/shared/payment-display'
import type { MemberAlertMessage, NotificationAction, NotificationFact, NotificationMessage, NotificationSection } from './messages'

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
  customerEmail?: string | null
  customerId?: string | null
  paymentId?: string | null
  receiptNumber?: string | null
  invoiceNumber?: string | null
  paymentMethod?: string | null
  paidAt?: string | null
  supportEmail?: string | null
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
  | {
      kind: 'payout_paid'
      arrivalDate?: string | null
      destinationBank?: string | null
      destinationLast4?: string | null
      payoutId?: string | null
    }
  | {
      kind: 'payout_failed'
      payoutId?: string | null
      failureMessage?: string | null
      failureCode?: string | null
      destinationBank?: string | null
      destinationLast4?: string | null
    }
)

function paymentMessage(event: PaymentNotificationEvent, audience: 'owner' | 'guest'): NotificationMessage {
  if (!Number.isSafeInteger(event.amount) || event.amount < 0) throw new Error('Payments notification requires a non-negative native minor-unit amount')
  const organizationName = event.organizationName === null ? null : event.organizationName.trim()
  if (organizationName === '') throw new Error('Payments notification requires its merchant name')
  if (audience === 'owner' && !organizationName) throw new Error('Merchant Payments notification requires its merchant name')
  const amount = `${paymentMoney(event.amount, event.currency)} ${event.currency}`
  const guest = audience === 'guest'
  let subject: string | undefined
  let title: string
  let preheader: string | undefined
  let intro: string | undefined
  let amountLabel: string
  const facts: NotificationFact[] = []
  const sections: NotificationSection[] = []

  switch (event.kind) {
    case 'payment_captured': {
      if (guest) {
        const orgSuffix = organizationName ? ` from ${organizationName}` : ''
        const receiptSuffix = event.receiptNumber?.trim() ? ` #${event.receiptNumber.trim()}` : ''
        subject = `Your receipt${orgSuffix}${receiptSuffix}`
        preheader = subject
        title = organizationName ? `Receipt from ${organizationName}` : 'Receipt'
        if (event.paidAt?.trim()) {
          intro = `Paid ${event.paidAt.trim()}`
        }
        amountLabel = 'Amount paid'
        if (event.receiptNumber?.trim()) {
          facts.push({ key: 'receiptNumber', label: 'Receipt number', value: event.receiptNumber.trim() })
        }
        if (event.invoiceNumber?.trim()) {
          facts.push({ key: 'invoiceNumber', label: 'Invoice number', value: event.invoiceNumber.trim() })
        }
        if (event.paymentMethod?.trim()) {
          facts.push({ key: 'paymentMethod', label: 'Payment method', value: event.paymentMethod.trim() })
        }
        sections.push({
          title: 'Questions?',
          body: event.supportEmail?.trim()
            ? `Visit our support site or contact us at ${event.supportEmail.trim()}.`
            : 'Visit our support website for answers to most questions and to get in touch with us.',
        })
      } else {
        const fromCustomer = event.customerEmail?.trim() ? ` from ${event.customerEmail.trim()}` : ''
        const forOrg = organizationName ? ` for ${organizationName}` : ''
        subject = `Payment of ${amount}${fromCustomer}${forOrg}`
        title = organizationName ? `Congratulations, ${organizationName}!` : 'Congratulations!'
        intro = "You've just received a payment through Stripe."
        amountLabel = 'Payment'
        if (event.productTitle?.trim()) {
          preheader = event.paymentId?.trim()
            ? `${event.productTitle.trim()} - ${event.paymentId.trim()}`
            : event.productTitle.trim()
        }
        if (event.customerEmail?.trim()) {
          const customerValue = event.customerId?.trim()
            ? `${event.customerEmail.trim()} — ${event.customerId.trim()}`
            : event.customerEmail.trim()
          facts.push({ key: 'customer', label: 'Customer', value: customerValue })
        }
        if (event.paymentId?.trim()) {
          facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
        }
        sections.push({
          title: 'We are here to help',
          body: 'Visit our support website for answers to most questions and to get in touch with us.',
        })
      }
      break
    }
    case 'payment_failed': {
      if (guest) {
        const orgSuffix = organizationName ? ` to ${organizationName}` : ''
        subject = `Your payment${orgSuffix} failed`
        title = 'Payment failed'
        intro = organizationName ? `Your payment to ${organizationName} could not be processed.` : 'Your payment could not be processed.'
        amountLabel = 'Payment amount'
        if (event.paymentMethod?.trim()) {
          facts.push({ key: 'paymentMethod', label: 'Payment method', value: event.paymentMethod.trim() })
        }
        if (event.paymentId?.trim()) {
          facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
        }
        sections.push({
          title: 'Next steps',
          body: 'Check with your bank or update your payment details to complete this payment.',
        })
        sections.push({
          title: 'Questions?',
          body: event.supportEmail?.trim()
            ? `Visit our support site or contact us at ${event.supportEmail.trim()}.`
            : 'Visit our support website for answers to most questions and to get in touch with us.',
        })
      } else {
        const fromCustomer = event.customerEmail?.trim() ? ` from ${event.customerEmail.trim()}` : ''
        const forOrg = organizationName ? ` for ${organizationName}` : ''
        subject = `Payment of ${amount}${fromCustomer}${forOrg} failed`
        title = 'Payment failed'
        intro = 'A customer payment failed to process through Stripe.'
        amountLabel = 'Payment amount'
        if (event.customerEmail?.trim()) {
          facts.push({ key: 'customer', label: 'Customer', value: event.customerEmail.trim() })
        }
        if (event.paymentId?.trim()) {
          facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
        }
      }
      break
    }
    case 'refund_pending': {
      if (guest) {
        const orgSuffix = organizationName ? ` from ${organizationName}` : ''
        const receiptSuffix = event.receiptNumber?.trim() ? ` #${event.receiptNumber.trim()}` : ''
        subject = `Your refund${orgSuffix}${receiptSuffix} is pending`
        preheader = subject
        title = organizationName ? `Refund from ${organizationName}` : 'Refund'
        intro = event.refundReason?.trim() ?? 'Your refund is currently being processed.'
        amountLabel = 'Refund amount'
        if (event.receiptNumber?.trim()) {
          facts.push({ key: 'receiptNumber', label: 'Receipt number', value: event.receiptNumber.trim() })
        }
        if (event.invoiceNumber?.trim()) {
          facts.push({ key: 'invoiceNumber', label: 'Invoice number', value: event.invoiceNumber.trim() })
        }
        if (event.paymentMethod?.trim()) {
          facts.push({ key: 'refundedTo', label: 'Refunded to', value: event.paymentMethod.trim() })
        }
        sections.push({
          title: 'Questions?',
          body: event.supportEmail?.trim()
            ? `Visit our support site or contact us at ${event.supportEmail.trim()}.`
            : 'Visit our support website for answers to most questions and to get in touch with us.',
        })
      } else {
        const forOrg = organizationName ? ` for ${organizationName}` : ''
        subject = `Refund of ${amount}${forOrg} is pending`
        title = 'Refund pending'
        intro = 'A refund is pending in Stripe.'
        amountLabel = 'Refund amount'
        if (event.customerEmail?.trim()) {
          facts.push({ key: 'customer', label: 'Customer', value: event.customerEmail.trim() })
        }
        if (event.paymentId?.trim()) {
          facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
        }
      }
      break
    }
    case 'refund_succeeded': {
      if (guest) {
        const orgSuffix = organizationName ? ` from ${organizationName}` : ''
        const receiptSuffix = event.receiptNumber?.trim() ? ` #${event.receiptNumber.trim()}` : ''
        subject = `Your refund${orgSuffix}${receiptSuffix}`
        preheader = subject
        title = organizationName ? `Refund from ${organizationName}` : 'Refund'
        intro = event.refundReason?.trim() ?? undefined
        amountLabel = 'Total refunded'
        if (event.receiptNumber?.trim()) {
          facts.push({ key: 'receiptNumber', label: 'Receipt number', value: event.receiptNumber.trim() })
        }
        if (event.invoiceNumber?.trim()) {
          facts.push({ key: 'invoiceNumber', label: 'Invoice number', value: event.invoiceNumber.trim() })
        }
        if (event.paymentMethod?.trim()) {
          facts.push({ key: 'refundedTo', label: 'Refunded to', value: event.paymentMethod.trim() })
        }
        sections.push({
          title: 'Questions?',
          body: event.supportEmail?.trim()
            ? `Visit our support site or contact us at ${event.supportEmail.trim()}.`
            : 'Visit our support website for answers to most questions and to get in touch with us.',
        })
      } else {
        const forOrg = organizationName ? ` for ${organizationName}` : ''
        subject = `Refund of ${amount}${forOrg} processed`
        title = 'Refund processed'
        intro = 'A refund was processed through Stripe.'
        amountLabel = 'Total refunded'
        if (event.customerEmail?.trim()) {
          facts.push({ key: 'customer', label: 'Customer', value: event.customerEmail.trim() })
        }
        if (event.paymentId?.trim()) {
          facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
        }
      }
      break
    }
    case 'refund_failed': {
      if (guest) {
        const orgSuffix = organizationName ? ` from ${organizationName}` : ''
        subject = `Your refund${orgSuffix} could not be processed`
        title = organizationName ? `Refund from ${organizationName} failed` : 'Refund failed'
        intro = event.refundReason?.trim() ?? (organizationName ? `Contact ${organizationName} about the refund.` : undefined)
        amountLabel = 'Refund amount'
        sections.push({
          title: 'Questions?',
          body: event.supportEmail?.trim()
            ? `Visit our support site or contact us at ${event.supportEmail.trim()}.`
            : 'Visit our support website for answers to most questions and to get in touch with us.',
        })
      } else {
        const forOrg = organizationName ? ` for ${organizationName}` : ''
        subject = `Refund of ${amount}${forOrg} failed`
        title = 'Refund failed'
        intro = 'Review the refund in Stripe.'
        amountLabel = 'Refund amount'
        if (event.paymentId?.trim()) {
          facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
        }
      }
      break
    }
    case 'refund_canceled': {
      if (guest) {
        const orgSuffix = organizationName ? ` from ${organizationName}` : ''
        subject = `Your refund${orgSuffix} was canceled`
        title = organizationName ? `Refund from ${organizationName} canceled` : 'Refund canceled'
        intro = event.refundReason?.trim() ?? 'The refund was canceled.'
        amountLabel = 'Refund amount'
      } else {
        const forOrg = organizationName ? ` for ${organizationName}` : ''
        subject = `Refund of ${amount}${forOrg} canceled`
        title = 'Refund canceled'
        amountLabel = 'Refund amount'
        if (event.paymentId?.trim()) {
          facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
        }
      }
      break
    }
    case 'dispute_needs_response': {
      const forOrg = organizationName ? ` for ${organizationName}` : ''
      subject = `Urgent: Dispute of ${amount}${forOrg} needs your response`
      title = 'A dispute needs your response'
      amountLabel = 'Disputed amount'
      intro = 'A customer has disputed a payment. Review the dispute details and submit evidence before the deadline to prevent a permanent loss of funds.'
      if (event.responseDueBy?.trim()) {
        facts.push({ key: 'responseDueBy', label: 'Respond by', value: event.responseDueBy.trim() })
      }
      if (event.customerEmail?.trim()) {
        facts.push({ key: 'customer', label: 'Customer', value: event.customerEmail.trim() })
      }
      if (event.paymentId?.trim()) {
        facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
      }
      sections.push({
        title: 'Evidence guidelines',
        body: 'Submit clear evidence showing the customer received what they paid for (signed retainer, consultation logs, client messages, or your fee agreement). Evidence submitted to the card issuer cannot be amended after submission.',
      })
      break
    }
    case 'dispute_won': {
      const forOrg = organizationName ? ` for ${organizationName}` : ''
      subject = `Dispute of ${amount}${forOrg} won`
      title = 'Dispute won'
      intro = 'The dispute was resolved in your favor. The disputed amount has been returned to your account balance.'
      amountLabel = 'Disputed amount'
      if (event.paymentId?.trim()) {
        facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
      }
      break
    }
    case 'dispute_lost': {
      const forOrg = organizationName ? ` for ${organizationName}` : ''
      subject = `Dispute of ${amount}${forOrg} lost`
      title = 'Dispute lost'
      intro = "The cardholder's bank resolved the dispute in the customer's favor. The disputed amount and dispute fee will not be returned."
      amountLabel = 'Disputed amount'
      if (event.paymentId?.trim()) {
        facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
      }
      break
    }
    case 'dispute_closed': {
      const forOrg = organizationName ? ` for ${organizationName}` : ''
      subject = `Dispute of ${amount}${forOrg} closed`
      title = 'Dispute closed'
      intro = 'The dispute on this payment has been closed.'
      amountLabel = 'Disputed amount'
      if (event.paymentId?.trim()) {
        facts.push({ key: 'paymentId', label: 'Payment ID', value: event.paymentId.trim() })
      }
      break
    }
    case 'payout_paid': {
      const orgSuffix = organizationName ? ` for ${organizationName}` : ''
      subject = `Your ${amount} payout${orgSuffix} is on the way`
      title = `${amount} is on the way`
      amountLabel = 'Amount'
      if (event.arrivalDate?.trim()) {
        const arrival = event.arrivalDate.trim()
        preheader = `It's expected to arrive on ${arrival}`
        facts.push({
          key: 'arrivalDate',
          label: 'Estimated arrival',
          value: arrival.toLowerCase().includes('by end of day') ? arrival : `${arrival}, by end of day`,
        })
      }
      if (event.destinationLast4?.trim()) {
        const bankName = event.destinationBank?.trim() || 'Bank account'
        facts.push({ key: 'destination', label: 'To', value: `${bankName} ••••${event.destinationLast4.trim()}` })
      }
      if (event.payoutId?.trim()) {
        facts.push({ key: 'payoutId', label: 'Payout ID', value: event.payoutId.trim() })
      }
      sections.push({
        title: "Don't see your payout on the arrival date?",
        body: [
          'Banks can take up to 5 business days after the expected post date to process payouts.',
          'Wait until 5 business days have passed and then contact your bank with the payout information, including the payout trace ID.',
          'If your bank still cannot find the payout, ask them for a written statement confirming that the funds have not been received. Then, contact Support with this statement from your bank.',
        ].join(' '),
      })
      break
    }
    case 'payout_failed': {
      const orgSuffix = organizationName ? ` for ${organizationName}` : ''
      subject = `Your ${amount} payout${orgSuffix} failed`
      title = `${amount} payout failed`
      amountLabel = 'Payout amount'
      intro = event.failureMessage?.trim()
        ? `Stripe reported: ${event.failureMessage.trim()}`
        : 'Review your payout details in Stripe.'
      if (event.destinationLast4?.trim()) {
        const bankName = event.destinationBank?.trim() || 'Bank account'
        facts.push({ key: 'destination', label: 'To', value: `${bankName} ••••${event.destinationLast4.trim()}` })
      }
      if (event.payoutId?.trim()) {
        facts.push({ key: 'payoutId', label: 'Payout ID', value: event.payoutId.trim() })
      }
      sections.push({
        title: 'Next steps',
        body: 'Check that your bank account details are up to date and that your bank accepts incoming transfers. You can update your payout method in your dashboard.',
      })
      break
    }
    default:
      throw new Error('Unsupported Payments notification event')
  }

  const ownerCaptured = !guest && event.kind === 'payment_captured'
  const amountValue = ownerCaptured && event.productTitle?.trim()
    ? `${amount} — ${event.productTitle.trim()}`
    : amount
  facts.unshift({ key: 'amount', label: amountLabel, value: amountValue, lead: true })
  if (!ownerCaptured && event.productTitle?.trim()) {
    facts.splice(1, 0, { key: 'productTitle', label: 'Item', value: event.productTitle.trim(), lead: true })
  }
  const activity = event.kind.startsWith('refund_') ? 'refund'
    : event.kind.startsWith('dispute_') ? 'dispute'
      : event.kind.startsWith('payout_') ? 'payout' : 'payment'
  return {
    subject,
    title,
    preheader: preheader ?? (organizationName ? `${amount} · ${organizationName}` : amount),
    hero: null,
    intro,
    facts,
    sections: sections.length ? sections : undefined,
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

/** The merchant's alert opens the booking, transaction or payout it is about. */
export function ownerPaymentMessage(event: PaymentNotificationEvent & { action: NotificationAction }): MemberAlertMessage {
  return { ...paymentMessage(event, 'owner'), primaryAction: event.action }
}

export function guestPaymentMessage(event: GuestPaymentNotificationEvent): NotificationMessage {
  return paymentMessage(event, 'guest')
}

/**
 * The business's own Blawby plan: a new plan, a change of plan, or a plan
 * set not to renew. Stripe emails the receipts, renewal and trial reminders and
 * failed payments itself (https://docs.stripe.com/billing/revenue-recovery/customer-emails).
 */
export function subscriptionPlanMessage(input: {
  kind: 'started' | 'changed' | 'ending'
  organizationName: string
  plan: string
  /** The plan the business moved from, for a change. */
  previousPlan?: string
  /** The day a new plan's free trial ends, or the day a plan that will not renew ends. */
  date?: string | null
  action: NotificationAction
}): MemberAlertMessage {
  const facts: NotificationFact[] = [{ key: 'plan', label: 'Plan', value: input.plan, lead: true }]
  let title: string
  let intro: string
  if (input.kind === 'started') {
    title = `Your new plan: ${input.plan}`
    intro = `${input.organizationName} is on ${input.plan}.`
    if (input.date) facts.push({ key: 'trialEnds', label: 'Free trial ends', value: input.date })
  } else if (input.kind === 'changed') {
    if (!input.previousPlan) throw new Error('A plan change names the plan it replaced')
    title = `Your plan changed to ${input.plan}`
    intro = `${input.organizationName} moved from ${input.previousPlan} to ${input.plan}.`
    facts.push({ key: 'previousPlan', label: 'Previous plan', value: input.previousPlan })
  } else {
    if (!input.date) throw new Error('A plan that will not renew names the day it ends')
    title = `Your ${input.plan} plan will not renew`
    intro = `${input.plan} stays on until ${input.date}. After that, ${input.organizationName} is on Basic.`
    facts.push({ key: 'endsOn', label: 'Ends on', value: input.date, lead: true })
  }
  return {
    title,
    preheader: `${input.plan} · ${input.organizationName}`,
    hero: null,
    intro,
    facts,
    primaryAction: input.action,
    category: 'organization_and_billing',
    emailPurpose: 'transactional',
    emailReason: `You received this email because you receive billing notifications for ${input.organizationName}.`,
    organizationName: input.organizationName,
  }
}
