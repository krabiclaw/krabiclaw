import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import {
  buildAppPayoutsOnboardingUrls,
  buildStripeConnectOnboardingUrls,
  deriveStripeConnectStatus,
  getStripeConnectedAccount,
  projectStripeConnectedAccount,
  reserveStripeConnectedAccount,
  requireStripeCheckoutAcceptance,
} from '../../server/utils/stripe-connect.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import connectStartRoute from '../../server/api/dashboard/connect/index.post.ts'
import connectStatusRoute from '../../server/api/dashboard/connect/status.post.ts'
import { processStripeWebhookEvent } from '../../server/utils/stripe-webhook-events.ts'
import { createProduct, getProduct, updateProduct } from '../../server/utils/product-management.ts'
import { setProductBookingConfig } from '../../server/utils/availability.ts'
import { memberAccessPrincipal, resolveMembership } from '../../server/utils/member-access.ts'
import { acceptOpportunity, listOpportunities } from '../../server/domain/opportunities.ts'
import { writeMemberScheduling } from '../../server/domain/member-scheduling.ts'
import { getTask, taskViewer } from '../../server/domain/tasks.ts'
import bookingConfigRoute from '../../server/api/editor/organizations/[organization_id]/products/[product_id]/booking.put.ts'
import { readBusinessRecommendations } from '../../server/domain/business-progress.ts'

async function withD1(run: (db: D1Database) => Promise<void>) {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stripe-connect-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': {
      type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }',
    } } }, env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO organization(id,name,slug, default_currency, timezone) VALUES('org','Org','org', 'USD', 'UTC')").run()
    await run(db)
  } finally {
    await runtime.dispose()
  }
}

test('connected account reservation is organization-scoped and claimed by one start at a time', async () => {
  await withD1(async (db) => {
    const outcomes = await Promise.allSettled([
      reserveStripeConnectedAccount(db, { organizationId: 'org', livemode: false }),
      reserveStripeConnectedAccount(db, { organizationId: 'org', livemode: false }),
    ])
    // One start creates the account; the other is told setup is already starting, never sent to Stripe.
    const first = outcomes.find(outcome => outcome.status === 'fulfilled')!.value
    const refused = outcomes.find(outcome => outcome.status === 'rejected')!.reason as { statusCode: number; data: { code: string } }
    assert.deepEqual([refused.statusCode, refused.data.code], [409, 'CONNECT_SETUP_IN_PROGRESS'])
    assert.equal(first.status, 'creating')
    assert.equal(await db.prepare("SELECT count(*) FROM stripe_connected_accounts WHERE organization_id='org'").first('count(*)'), 1)
    // A failed creation is claimed again, as is one left unfinished for over a minute.
    await db.prepare("UPDATE stripe_connected_accounts SET status='creation_failed', last_error='Stripe refused' WHERE organization_id='org'").run()
    const retried = await reserveStripeConnectedAccount(db, { organizationId: 'org', livemode: false })
    assert.deepEqual([retried.id, retried.status, retried.lastError], [first.id, 'creating', null])
    await assert.rejects(reserveStripeConnectedAccount(db, { organizationId: 'org', livemode: false }), { statusCode: 409, data: { code: 'CONNECT_SETUP_IN_PROGRESS' } })
    await db.prepare("UPDATE stripe_connected_accounts SET updated_at='2026-01-01T00:00:00.000Z' WHERE organization_id='org'").run()
    assert.equal((await reserveStripeConnectedAccount(db, { organizationId: 'org', livemode: false })).id, first.id)
    // A reservation has no provider identity before Stripe creates the account.
    assert.equal(await db.prepare("SELECT country FROM stripe_connected_accounts WHERE organization_id='org'").first('country'), null)
    await assert.rejects(
      reserveStripeConnectedAccount(db, { organizationId: 'org', livemode: true }),
      /different Stripe mode/i,
    )
  })
})

