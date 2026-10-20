#!/usr/bin/env node
// A copy of production carries production's billing: Better Auth subscription
// rows naming live-mode Stripe customers and subscriptions. Local, CI and
// staging run on a test-mode key, which cannot read those, so any billing read
// that asks Stripe (a Business plan's items, saved payment methods) fails there.
//
// This gives every current subscription in the copy its test-mode equivalent in
// the target's Stripe account: the same plan at the price Better Auth knows it by
// (an offered plan's current price; a retired plan's own contract price) at
// quantity 1 and the plan's metered prices, which carry no quantity, billed by
// invoice so no card is needed. The rows are then pointed at those objects. A rerun finds the
// objects it made before by the live IDs they carry, so nothing is duplicated.
//
//   node --env-file-if-exists=.env --experimental-strip-types --import ./tests/unit/support/register-aliases.mjs scripts/provision-test-mode-billing.ts --local
//   node --env-file-if-exists=.env --experimental-strip-types --import ./tests/unit/support/register-aliases.mjs scripts/provision-test-mode-billing.ts --staging

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import Stripe from 'stripe'
import { getBetterAuthStripePlans } from '../server/utils/better-auth-stripe.ts'

const { values } = parseArgs({ options: { local: { type: 'boolean', default: false }, staging: { type: 'boolean', default: false } }, strict: true })
if (values.local === values.staging) throw new Error('Choose --local or --staging.')
// The platform key the target runs with: CI's and local's in the environment, staging's in .env.
const key = process.env.STRIPE_SECRET_KEY
if (!key?.startsWith('sk_test_') && !key?.startsWith('rk_test_')) throw new Error('Test-mode billing needs the target\'s test-mode Stripe secret key.')
const stripe = new Stripe(key)

