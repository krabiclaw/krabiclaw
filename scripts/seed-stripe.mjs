// Stripe catalog operator plan.
//
// Default mode is read-only: provider reads produce a deterministic plan JSON
// and SHA-256. Applying requires that reviewed plan, an exact SHA confirmation,
// an unchanged provider snapshot, and the explicitly selected account mode.
// Apply defaults to test mode; live apply requires --require-live-mode. The explicit
// --ownership-file cutover mode instead pins its inventory account and mode.
//
// Examples:
//   yarn stripe:catalog:plan
//   STRIPE_SECRET_KEY=sk_test_... node scripts/seed-stripe.mjs --dry-run --plan-file .tmp/stripe-catalog-plan.json
//   STRIPE_SECRET_KEY=sk_test_... node scripts/seed-stripe.mjs --dry-run --require-test-mode --plan-file .tmp/stripe-catalog-plan.json
//   STRIPE_SECRET_KEY=sk_test_... node scripts/seed-stripe.mjs --dry-run --retirement-only --plan-file .tmp/stripe-retirement-plan.json
//   STRIPE_SECRET_KEY=sk_test_... node scripts/seed-stripe.mjs --apply \
//     --plan-file .tmp/stripe-catalog-plan.json --confirm-sha256 <sha256> \
//     --journal-file .tmp/stripe-catalog-apply.json

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import Stripe from 'stripe'
import {
  OFFERED_PLAN_IDS,
  PLAN_DEFINITIONS,
  applyCatalogPlan,
  assertCatalogModeKey,
  createCatalogPlan,
  imageMimeType,
  keyMode,
  sha256Bytes,
  STRIPE_CATALOG_REQUEST_TIMEOUT_MS,
} from './lib/stripe-catalog-plan.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')

function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf-8')
    const env = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      env[key] = val
    }
    return env
  } catch {
    return {}
  }
}

function secretKeyFromEnv() {
  const env = loadEnv()
  return process.env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY || ''
}

function stripeReadAdapter(stripe) {
  return {
    account: { retrieve: () => stripe.accounts.retrieve(null) },
    products: stripe.products,
    prices: stripe.prices,
    subscriptions: stripe.subscriptions,
  }
}

function stripeMutationAdapter(stripe) {
  return { products: stripe.products, prices: stripe.prices, subscriptions: stripe.subscriptions }
}

function describeImageFiles() {
  return Object.fromEntries(PLAN_DEFINITIONS
    .filter(definition => definition.imagePath)
    .map(definition => {
      const path = definition.imagePath
      const absolutePath = resolve(REPO_ROOT, path)
      if (!existsSync(absolutePath)) return [definition.planId, { path, exists: false }]
      const bytes = readFileSync(absolutePath)
      return [definition.planId, {
        path,
        exists: true,
        sha256: sha256Bytes(bytes),
        mimeType: imageMimeType(path),
        fileName: basename(path),
      }]
    }))
}

function localImagePath(path) {
  return resolve(REPO_ROOT, path)
}

function stripeFilesAdapter(secretKey) {
  return {
    async verifyProductImage(operation) {
      const path = localImagePath(operation.path)
      if (!existsSync(path)) throw new Error(`Stripe catalog image is missing: ${operation.path}`)
      const bytes = readFileSync(path)
      const actualHash = sha256Bytes(bytes)
      if (actualHash !== operation.sha256) {
        throw new Error(`Stripe catalog image changed since plan generation: ${operation.path}`)
      }
    },
    async uploadProductImage(operation, { idempotencyKey } = {}) {
      await this.verifyProductImage(operation)
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        throw new Error('Stripe catalog image upload requires an idempotency key.')
      }
      const path = localImagePath(operation.path)
      const bytes = readFileSync(path)
      const form = new FormData()
      form.append('purpose', 'product_image')
      form.append('file', new Blob([bytes], { type: operation.mimeType }), operation.fileName)

      const response = await fetch('https://files.stripe.com/v1/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Idempotency-Key': `${idempotencyKey}-file`,
        },
        body: form,
        signal: AbortSignal.timeout(STRIPE_CATALOG_REQUEST_TIMEOUT_MS),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result?.error?.message ?? 'Stripe product image upload failed')

      const linkResponse = await fetch('https://api.stripe.com/v1/file_links', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': `${idempotencyKey}-link`,
        },
        body: `file=${encodeURIComponent(result.id)}`,
        signal: AbortSignal.timeout(STRIPE_CATALOG_REQUEST_TIMEOUT_MS),
      })
      const link = await linkResponse.json()
      if (!linkResponse.ok) throw new Error(link?.error?.message ?? 'Stripe product image link creation failed')
      return link.url
    },
  }
}