test('Stripe account projection preserves provider identity and derives onboarding state', async () => {
  await withD1(async (db) => {
    const reserved = await reserveStripeConnectedAccount(db, { organizationId: 'org', livemode: false })
    const actionRequired = deriveStripeConnectStatus({
      cardPaymentsStatus: 'pending',
      cardPaymentsResolutions: [],
      requirements: [{ awaitingActionFrom: 'user', deadlineStatus: 'currently_due' }],
    })
    assert.equal(actionRequired, 'action_required')
    // Restricted while Stripe verifies what was just submitted is under review, not an action for the business.
    const derive = (cardPaymentsStatus: 'restricted' | 'pending', cardPaymentsResolutions: Array<'no_resolution' | 'provide_info' | 'contact_stripe'>) => deriveStripeConnectStatus({ cardPaymentsStatus, cardPaymentsResolutions, requirements: [] })
    assert.equal(derive('restricted', ['no_resolution']), 'pending_review')
    assert.equal(derive('pending', ['no_resolution']), 'pending_review')
    assert.equal(derive('restricted', ['provide_info']), 'action_required')
    assert.equal(derive('restricted', ['contact_stripe']), 'restricted')
    assert.equal(derive('restricted', []), 'restricted')

    await projectStripeConnectedAccount(db, {
      reservationId: reserved.id,
      organizationId: 'org',
      stripeAccountId: 'acct_test',
      country: 'US',
      livemode: false,
      cardPaymentsStatus: 'active',
      cardPaymentsResolutions: [],
      requirements: [],
      stripeRefreshedAt: '2026-09-12T12:00:00.000Z',
    })

    const connected = await getStripeConnectedAccount(db, 'org')
    assert.ok(connected)
    assert.equal(connected.stripeAccountId, 'acct_test')
    assert.equal(connected.status, 'ready')
    assert.equal(connected.cardPaymentsStatus, 'active')
    assert.deepEqual(connected.requirements, [])
    // The country is the one Stripe reported for the account.
    assert.equal(await db.prepare("SELECT country FROM stripe_connected_accounts WHERE stripe_account_id='acct_test'").first('country'), 'US')
  })
})

test('Connect callback URLs are built only from the configured platform origin and organization slug', () => {
  assert.deepEqual(
    buildStripeConnectOnboardingUrls('https://krabiclaw.com', 'sun-and-sea'),
    {
      returnUrl: 'https://krabiclaw.com/dashboard/sun-and-sea/payments?tab=payouts&stripe_connect=returned',
      refreshUrl: 'https://krabiclaw.com/api/dashboard/connect/refresh?org=sun-and-sea',
    },
  )
  assert.throws(() => buildStripeConnectOnboardingUrls('http://krabiclaw.com', 'sun-and-sea'), /HTTPS/)
  assert.throws(() => buildStripeConnectOnboardingUrls('https://krabiclaw.com/path', 'sun-and-sea'), /origin/)
  assert.deepEqual(buildAppPayoutsOnboardingUrls('https://krabiclaw.com'), {
    returnUrl: 'https://krabiclaw.com/app/return/payouts?outcome=done',
    refreshUrl: 'https://krabiclaw.com/app/return/payouts?outcome=refresh',
  })
  assert.throws(() => buildAppPayoutsOnboardingUrls('http://krabiclaw.com'), /HTTPS/)
})

