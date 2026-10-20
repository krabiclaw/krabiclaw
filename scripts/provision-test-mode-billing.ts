#!/usr/bin/env node
// A copy of production carries production's billing: Better Auth subscription
// rows naming live-mode Stripe customers and subscriptions. Local, CI and
// staging run on a test-mode key, which cannot read those, so any billing read
// that asks Stripe (a Business plan's items, saved payment methods) fails there.
//
// This gives every current subscription in the copy its test-mode equivalent in
// the target's Stripe account: the same plan on the catalog's current price, the
// same location quantity, Business's rental-unit line, billed by invoice so no
// card is needed. The rows are then pointed at those objects. A rerun finds the
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

type Row = { id: string; referenceId: string; plan: string; seats: number | null; stripeSubscriptionId: string | null; stripeCustomerId: string | null; name: string | null }
const rows = d1<Row>(`SELECT s.id, s.referenceId, s.plan, s.seats, s.stripeSubscriptionId, s.stripeCustomerId, o.name
  FROM subscription s LEFT JOIN organization o ON o.id = s.referenceId
 WHERE s.status NOT IN ('canceled', 'incomplete_expired') AND s.stripeSubscriptionId IS NOT NULL`)

// The catalog's current offer per plan is the first entry the app configures Better Auth with.
const plans = new Map<string, Awaited<ReturnType<typeof getBetterAuthStripePlans>>[number]>()
for (const plan of await getBetterAuthStripePlans(stripe)) if (!plans.has(plan.name)) plans.set(plan.name, plan)

const readable = async (id: string) => {
  try {
    await stripe.subscriptions.retrieve(id)
    return true
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') return false
    throw error
  }
}

let provisioned = 0
for (const row of rows) {
  if (await readable(row.stripeSubscriptionId!)) continue
  const plan = plans.get(row.plan)
  if (!plan) throw new Error(`The test-mode catalog has no ${row.plan} plan for ${row.referenceId}`)
  if (!row.stripeCustomerId) throw new Error(`Subscription ${row.id} has no Stripe customer`)
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
      items: [{ price: plan.priceId, quantity: row.seats ?? 1 }, ...(plan.lineItems ?? []).map(item => ({ price: item.price!, quantity: item.quantity ?? 1 }))],
      collection_method: 'send_invoice',
      days_until_due: 30,
      metadata: { ...source, krabiclaw_source_subscription: row.stripeSubscriptionId!, referenceId: row.referenceId, plan: row.plan },
    }, { idempotencyKey: `test-mode-billing:subscription:v2:${row.stripeSubscriptionId}` })
  d1(`UPDATE subscription SET stripeCustomerId = ${sqlString(customer.id)}, stripeSubscriptionId = ${sqlString(subscription.id)}, stripeScheduleId = NULL WHERE id = ${sqlString(row.id)};
UPDATE organization SET stripeCustomerId = ${sqlString(customer.id)} WHERE id = ${sqlString(row.referenceId)};`)
  provisioned++
  console.log(`${row.name ?? row.referenceId}: ${row.plan} → ${subscription.id}`)
}
console.log(`Test-mode billing: ${provisioned} of ${rows.length} current subscriptions provisioned; the rest were already readable.`)