export function parseCanonicalProductOverrides(values = []) {
  const overrides = {}
  const inputs = Array.isArray(values) ? values : [values]
  for (const value of inputs.filter(item => item != null)) {
    const raw = String(value).trim()
    const separator = raw.indexOf('=')
    if (separator <= 0 || separator === raw.length - 1 || raw.indexOf('=', separator + 1) !== -1) {
      throw new Error('--canonical-product must use the exact plan_id=prod_id format.')
    }
    const planId = raw.slice(0, separator).trim()
    const productId = raw.slice(separator + 1).trim()
    if (!OFFERED_PLAN_IDS.includes(planId)) {
      throw new Error(`--canonical-product has unsupported plan ID ${planId}.`)
    }
    if (!productId) throw new Error(`--canonical-product ${planId} requires a product ID.`)
    if (Object.hasOwn(overrides, planId)) {
      throw new Error(`Duplicate --canonical-product override for plan ${planId}.`)
    }
    overrides[planId] = productId
  }
  return Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)))
}

function sameExistingFile(left, right) {
  if (left === right) return true
  if (!existsSync(left) || !existsSync(right)) return false
  const leftStat = statSync(left)
  const rightStat = statSync(right)
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      'require-test-mode': { type: 'boolean' },
      'require-live-mode': { type: 'boolean' },
      'retirement-only': { type: 'boolean' },
      'plan-file': { type: 'string' },
      'journal-file': { type: 'string' },
      'journal-path': { type: 'string' },
      'confirm-sha256': { type: 'string' },
      'canonical-product': { type: 'string', multiple: true },
      'ownership-file': { type: 'string' },
      'verify-ownership': { type: 'boolean' },
      'rollback-ownership': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  if (values['dry-run'] && values.apply) throw new Error('Choose either --dry-run or --apply, not both.')
  if (values['require-test-mode'] && values['require-live-mode']) throw new Error('Choose either --require-test-mode or --require-live-mode, not both.')
  const apply = Boolean(values.apply)
  const ownershipFile = values['ownership-file'] ? resolve(values['ownership-file']) : null
  const verifyOwnership = Boolean(values['verify-ownership'])
  const rollbackOwnership = Boolean(values['rollback-ownership'])
  if (verifyOwnership && (!ownershipFile || apply)) throw new Error('--verify-ownership requires --ownership-file without --apply.')
  if (rollbackOwnership && (!ownershipFile || !apply)) throw new Error('--rollback-ownership requires --ownership-file and --apply.')
  if (ownershipFile && (values['retirement-only'] || values['canonical-product'])) throw new Error('Ownership cutover cannot include catalog changes.')
  const planFile = values['plan-file'] ? resolve(String(values['plan-file'])) : null
  const journalValue = values['journal-file'] ?? values['journal-path']
  if (values['journal-file'] && values['journal-path'] && String(values['journal-file']) !== String(values['journal-path'])) {
    throw new Error('--journal-file and --journal-path must name the same file when both are provided.')
  }
  const journalFile = journalValue ? resolve(String(journalValue)) : null
  if (apply && !planFile) throw new Error('--apply requires an explicit --plan-file.')
  if (apply && !values['confirm-sha256']) throw new Error('--apply requires --confirm-sha256 <plan-sha256>.')
  const canonicalProductIds = parseCanonicalProductOverrides(values['canonical-product'])
  if (apply && Object.keys(canonicalProductIds).length > 0) {
    throw new Error('--canonical-product is only valid when generating a catalog plan.')
  }
  if (apply && values['retirement-only']) {
    throw new Error('--retirement-only is only valid when generating a catalog plan.')
  }
  if (apply && !journalFile) throw new Error('--apply requires an explicit --journal-file.')
  if (apply && planFile && journalFile && sameExistingFile(planFile, journalFile)) {
    throw new Error('--plan-file and --journal-file must be different files.')
  }
  if (!apply && journalFile) throw new Error('--journal-file is only valid with --apply.')
  return {
    apply,
    ownershipFile,
    verifyOwnership,
    rollbackOwnership,
    requireTestMode: Boolean(values['require-test-mode']),
    requireLiveMode: Boolean(values['require-live-mode']),
    retirementOnly: Boolean(values['retirement-only']),
    planFile,
    journalFile,
    journalPath: journalFile,
    confirmSha256: values['confirm-sha256'] ? String(values['confirm-sha256']) : null,
    canonicalProductIds,
  }
}