test('Stripe onboarding recommendations follow real account readiness and clear when paid booking is enabled', async t => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'payouts-app-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'payouts-app-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    const env = {
      ...await runtime.getBindings<CloudflareEnv>(), DB: db, BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test', STRIPE_SECRET_KEY: 'sk_test_payouts', NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_payouts', STRIPE_PAYMENTS_METHOD_CONFIGURATION: 'pmc_payouts', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as CloudflareEnv
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES ('org', 'Cliff Classes', 'cliff', 'cliff', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'experience', '2026-10-15T00:00:00.000Z', 'UTC')`).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner@example.test', 1, 0, 0)").run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', 'org', 'owner', 'owner', 0)").run()
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('a-owner', 'owner', 'credential', 'owner', ?, 0, 0)").bind(await hashPassword('PayoutsProof123!')).run()
    await db.prepare("UPDATE organization SET stripeCustomerId='cus_payouts' WHERE id='org'").run()
    await db.prepare(`INSERT INTO subscription(id,plan,referenceId,status,seats,stripeCustomerId,stripeSubscriptionId,billingInterval)
      VALUES('sub','business','org','active',1,'cus_payouts','sub_payouts','month')`).run()
    const paid = await createProduct(db, { organizationId: 'org', actor: { actorId: 'owner' }, env,
      product: { kind: 'experience', name: 'Wheel Class', variants: [{ name: 'Default', prices: [{ currency: 'USD', unit_amount: 5000 }] }] } })
    const free = await createProduct(db, { organizationId: 'org', actor: { actorId: 'owner' }, env,
      product: { kind: 'experience', name: 'Free Studio Tour', variants: [{ name: 'Default', prices: [{ currency: 'USD', unit_amount: 0 }] }] } })
    for (const product of [paid, free]) await setProductBookingConfig(db, { organizationId: 'org', productId: product.id, actorId: 'owner', env,
      patch: { duration_minutes: 120, default_capacity: 8, confirmation_mode: 'instant', online_payment_required: false, assigned_member_id: 'm-owner' } })
    const membership = await resolveMembership(env, { organizationId: 'org', userId: 'owner' })
    assert.ok(membership)
    const principal = memberAccessPrincipal(membership, { env })
    const recommendations = async () => (await readBusinessRecommendations(db, principal)).recommendations
    assert.deepEqual((await recommendations()).filter(item => item.operation === 'payments.connect').map(item => item.subjectId), ['org'])
    assert.equal((await recommendations()).some(item => item.operation === 'product.payment'), false)
    const app = new H3()
    app.post('/api/dashboard/connect', connectStartRoute)
    app.post('/api/dashboard/connect/status', connectStatusRoute)
    app.put('/api/editor/organizations/:organization_id/products/:product_id/booking', bookingConfigRoute)
    const login = await createAuth(env).api.signInEmail({ body: { email: 'owner@example.test', password: 'PayoutsProof123!' }, asResponse: true })
    const token = login.headers.get('set-auth-token')!
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const call = async (path: string, headers: Record<string, string>, body?: unknown) => {
      const response = await app.request(Object.assign(new Request(`https://proof.example/api/dashboard/connect${path}?org=cliff`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    // As the app calls: a bearer session, no cookie and no browser origin.
    const app_ = { authorization: `Bearer ${token}` }

    const links: Array<Record<string, unknown>> = []
    let created = false
    // Stripe's account create is held open so a second start arrives while the first is creating the account.
    let creating!: () => void
    const createStarted = new Promise<void>(resolve => { creating = resolve })
    let releaseCreate!: () => void
    const createReleased = new Promise<void>(resolve => { releaseCreate = resolve })
    const account = { id: 'acct_payouts', object: 'v2.core.account', livemode: false, dashboard: 'express', identity: { country: 'US' },
      defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'stripe' } }, configuration: { merchant: { capabilities: { card_payments: { status: 'pending', status_details: [] } } } },
      requirements: { entries: [{ awaiting_action_from: 'user', minimum_deadline: { status: 'currently_due' }, description: 'Provide a bank account for payouts', errors: [] }] } }
    const originalFetch = globalThis.fetch
    const fetchMock = t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
      const method = (request instanceof Request ? request.method : init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && url.pathname === '/v2/core/accounts') {
        assert.equal(created, false, 'Stripe is asked to create the account once')
        created = true
        creating()
        await createReleased
        return Response.json(account)
      }
      if (method === 'GET' && url.pathname === '/v2/core/accounts/acct_payouts') return Response.json(account)
      if (method === 'GET' && url.pathname === '/v1/subscriptions/sub_payouts') return Response.json({ id: 'sub_payouts', object: 'subscription', customer: 'cus_payouts', livemode: false,
        items: { object: 'list', data: [
          { id: 'si_business', price: { id: 'price_business', product: { id: 'prod_business', metadata: { plan_id: 'business' } }, currency: 'usd', billing_scheme: 'per_unit', unit_amount: 14900, recurring: { interval: 'month', usage_type: 'licensed' } } },
          ...[['captured_volume', '0.014'], ['stripe_cost', '1']].map(([family, amount]) => ({ id: `si_${family}`, price: { id: `price_${family}`, product: { id: `prod_${family}`, metadata: { product_family: family } }, currency: 'usd', billing_scheme: 'per_unit', unit_amount_decimal: amount, recurring: { interval: 'month', usage_type: 'metered' } } })),
        ] } })
      if (method === 'GET' && url.pathname === '/v1/tax/settings') return Response.json({ status: 'inactive' })
      if (method === 'GET' && url.pathname === '/v1/tax/registrations') return Response.json({ data: [] })
      if (method === 'GET' && url.pathname === '/v1/payment_method_configurations') return Response.json({ data: [{ id: 'pmc_connected', parent: 'pmc_payouts', active: true }], has_more: false })
      if (method === 'POST' && url.pathname === '/v2/core/account_links') {
        links.push(JSON.parse(String(request instanceof Request ? await request.text() : init?.body)) as Record<string, unknown>)
        return Response.json({ object: 'v2.core.account_link', account: 'acct_payouts', url: 'https://connect.stripe.com/d/setup/e/acct_payouts/abc', expires_at: '2026-10-24T00:00:00.000Z', use_case: {} })
      }
      throw new Error(`unexpected Stripe request ${method} ${url.pathname}`)
    })
    try {
      // Before onboarding there is no account to refresh: a coded refusal.
      assert.deepEqual(await call('/status', app_), { status: 409, body: { status: 409, statusText: 'Stripe onboarding has not started', message: 'Stripe onboarding has not started', data: { code: 'CONNECT_NOT_STARTED' } } })
      // A cookie session still needs a same-origin browser request; the app's bearer session does not.
      assert.equal((await call('', { cookie })).status, 403)
      assert.equal((await call('', app_, { return_to: 'web' })).status, 422)
      assert.equal(created, false)
      const starting = call('', app_, { return_to: 'app' })
      await createStarted
      // A second Add payout method while Stripe is still creating the account is refused in words, not with Stripe's idempotency error.
      assert.deepEqual(await call('', app_, { return_to: 'app' }), { status: 409, body: { status: 409, statusText: 'Payout setup is already starting for this business. Finish it in the window where it opened, or try again in a minute.', message: 'Payout setup is already starting for this business. Finish it in the window where it opened, or try again in a minute.', data: { code: 'CONNECT_SETUP_IN_PROGRESS' } } })
      releaseCreate()
      const started = await starting
      assert.equal(started.status, 200)
      assert.equal(started.body.onboarding_url, 'https://connect.stripe.com/d/setup/e/acct_payouts/abc')
      assert.equal((started.body.account as { stripeAccountId: string }).stripeAccountId, 'acct_payouts')
      // Stripe takes only https returns, so the app's are a platform page that hands back to krabiclaw://payouts/<outcome>.
      assert.deepEqual((links[0]!.use_case as { account_onboarding: Record<string, unknown> }).account_onboarding, {
        collection_options: { fields: 'eventually_due', future_requirements: 'include' },
        return_url: 'https://krabiclaw.test/app/return/payouts?outcome=done',
        refresh_url: 'https://krabiclaw.test/app/return/payouts?outcome=refresh',
      })
      // The dashboard, same-origin with its cookie, keeps returning to Payments.
      assert.equal((await call('', { cookie, origin: 'https://proof.example' })).status, 200)
      assert.equal((links[1]!.use_case as { account_onboarding: { return_url: string } }).account_onboarding.return_url, 'https://krabiclaw.test/dashboard/cliff/payments?tab=payouts&stripe_connect=returned')
      const status = await call('/status', app_)
      assert.equal(status.status, 200)
      assert.deepEqual((status.body.account as { requirements: unknown }).requirements, [{ awaitingActionFrom: 'user', deadlineStatus: 'currently_due', description: 'Provide a bank account for payouts', errors: [] }])
      account.requirements.entries = []
      const pending = await call('/status', app_)
      assert.equal(pending.status, 200)
      assert.equal((pending.body.account as { status: string }).status, 'pending_review')
      const waiting = await recommendations()
      assert.equal(waiting.some(item => item.operation === 'payments.connect' || item.operation === 'product.payment'), false, 'Stripe review is not another owner setup task')
      account.configuration.merchant.capabilities.card_payments.status = 'active'
      const ready = await call('/status', app_)
      assert.equal(ready.status, 200)
      assert.equal((ready.body.account as { status: string }).status, 'ready')
      const enabledPayments = await recommendations()
      assert.equal(enabledPayments.some(item => item.operation === 'payments.connect'), false)
      assert.deepEqual(enabledPayments.filter(item => item.operation === 'product.payment').map(item => item.subjectId), [paid.id], 'only the actually priced experience should require advance payment')
      const editor = `/dashboard/cliff/products/${paid.id}`
      const { opportunities } = await listOpportunities(db, principal)
      const payment = opportunities.find(item => item.path === `${editor}/booking/payment`)
      assert.ok(payment)
      const accepted = await acceptOpportunity(db, principal, payment.id, {})
      const viewer = await taskViewer(db, principal)
      const task = await getTask(db, viewer, accepted.id)
      assert.deepEqual(task.action, { type: 'open', label: 'Open payment settings', path: payment.path })
      assert.equal(task.can.complete, false)
      const save = await app.request(Object.assign(new Request(`https://proof.example/api/editor/organizations/org/products/${paid.id}/booking`, {
        method: 'PUT', headers: { 'content-type': 'application/json', ...app_ }, body: JSON.stringify({ online_payment_required: true }),
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      assert.equal(save.status, 200, await save.text())
      assert.equal((await getTask(db, viewer, accepted.id)).status, 'done')

      assert.equal((await getProduct(db, 'org', paid.id)).booking?.online_payment_required, true, 'ordinary catalog read observes the saved payment setting')
      assert.equal((await recommendations()).some(item => item.operation === 'product.payment'), false, 'actual booking configuration clears payment work on the next read without a day boundary')

      const catalogCards = async () => (await listOpportunities(db, principal)).opportunities
        .filter(item => item.product_id === paid.id && item.status_line === 'Catalog').map(item => item.path)
      // Every offering has its host; the card asks for the host's public profile.
      assert.deepEqual(await catalogCards(), ['/dashboard/cliff/team/m-owner/profile'])
      await writeMemberScheduling({ env, organizationId: 'org', userId: 'owner' }, 'm-owner', { updated_at: null, public_name: 'Wheel class host', public_approved: true })
      assert.deepEqual(await catalogCards(), [`${editor}/locations`])
      await updateProduct(db, { organizationId: 'org', productId: paid.id, actor: { actorId: 'owner' }, env,
        patch: { order_url: 'https://example.com/book/wheel-class' } })
      assert.deepEqual(await catalogCards(), [])

    } finally { fetchMock.mock.restore() }
  } finally {
    await runtime.dispose()
  }
})

test('checkout reads Stripe Tax only for a seller in a Stripe Tax business location and preserves its errors', async t => {
  await withD1(async db => {
    await db.prepare("UPDATE organization SET subdomain='demo' WHERE id='org'").run()
    await db.prepare("INSERT INTO subscription(id,plan,referenceId,status,seats) VALUES('sub','business','org','active',1)").run()
    const reserved = await reserveStripeConnectedAccount(db, { organizationId: 'org', livemode: false })
    await projectStripeConnectedAccount(db, { reservationId: reserved.id, organizationId: 'org', stripeAccountId: 'acct_test', country: 'US', livemode: false, cardPaymentsStatus: 'active', cardPaymentsResolutions: [], requirements: [], stripeRefreshedAt: new Date().toISOString() })
    const env = { DB: db, BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_live_mock', STRIPE_TEST_SECRET_KEY: 'sk_test_mock', STRIPE_TEST_PUBLISHABLE_KEY: 'pk_test_mock', STRIPE_TEST_PAYMENTS_METHOD_CONFIGURATION: 'pmc_parent' } as CloudflareEnv
    let country = 'TH'
    let taxFails = false
    const paths: string[] = []
    const originalFetch = globalThis.fetch
    const fetchMock = t.mock.method(globalThis, 'fetch', async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
      paths.push(url.pathname)
      if (url.pathname === '/v2/core/accounts/acct_test') return Response.json({ id: 'acct_test', livemode: false, dashboard: 'express', identity: { country }, defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'stripe' } }, configuration: { merchant: { capabilities: { card_payments: { status: 'active', status_details: [] } } } }, requirements: { entries: [] } })
      if (url.pathname === '/v1/payment_method_configurations') return Response.json({ data: [{ id: 'pmc_child', parent: 'pmc_parent', active: true }], has_more: false })
      assert.equal(country, 'US', 'a seller outside Stripe Tax business locations must not query Tax endpoints')
      if (taxFails) return Response.json({ error: { type: 'invalid_request_error', message: 'Tax read rejected' } }, { status: 400 })
      if (url.pathname === '/v1/tax/settings') return Response.json({ status: 'active' })
      assert.equal(url.pathname, '/v1/tax/registrations')
      return Response.json({ data: [{ id: 'taxreg_test' }] })
    })
    try {
      // Stripe Tax answers these sellers with a 400 that carries no code; they collect no tax through it.
      for (const outside of ['TH', 'MY', 'ID', 'PH', 'VN', 'IN']) {
        country = outside
        paths.length = 0
        const seller = await requireStripeCheckoutAcceptance(db, env, 'org')
        assert.equal(seller.connected.country, outside)
        assert.equal(seller.automaticTax, false)
        assert.deepEqual(paths, ['/v2/core/accounts/acct_test', '/v1/payment_method_configurations'])
      }
      country = 'US'
      assert.equal((await requireStripeCheckoutAcceptance(db, env, 'org')).automaticTax, true)
      taxFails = true
      await assert.rejects(requireStripeCheckoutAcceptance(db, env, 'org'), /Tax read rejected/)
    } finally { fetchMock.mock.restore() }
  })
})

