import { HTTPError } from 'nitro'
import type Stripe from 'stripe'
import type { DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { getOrganizationBillingStatus, getStripe } from '~/server/utils/billing'
import { createStripePlanLoader } from '~/server/utils/better-auth-stripe'
import { isCurrentBusinessPrice, planSubscriptionItems, recurringPriceAmount } from '~/server/utils/stripe-catalog'
import { BUSINESS_PLAN_ID, INCLUDED_LOCATIONS, INCLUDED_RENTAL_UNITS } from '~/shared/billing-model'

/**
 * Moving an existing subscription to Business, or changing what a Business
 * subscription covers. The current offer bills two things — locations on the
 * plan item and rental units on the Additional rental unit item — and Stripe's
 * portal confirms changes only to a single-item subscription, so the business
 * reads Stripe's own invoice preview here and confirms it, and the change is
 * one subscription update with the same proration date, read back from Stripe.
 * Better Auth keeps the subscription: its webhook records the plan and the
 * location quantity from the plan item, as for any other update.
 *
 * A Business subscription on an earlier Business price keeps that price and
 * bills every location; only its location quantity changes here.
 */
export interface BusinessChange {
  /** Locations the plan item covers. */
  locations: number
  /** Rental units covered on the current offer; null on an earlier Business price, which bills none. */
  rentalUnits: number | null
}

export interface BusinessChangePreview extends BusinessChange {
  currency: 'USD'
  /** The recurring charge after the change, in cents per month. */
  recurring: number
  /** The prorated difference Stripe invoices on confirmation, in cents; negative is a credit to the balance. */
  total: number
  /** What Stripe charges the card on confirmation, in cents, after any balance. */
  amountDue: number
  lines: Array<{ description: string; amount: number }>
  /** Stripe's proration instant for this preview; the confirmation uses the same one. */
  prorationDate: number
}

interface PlannedChange {
  subscription: Stripe.Subscription
  items: Stripe.SubscriptionUpdateParams.Item[]
  change: BusinessChange
  recurring: number
}

function refuse(statusCode: number, message: string, code: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code } })
}

function wholeAtLeast(value: unknown, minimum: number, field: string, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) refuse(422, `Choose at least ${minimum} ${label}.`, `INVALID_${field.toUpperCase()}`)
  return value as number
}

async function planChange(env: CloudflareEnv, db: DbClient, organizationId: string, request: { locations?: unknown; rentalUnits?: unknown }): Promise<PlannedChange> {
  const status = await getOrganizationBillingStatus(env, db, organizationId)
  if (!status.stripeSubscriptionId) refuse(409, 'Choose a plan in Billing first.', 'SUBSCRIPTION_REQUIRED')
  if (status.subscriptionStatus !== 'active' || status.stripeScheduleId || status.cancelAtPeriodEnd) {
    refuse(409, 'Your plan changes once it is active with no change or cancellation scheduled.', 'SUBSCRIPTION_NOT_CHANGEABLE')
  }
  const stripe = getStripe(env)
  const [subscription, plans] = await Promise.all([
    stripe.subscriptions.retrieve(status.stripeSubscriptionId, { expand: ['items.data.price.product', 'items.data.price.tiers'] }),
    createStripePlanLoader(stripe, env)(),
  ])
  if (subscription.status !== 'active' || subscription.schedule || subscription.cancel_at_period_end) {
    refuse(409, 'Your plan changes once it is active with no change or cancellation scheduled.', 'SUBSCRIPTION_NOT_CHANGEABLE')
  }
  const current = planSubscriptionItems(subscription)
  const currentProduct = current.plan.price.product as Stripe.Product
  // The current offer is listed first under its name; its line item is the Additional rental unit price.
  const offer = plans.find(plan => plan.name === BUSINESS_PLAN_ID)
  const rentalUnitPrice = offer?.lineItems?.[0]?.price
  if (!offer?.priceId || typeof rentalUnitPrice !== 'string') throw new Error('The Stripe catalog has no current Business offer')
  const earlierBusiness = currentProduct.metadata.plan_id === BUSINESS_PLAN_ID && !isCurrentBusinessPrice(current.plan.price)

  const price = earlierBusiness ? current.plan.price.id : offer.priceId
  const locations = wholeAtLeast(request.locations, Math.max(INCLUDED_LOCATIONS, earlierBusiness ? status.locations.used : status.businessUsage.locations), 'locations', 'locations')
  let rentalUnits: number | null = null
  if (earlierBusiness) {
    if (request.rentalUnits !== null && request.rentalUnits !== undefined) refuse(422, 'Your Business price covers every home as a location; it has no rental units to change.', 'RENTAL_UNITS_NOT_BILLED')
  } else {
    rentalUnits = wholeAtLeast(request.rentalUnits, Math.max(INCLUDED_RENTAL_UNITS, status.businessUsage.rentalUnits), 'rental_units', 'rental units')
  }
  const additional = rentalUnits === null ? 0 : rentalUnits - INCLUDED_RENTAL_UNITS
  if (price === current.plan.price.id && locations === current.plan.quantity && additional === (current.rentalUnits?.quantity ?? 0)) {
    refuse(409, 'Your plan already covers these.', 'PLAN_UNCHANGED')
  }
  const items: Stripe.SubscriptionUpdateParams.Item[] = [{ id: current.plan.id, price, quantity: locations }]
  if (current.rentalUnits) items.push(additional > 0 ? { id: current.rentalUnits.id, quantity: additional } : { id: current.rentalUnits.id, deleted: true })
  else if (additional > 0) items.push({ price: rentalUnitPrice, quantity: additional })

  const planPrice = earlierBusiness ? current.plan.price : await stripe.prices.retrieve(offer.priceId, { expand: ['tiers'] })
  const unitPrice = additional > 0 ? await stripe.prices.retrieve(rentalUnitPrice) : null
  const recurring = recurringPriceAmount(planPrice, locations) + (unitPrice ? recurringPriceAmount(unitPrice, additional) : 0)
  return { subscription, items, change: { locations, rentalUnits }, recurring }
}