const target = values.staging ? ['krabiclaw-staging-v19', '--remote', '--env', 'staging'] : ['DB', '--local']
const d1 = <T>(sql: string): T[] => {
  const output = execFileSync(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', ...target, '--command', sql, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const executions = JSON.parse(output) as Array<{ success: boolean; results: T[] }>
  if (!executions.every(execution => execution.success)) throw new Error('D1 statement failed')
  return executions.flatMap(execution => execution.results)
}
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`

type Row = { id: string; referenceId: string; plan: string; stripeSubscriptionId: string | null; stripeCustomerId: string | null; name: string | null; organizationCustomerId: string | null }
const rows = d1<Row>(`SELECT s.id, s.referenceId, s.plan, s.stripeSubscriptionId, s.stripeCustomerId, o.name, o.stripeCustomerId AS organizationCustomerId
  FROM subscription s LEFT JOIN organization o ON o.id = s.referenceId
 WHERE s.status NOT IN ('canceled', 'incomplete_expired') AND s.stripeSubscriptionId IS NOT NULL`)

// Each plan's price as the app configures Better Auth with it: the first entry is
// an offered plan's current offer, and a retired plan's contract price, which is
// what a subscription still on that plan pays.
const plans = new Map<string, Awaited<ReturnType<typeof getBetterAuthStripePlans>>[number]>()
for (const plan of await getBetterAuthStripePlans(stripe)) if (!plans.has(plan.name)) plans.set(plan.name, plan)

const readable = async (id: string): Promise<Stripe.Subscription | null> => {
  try {
    return await stripe.subscriptions.retrieve(id)
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') return null
    throw error
  }
}
const customerOf = (subscription: Stripe.Subscription) => typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id

let provisioned = 0
for (const row of rows) {
  // D1 does not make the two updates below one transaction: a run that stopped
  // between them left the subscription moved and its organization not, which
  // this finishes rather than leaving billing to refuse the mismatch.
  const existing = await readable(row.stripeSubscriptionId!)
  // A cancelled one is not the row's billing any more; it is replaced like one that cannot be read.
  if (existing && existing.status !== 'canceled') {
    // Only the row's own subscription settles its organization's customer.
    if (customerOf(existing) !== row.stripeCustomerId) throw new Error(`Subscription ${existing.id} belongs to ${customerOf(existing)}, not ${row.referenceId}'s customer ${row.stripeCustomerId}`)
    if (row.organizationCustomerId !== row.stripeCustomerId) d1(`UPDATE organization SET stripeCustomerId = ${sqlString(row.stripeCustomerId)} WHERE id = ${sqlString(row.referenceId)}`)
    continue
  }
  const plan = plans.get(row.plan)
  if (!plan?.priceId) throw new Error(`The test-mode catalog has no ${row.plan} plan price for ${row.referenceId}`)
  const planPrice = plan.priceId
  if (!row.stripeCustomerId) throw new Error(`Subscription ${row.id} has no Stripe customer`)
  // The plan's metered prices, as its Checkout adds them; what they bill is reported to their meters.
  const lineItems = (plan.lineItems ?? []).map(item => ({ price: item.price as string }))
  const source = { krabiclaw_source_customer: row.stripeCustomerId, krabiclaw_organization: row.referenceId }
  // Invoice billing needs an address; example.com receives nothing.
  const email = `test-mode-billing+${row.referenceId.toLowerCase().replace(/[^a-z0-9-]/g, '')}@example.com`
  const found = (await stripe.customers.search({ query: `metadata['krabiclaw_source_customer']:'${row.stripeCustomerId}'` })).data[0]
  const customer = found
    ? (found.email ? found : await stripe.customers.update(found.id, { email }))
    : await stripe.customers.create({ name: row.name ?? row.referenceId, email, metadata: source }, { idempotencyKey: `test-mode-billing:customer:v2:${row.stripeCustomerId}` })
  const subscription = (await stripe.subscriptions.search({ query: `metadata['krabiclaw_source_subscription']:'${row.stripeSubscriptionId}'` })).data.find(found => found.status !== 'canceled')
    ?? await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: planPrice, quantity: 1 }, ...lineItems],
      collection_method: 'send_invoice',
      days_until_due: 30,
      metadata: { ...source, krabiclaw_source_subscription: row.stripeSubscriptionId!, referenceId: row.referenceId, plan: row.plan },
    }, { idempotencyKey: `test-mode-billing:subscription:v4:${row.stripeSubscriptionId}` })
  // A subscription found by its source ID is used only if it is the one made for this row.
  if (customerOf(subscription) !== customer.id || subscription.metadata.referenceId !== row.referenceId || subscription.metadata.plan !== row.plan || !['active', 'trialing', 'past_due'].includes(subscription.status)) {
    throw new Error(`Test-mode subscription ${subscription.id} does not match ${row.referenceId}'s ${row.plan} subscription`)
  }
  // One made by an earlier run is brought to this run's prices: the catalog may have changed since.
  const wanted: Array<{ price: string; quantity?: number }> = [{ price: planPrice, quantity: 1 }, ...lineItems]
  const has = subscription.items.data.map(item => ({ price: item.price.id, quantity: item.price.recurring?.usage_type === 'metered' ? undefined : item.quantity ?? 1 }))
  const key = (items: Array<{ price: string; quantity?: number }>) => items.map(item => `${item.price}×${item.quantity ?? 'metered'}`).sort().join(',')
  if (key(has) !== key(wanted)) {
    await stripe.subscriptions.update(subscription.id, { items: [...subscription.items.data.map(item => ({ id: item.id, deleted: true })), ...wanted], proration_behavior: 'none' })
    console.log(`${row.name ?? row.referenceId}: ${subscription.id} brought to ${key(wanted)}`)
  }
  d1(`UPDATE subscription SET stripeCustomerId = ${sqlString(customer.id)}, stripeSubscriptionId = ${sqlString(subscription.id)}, stripeScheduleId = NULL WHERE id = ${sqlString(row.id)};
UPDATE organization SET stripeCustomerId = ${sqlString(customer.id)} WHERE id = ${sqlString(row.referenceId)};`)
  provisioned++
  console.log(`${row.name ?? row.referenceId}: ${row.plan} → ${subscription.id}`)
}
console.log(`Test-mode billing: ${provisioned} of ${rows.length} current subscriptions provisioned; the rest were already readable.`)