test('a failed Connect event keeps its error for Stripe to redeliver, and a processed one is not processed again', async () => {
  await withD1(async (db) => {
    let executions = 0
    const event = {
      id: 'evt_connect_test',
      type: 'v2.core.account.updated',
      payload: JSON.stringify({ id: 'evt_connect_test', type: 'v2.core.account.updated' }),
      processor: 'connect_marketplace' as const,
    }
    const receipt = () => db.prepare("SELECT processor, status, error, payload FROM stripe_webhook_events WHERE stripe_event_id='evt_connect_test'").first()
    await assert.rejects(processStripeWebhookEvent(db, event, async () => {
      executions += 1
      throw new Error('Stripe account read refused')
    }), /Stripe account read refused/)
    assert.deepEqual(await receipt(), { processor: 'connect_marketplace', status: 'failed', error: 'Stripe account read refused', payload: event.payload })
    const work = async () => { executions += 1 }
    await processStripeWebhookEvent(db, event, work)
    assert.equal(executions, 2, 'the redelivery runs the failed work again')
    assert.deepEqual(await receipt(), { processor: 'connect_marketplace', status: 'processed', error: null, payload: null })
    await processStripeWebhookEvent(db, event, work)
    assert.equal(executions, 2, 'a redelivery of a processed event does nothing')
  })
})