// Stripe invoices the prorated difference at once and charges the plan's card,
// as the Strategy service does; a declined card fails the update and changes nothing.
const PRORATION = 'always_invoice' as const

/** Stripe's invoice for the change, before anything changes. */
export async function previewBusinessChange(env: CloudflareEnv, db: DbClient, organizationId: string, request: { locations?: unknown; rentalUnits?: unknown }): Promise<BusinessChangePreview> {
  const planned = await planChange(env, db, organizationId, request)
  const prorationDate = Math.floor(Date.now() / 1000)
  const customer = typeof planned.subscription.customer === 'string' ? planned.subscription.customer : planned.subscription.customer.id
  const invoice = await getStripe(env).invoices.createPreview({
    customer,
    subscription: planned.subscription.id,
    subscription_details: { items: planned.items, proration_behavior: PRORATION, proration_date: prorationDate },
  })
  if (invoice.currency !== 'usd') throw new Error(`Stripe previewed the plan change in ${invoice.currency}, not USD`)
  return {
    ...planned.change,
    currency: 'USD',
    recurring: planned.recurring,
    total: invoice.total,
    amountDue: invoice.amount_due,
    lines: invoice.lines.data.map(line => ({ description: line.description ?? '', amount: line.amount })),
    prorationDate,
  }
}

/** Confirm a previewed change: the same items and proration instant, then Stripe's subscription read back. */
export async function confirmBusinessChange(env: CloudflareEnv, db: DbClient, organizationId: string, request: { locations?: unknown; rentalUnits?: unknown; prorationDate?: unknown; attempt: string }): Promise<BusinessChange> {
  const prorationDate = request.prorationDate
  // Stripe accepts a proration date within the current period; an old preview is re-read rather than confirmed.
  if (!Number.isSafeInteger(prorationDate) || Math.abs(Date.now() / 1000 - (prorationDate as number)) > 15 * 60) {
    refuse(409, 'This preview has expired. Review the change again before confirming it.', 'PREVIEW_EXPIRED')
  }
  const planned = await planChange(env, db, organizationId, request)
  const stripe = getStripe(env)
  await stripe.subscriptions.update(planned.subscription.id, {
    items: planned.items,
    proration_behavior: PRORATION,
    proration_date: prorationDate as number,
    payment_behavior: 'error_if_incomplete',
  }, { idempotencyKey: `business-change:${organizationId}:${request.attempt}` })
  const after = await stripe.subscriptions.retrieve(planned.subscription.id, { expand: ['items.data.price.product', 'items.data.price.tiers'] })
  const items = planSubscriptionItems(after)
  const read: BusinessChange = {
    locations: items.plan.quantity ?? 0,
    rentalUnits: isCurrentBusinessPrice(items.plan.price) ? INCLUDED_RENTAL_UNITS + (items.rentalUnits?.quantity ?? 0) : null,
  }
  const planItem = planned.items[0]!
  if (items.plan.price.id !== planItem.price || read.locations !== planned.change.locations || read.rentalUnits !== planned.change.rentalUnits) {
    throw new Error(`Stripe subscription ${after.id} does not read back the confirmed Business change`)
  }
  return read
}
