import type { H3Event } from 'h3'
import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession, type CloudflareEnv } from '~/server/utils/auth'
import { getOrganizationBillingStatus } from '~/server/utils/billing'
import { resolveRequestedOrganization } from '~/server/utils/dashboard-context'
import { createStripeClient } from '~/server/utils/stripe-client'
import { paymentsStripe } from '~/server/utils/stripe-connect'

/**
 * Whose cards a business's Payments page shows: the operating customer Better
 * Auth's Stripe plugin keeps for its subscription, managed by its owners and admins.
 */
export async function resolveBillingCustomer(event: H3Event, organizationId: string) {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, statusMessage: 'Authentication required', data: { code: 'AUTHENTICATION_REQUIRED', field: 'session' } })
  if (!env.STRIPE_SECRET_KEY) throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe is not configured', data: { code: 'BILLING_NOT_CONFIGURED', field: 'stripe' } })
  const organization = await resolveRequestedOrganization(event, env.DB, session.user.id, { explicitOrganizationId: organizationId })
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'No organization found', data: { code: 'ORGANIZATION_REQUIRED', field: 'organizationId' } })
  if (organization.role !== 'owner' && organization.role !== 'admin') throw new HTTPError({ statusCode: 403, statusMessage: 'Only owners and admins manage billing', data: { code: 'BILLING_FORBIDDEN', field: 'role' } })
  const billing = await getOrganizationBillingStatus(env, env.DB, organization.id)
  return { stripe: createStripeClient(env.STRIPE_SECRET_KEY), customerId: billing.stripeCustomerId ?? null, label: organization.name }
}

export interface PaymentMethodRow { id: string; brand: string; last4: string; exp_month: number; exp_year: number; default: boolean }

/** The customer's cards, the default first, as Stripe holds them. */
export async function listCustomerCards(stripe: Stripe, customerId: string, options: Stripe.RequestOptions = {}): Promise<PaymentMethodRow[]> {
  const [methods, customer] = await Promise.all([
    stripe.customers.listPaymentMethods(customerId, { type: 'card', limit: 20 }, options),
    stripe.customers.retrieve(customerId, {}, options),
  ])
  if (customer.deleted) throw new HTTPError({ statusCode: 409, statusMessage: 'The billing customer was deleted at Stripe', data: { code: 'BILLING_CUSTOMER_UNAVAILABLE', field: 'billing.customer' } })
  const fallback = customer.invoice_settings?.default_payment_method
  const defaultId = typeof fallback === 'string' ? fallback : fallback?.id ?? null
  return methods.data.flatMap((method): PaymentMethodRow[] => method.card
    ? [{ id: method.id, brand: method.card.brand, last4: method.card.last4, exp_month: method.card.exp_month, exp_year: method.card.exp_year, default: method.id === defaultId }]
    : [])
    .sort((a, b) => Number(b.default) - Number(a.default))
}

/**
 * A signed-in buyer's Customer on a business's connected account. Checkout
 * saves a card to it only when the buyer ticks Stripe's own save box, and
 * offers those cards again at that business alone; this keeps which Customer is
 * theirs. A guest pays without one.
 */
export async function connectedBuyerCustomer(db: DbClient, stripe: Stripe, userId: string, stripeAccountId: string, livemode: boolean): Promise<{ customerId: string; savedCards: number } | null> {
  const user = await queryFirst<{ email: string; name: string | null; isAnonymous: number | null }>(db, 'SELECT email, name, "isAnonymous" FROM user WHERE id = ?', [userId])
  if (!user) throw new Error('The buyer was not found')
  if (user.isAnonymous) return null
  const connected = { stripeAccount: stripeAccountId }
  let mapping = await queryFirst<{ stripe_customer_id: string }>(db, 'SELECT stripe_customer_id FROM stripe_connected_customers WHERE user_id=? AND stripe_account_id=? AND livemode=?', [userId, stripeAccountId, Number(livemode)])
  if (!mapping) {
    const created = await stripe.customers.create({ email: user.email, name: user.name ?? undefined, metadata: { krabiclaw_user_id: userId } }, connected)
    await execute(db, 'INSERT INTO stripe_connected_customers(user_id,stripe_account_id,livemode,stripe_customer_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,stripe_account_id,livemode) DO NOTHING', [userId, stripeAccountId, Number(livemode), created.id, new Date().toISOString()])
    mapping = await queryFirst<{ stripe_customer_id: string }>(db, 'SELECT stripe_customer_id FROM stripe_connected_customers WHERE user_id=? AND stripe_account_id=? AND livemode=?', [userId, stripeAccountId, Number(livemode)])
    if (!mapping) throw new Error('The connected customer was not recorded')
    if (mapping.stripe_customer_id !== created.id) await stripe.customers.del(created.id, connected)
  }
  const saved = await stripe.customers.listPaymentMethods(mapping.stripe_customer_id, { type: 'card', limit: 100 }, connected)
  return { customerId: mapping.stripe_customer_id, savedCards: saved.data.filter(method => method.allow_redisplay === 'always').length }
}

/**
 * Deletes the buyer's Customer on every business it paid; Stripe removes the
 * cards saved there with it. Each business keeps its charges, refunds, disputes
 * and receipts, which do not depend on the Customer.
 */
export async function deleteBuyerCustomers(db: DbClient, env: CloudflareEnv, userId: string) {
  const mappings = await queryAll<{ stripe_account_id: string; stripe_customer_id: string; livemode: number }>(db, 'SELECT stripe_account_id,stripe_customer_id,livemode FROM stripe_connected_customers WHERE user_id=?', [userId])
  for (const mapping of mappings) await paymentsStripe(env, Boolean(mapping.livemode)).customers.del(mapping.stripe_customer_id, {}, { stripeAccount: mapping.stripe_account_id })
}
