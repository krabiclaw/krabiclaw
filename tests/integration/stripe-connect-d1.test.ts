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

test('connected account reservation is organization-scoped and retry-stable', async () => {
  await withD1(async (db) => {
    const [first, second] = await Promise.all([
      reserveStripeConnectedAccount(db, { organizationId: 'org', livemode: false }),
      reserveStripeConnectedAccount(db, { organizationId: 'org', livemode: false }),
    ])
    assert.equal(first.id, second.id)
    assert.equal(first.status, 'creating')
    assert.equal(await db.prepare("SELECT count(*) FROM stripe_connected_accounts WHERE organization_id='org'").first('count(*)'), 1)
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

test('the iPhone app starts Stripe payouts onboarding on the dashboard Connect route with its bearer session', async t => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'payouts-app-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    const env = {
      ...await runtime.getBindings<CloudflareEnv>(), DB: db, BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test', STRIPE_SECRET_KEY: 'sk_test_payouts', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as CloudflareEnv
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES ('org', 'Cliff Stays', 'cliff', 'cliff', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'UTC')`).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner@example.test', 1, 0, 0)").run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', 'org', 'owner', 'owner', 0)").run()
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('a-owner', 'owner', 'credential', 'owner', ?, 0, 0)").bind(await hashPassword('PayoutsProof123!')).run()
    const app = new H3()
    app.post('/api/dashboard/connect', connectStartRoute)
    app.post('/api/dashboard/connect/status', connectStatusRoute)
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
    const account = { id: 'acct_payouts', object: 'v2.core.account', livemode: false, dashboard: 'express', identity: { country: 'US' },
      defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'stripe' } }, configuration: { merchant: { capabilities: { card_payments: { status: 'pending', status_details: [] } } } },
      requirements: { entries: [{ awaiting_action_from: 'user', minimum_deadline: { status: 'currently_due' }, description: 'Provide a bank account for payouts', errors: [] }] } }
    const originalFetch = globalThis.fetch
    const fetchMock = t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== 'https://api.stripe.com') return originalFetch(request, init)
      const method = (request instanceof Request ? request.method : init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && url.pathname === '/v2/core/accounts') { created = true; return Response.json(account) }
      if (method === 'GET' && url.pathname === '/v2/core/accounts/acct_payouts') return Response.json(account)
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
      assert.equal((await call('', app_, { returnTo: 'web' })).status, 422)
      assert.equal(created, false)
      const started = await call('', app_, { returnTo: 'app' })
      assert.equal(started.status, 200)
      assert.equal(started.body.onboardingUrl, 'https://connect.stripe.com/d/setup/e/acct_payouts/abc')
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
    } finally { fetchMock.mock.restore() }
  } finally {
    await runtime.dispose()
  }
})

test('checkout uses Stripe seller country for Tax availability and preserves supported-country errors', async t => {
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
      assert.equal(country, 'US', 'Thai checkout must not query unsupported Tax endpoints')
      if (taxFails) return Response.json({ error: { type: 'invalid_request_error', message: 'Tax read rejected' } }, { status: 400 })
      if (url.pathname === '/v1/tax/settings') return Response.json({ status: 'active' })
      assert.equal(url.pathname, '/v1/tax/registrations')
      return Response.json({ data: [{ id: 'taxreg_test' }] })
    })
    try {
      const thai = await requireStripeCheckoutAcceptance(db, env, 'org')
      assert.equal(thai.connected.country, 'TH')
      assert.equal(thai.automaticTax, false)
      assert.deepEqual(paths, ['/v2/core/accounts/acct_test', '/v1/payment_method_configurations'])
      country = 'US'
      assert.equal((await requireStripeCheckoutAcceptance(db, env, 'org')).automaticTax, true)
      taxFails = true
      await assert.rejects(requireStripeCheckoutAcceptance(db, env, 'org'), /Tax read rejected/)
    } finally { fetchMock.mock.restore() }
  })
})

test('Connect webhook work is claimed once across concurrent D1 deliveries', async () => {
  await withD1(async (db) => {
    let executions = 0
    const event = {
      id: 'evt_connect_test',
      type: 'v2.core.account.updated',
      payload: JSON.stringify({ id: 'evt_connect_test', type: 'v2.core.account.updated' }),
      processor: 'connect_marketplace' as const,
    }
    const started = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const work = async () => {
      executions += 1
      started.resolve(undefined)
      await finish.promise
    }
    const processing = processStripeWebhookEvent(db, event, work)
    assert.equal(await Promise.race([started.promise.then(() => 'started'), processing.then(() => 'settled')]), 'started')
    try {
      assert.equal(await processStripeWebhookEvent(db, event, work), false)
    } finally {
      finish.resolve(undefined)
      assert.equal(await processing, true)
    }
    assert.equal(executions, 1)
    const row = await db.prepare("SELECT processor, status, attempt_count FROM stripe_webhook_events WHERE stripe_event_id='evt_connect_test'").first<{
      processor: string
      status: string
      attempt_count: number
    }>()
    assert.deepEqual(row, { processor: 'connect_marketplace', status: 'processed', attempt_count: 1 })
    assert.equal(await processStripeWebhookEvent(db, event, work), true)
    assert.equal(executions, 1)
  })
})