export function createStripeClient(secretKey, StripeConstructor = Stripe) {
  return new StripeConstructor(secretKey, {
    maxNetworkRetries: 0,
    timeout: STRIPE_CATALOG_REQUEST_TIMEOUT_MS,
  })
}

function writePlan(path, plan) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
}

function ownershipJson(value) {
  if (Array.isArray(value)) return `[${value.map(ownershipJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${ownershipJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function ownershipHash(value) {
  return sha256Bytes(ownershipJson(value))
}

export async function readOwnershipCutover(stripe, inventory, mode) {
  if (!inventory || !/^acct_[A-Za-z0-9]+$/.test(inventory.accountId)
    || !['test', 'live'].includes(inventory.mode) || inventory.mode !== mode
    || !Array.isArray(inventory.organizations) || (inventory.organizations.length === 0 && !inventory.webhook)) {
    throw new Error('Ownership inventory requires the expected account, mode and canonical organization/customer pairs or an explicit webhook.')
  }
  const account = await stripe.accounts.retrieve(null)
  if (account.id !== inventory.accountId) throw new Error('Ownership cutover Stripe account mismatch.')
  const organizationIds = new Set()
  const customerIds = new Set()
  const objects = []
  for (const owner of inventory.organizations) {
    if (typeof owner.organizationId !== 'string' || !owner.organizationId.trim()
      || !/^cus_[A-Za-z0-9]+$/.test(owner.customerId)
      || organizationIds.has(owner.organizationId) || customerIds.has(owner.customerId)) {
      throw new Error('Ownership inventory contains an invalid or duplicate organization/customer pair.')
    }
    organizationIds.add(owner.organizationId)
    customerIds.add(owner.customerId)
    const customer = await stripe.customers.retrieve(owner.customerId)
    if (customer.deleted || customer.livemode !== (mode === 'live')) throw new Error('Ownership customer is deleted or has the wrong mode.')
    for (const key of ['organizationId', 'organization_id']) {
      if (customer.metadata[key] && customer.metadata[key] !== owner.organizationId) throw new Error('Customer ownership conflicts with the canonical inventory.')
    }
    if (customer.metadata.customerType && customer.metadata.customerType !== 'organization') throw new Error('Customer type conflicts with organization ownership.')
    objects.push({ kind: 'customer', id: customer.id, organizationId: owner.organizationId, state: { metadata: customer.metadata } })
    for await (const subscription of stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 })) {
      if (objects.length > 1000) throw new Error('Ownership inventory exceeds the bounded cutover size.')
      if (subscription.customer !== customer.id || subscription.livemode !== customer.livemode) throw new Error('Subscription customer or mode conflicts with inventory.')
      for (const key of ['referenceId', 'organization_id']) {
        if (subscription.metadata[key] && subscription.metadata[key] !== owner.organizationId) throw new Error('Subscription ownership conflicts with the canonical inventory.')
      }
      objects.push({
        kind: 'subscription', id: subscription.id, organizationId: owner.organizationId,
        state: {
          metadata: subscription.metadata, customer: subscription.customer, status: subscription.status,
          items: subscription.items.data.map(item => ({ id: item.id, price: item.price.id, quantity: item.quantity, periodStart: item.current_period_start, periodEnd: item.current_period_end })),
          latestInvoice: subscription.latest_invoice, cancelAtPeriodEnd: subscription.cancel_at_period_end,
          cancelAt: subscription.cancel_at, canceledAt: subscription.canceled_at, endedAt: subscription.ended_at,
          trialStart: subscription.trial_start, trialEnd: subscription.trial_end, schedule: subscription.schedule,
        },
      })
    }
  }
  if (inventory.webhook) {
    const { endpointId, fromUrl, toUrl } = inventory.webhook
    const source = new URL(fromUrl)
    const target = new URL(toUrl)
    if (!/^we_[A-Za-z0-9]+$/.test(endpointId) || source.protocol !== 'https:' || source.origin !== target.origin
      || source.pathname !== '/api/billing/webhook' || target.pathname !== '/api/auth/stripe/webhook'
      || source.search || target.search || source.hash || target.hash || source.username || target.username) {
      throw new Error('Webhook cutover must name the existing endpoint and the canonical path on the same HTTPS origin.')
    }
    const endpoint = await stripe.webhookEndpoints.retrieve(endpointId)
    if (endpoint.livemode !== (mode === 'live') || ![fromUrl, toUrl].includes(endpoint.url) || endpoint.status !== 'enabled') {
      throw new Error('Webhook endpoint mode, URL or status differs from the inventory.')
    }
    objects.push({ kind: 'webhook', id: endpoint.id, state: { url: endpoint.url, status: endpoint.status, apiVersion: endpoint.api_version, enabledEvents: endpoint.enabled_events.slice().sort(), metadata: endpoint.metadata } })
  }
  return objects.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
}

function normalizedOwnershipObject(object, inventory) {
  const after = structuredClone(object)
  if (object.kind === 'webhook') after.state.url = inventory.webhook.toUrl
  else if (object.kind === 'customer') {
    delete after.state.metadata.organization_id
    Object.assign(after.state.metadata, { organizationId: object.organizationId, customerType: 'organization' })
  } else if (object.state.status !== 'canceled') {
    delete after.state.metadata.organization_id
    after.state.metadata.referenceId = object.organizationId
  }
  return after
}

export async function runOwnershipCutover(cli, stripe, mode) {
  const inventory = JSON.parse(readFileSync(cli.ownershipFile, 'utf8'))
  const current = await readOwnershipCutover(stripe, inventory, mode)
  if (cli.verifyOwnership) {
    if (current.some(object => ownershipHash(object) !== ownershipHash(normalizedOwnershipObject(object, inventory)))) {
      throw new Error('Ownership verification found metadata or a webhook URL that still requires normalization.')
    }
    console.log(`Ownership verified: ${inventory.organizations.length} organizations, ${current.length} provider objects; canceled subscription history retained.`)
    return { status: 'verified', objectCount: current.length }
  }
  if (!cli.apply) {
    if (!cli.planFile) throw new Error('Ownership planning requires --plan-file for the private review artifact.')
    const body = { kind: 'stripe-ownership-cutover', schemaVersion: 1, capturedAt: new Date().toISOString(), inventory, objects: current.map(before => ({ before, after: normalizedOwnershipObject(before, inventory) })) }
    const plan = { ...body, planSha256: ownershipHash(body) }
    writePlan(cli.planFile, plan)
    console.log(`Wrote read-only ownership cutover plan: ${cli.planFile}\nPlan SHA-256: ${plan.planSha256}`)
    return { status: 'planned', planSha256: plan.planSha256 }
  }
  const { planSha256, ...plan } = JSON.parse(readFileSync(cli.planFile, 'utf8'))
  if (plan.kind !== 'stripe-ownership-cutover' || plan.schemaVersion !== 1 || planSha256 !== cli.confirmSha256
    || planSha256 !== ownershipHash(plan) || ownershipHash(plan.inventory) !== ownershipHash(inventory)) {
    throw new Error('Ownership cutover requires the unchanged reviewed plan and exact SHA-256.')
  }
  if (current.length !== plan.objects.length) throw new Error('Ownership inventory changed since review.')
  for (let index = 0; index < current.length; index += 1) {
    const operation = plan.objects[index]
    if (ownershipHash(operation.after) !== ownershipHash(normalizedOwnershipObject(operation.before, inventory))
      || ![ownershipHash(operation.before), ownershipHash(operation.after)].includes(ownershipHash(current[index]))) {
      throw new Error('Provider state changed since review; regenerate the plan before applying.')
    }
  }
  const operations = cli.rollbackOwnership ? plan.objects.map(({ before, after }) => ({ before: after, after: before })) : plan.objects
  const journal = { kind: plan.kind, planSha256, direction: cli.rollbackOwnership ? 'rollback' : 'forward', status: 'applying', completed: [] }
  writePlan(cli.journalFile, journal)
  for (let index = 0; index < current.length; index += 1) {
    const { before, after } = operations[index]
    if (ownershipHash(current[index]) === ownershipHash(after)) continue
    const options = { idempotencyKey: `ownership-${planSha256}-${journal.direction}-${index}` }
    if (before.kind === 'webhook') await stripe.webhookEndpoints.update(before.id, { url: after.state.url }, options)
    else {
      const metadata = Object.fromEntries([...new Set([...Object.keys(before.state.metadata), ...Object.keys(after.state.metadata)])]
        .filter(key => before.state.metadata[key] !== after.state.metadata[key]).map(key => [key, after.state.metadata[key] ?? '']))
      if (before.kind === 'customer') await stripe.customers.update(before.id, { metadata }, options)
      else await stripe.subscriptions.update(before.id, { metadata }, options)
    }
    journal.completed.push({ kind: before.kind, id: before.id })
    writePlan(cli.journalFile, journal)
  }
  const verified = await readOwnershipCutover(stripe, inventory, mode)
  if (ownershipHash(verified) !== ownershipHash(operations.map(operation => operation.after))) throw new Error('Cutover verification failed; retain plan and journal for investigation.')
  journal.status = 'verified'
  writePlan(cli.journalFile, journal)
  console.log(`Ownership cutover verified: ${journal.completed.length} metadata/endpoint operations; billing terms unchanged.`)
  return journal
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const cli = parseCli(argv)
  const secretKey = dependencies.secretKey ?? secretKeyFromEnv()
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not found in environment or .env')

  const mode = keyMode(secretKey)
  const requiredMode = cli.requireLiveMode ? 'live' : 'test'
  if ((cli.apply && !cli.ownershipFile) || cli.requireTestMode || cli.requireLiveMode) assertCatalogModeKey(secretKey, requiredMode)

  const stripeFactory = dependencies.stripeFactory ?? createStripeClient
  const stripe = stripeFactory(secretKey)
  if (cli.ownershipFile) return runOwnershipCutover(cli, stripe, mode)
  if (!cli.apply) {
    const plan = await createCatalogPlan({
      readAdapter: stripeReadAdapter(stripe),
      accountMode: mode,
      imageFiles: describeImageFiles(),
      canonicalProductIds: cli.canonicalProductIds,
      retirementOnly: cli.retirementOnly,
    })
    if (cli.planFile) {
      writePlan(cli.planFile, plan)
      console.log(`Wrote read-only Stripe catalog plan: ${cli.planFile}`)
      console.log(`Plan SHA-256: ${plan.planSha256}`)
    } else {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    }
    return { mode, planSha256: plan.planSha256, operationCount: plan.operations.length }
  }

  const plan = JSON.parse(readFileSync(cli.planFile, 'utf8'))
  const result = await applyCatalogPlan({
    plan,
    confirmedSha256: cli.confirmSha256,
    key: secretKey,
    readAdapter: stripeReadAdapter(stripe),
    mutationAdapter: stripeMutationAdapter(stripe),
    filesAdapter: stripeFilesAdapter(secretKey),
    journalPath: cli.journalFile,
    requiredMode,
  })
  console.log(`Stripe catalog apply status=${result.status}; applied ${result.appliedOperations} enumerated operations.`)
  console.log(`Plan SHA-256: ${result.planSha256}`)
  return result
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirectRun) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    if (error?.status === 'incomplete') {
      console.error(`Stripe catalog apply status=incomplete; journal=${error.journalPath ?? 'unknown'}`)
      console.error(`Next safe action: ${error.nextSafeAction ?? 'review the journal before any retry.'}`)
    }
    process.exitCode = 1
  })
}
