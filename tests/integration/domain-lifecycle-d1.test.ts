import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import domainWebhook from '../../server/api/integrations/cloudflare/custom-hostnames/webhook.post.ts'
import { createSystemSubdomain, isSystemSubdomainSpent, ensureDomainAvailable, syncDomainWithCloudflare, deleteCustomDomain } from '../../server/utils/domains.ts'
import { listDashboardEvents } from '../../server/utils/dashboard-events.ts'
import { checkDashboardDomainGroup, connectDashboardDomain } from '../../server/utils/domain-dashboard-actions.ts'
import { getOrganizationDomains, groupCustomDomains } from '../../server/utils/domain-read-model.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { captureEvents } from './support/events.ts'
import { applySchema } from './support/schema.ts'

test('a stale domain result changes nothing and permanent subdomain reservations survive organization deletion', async (t) => {
  const miniflare = new Miniflare({ workers: [{ config: { name: 'owner-domain-test', compatibilityDate: '2024-11-01', manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } }, env: { DB: { type: 'd1' } } } }] })
  try {
    const db = await miniflare.getD1Database('DB')
    await applySchema(db)
    await db.prepare("INSERT INTO organization(id,name,slug, default_currency, timezone) VALUES('org','Org','org', 'USD', 'UTC'),('other','Other','other', 'USD', 'UTC'),('audit','Audit','audit', 'USD', 'UTC')").run()
    await db.prepare("INSERT INTO user(id,name,email) VALUES('operator','Operator','operator@example.test')").run()
    const env = { NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'example.test', CF_ZONE_ID: 'zone', CF_CUSTOM_HOSTNAMES_API_TOKEN: 'test', CF_SAAS_CNAME_TARGET: 'target.example.test' }
    await createSystemSubdomain(env, db, 'org', 'first')
    await createSystemSubdomain(env, db, 'org', 'second')
    assert.equal(await isSystemSubdomainSpent(env, db, 'first'), true)
    await db.prepare("DELETE FROM organization WHERE id='org'").run()
    assert.equal(await isSystemSubdomainSpent(env, db, 'first'), true)
    await assert.rejects(ensureDomainAvailable(db, ['first.example.test'], 'audit'))
    await assert.rejects(db.prepare("INSERT INTO organization_domains(id,domain,type,status) VALUES('bad','bad.example.test','custom','pending')").run())
    await db.prepare(`INSERT INTO organization_domains(id,organization_id,domain,type,status,cloudflare_hostname_id)
      VALUES ('other-custom','other','other.example.test','custom','pending','other-provider')`).run()
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status) VALUES ('sub-audit', 'growth', 'audit', 'active')").run()
    let requestsMade = 0
    let providerMode: 'pending' | 'observe' | 'stale' | 'delete-failed' | 'delete-success' | 'activate' | 'live-cutover' = 'pending'
    let dnsCutover = false
    let providerAvailable = true
    let providerStatus: 'active' | 'blocked' = 'active'
    let zarazAvailable = true
    let zarazReads = 0
    const checkedHostnames: string[] = []
    let zarazConfig: unknown = { tools: {}, triggers: {}, settings: { ecommerce: true } }
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const request = new URL(String(url))
      if (request.pathname.endsWith('/settings/zaraz/config')) {
        if (init?.method === 'PUT') zarazConfig = JSON.parse(String(init.body))
        else zarazReads += 1
        if (!zarazAvailable) return Response.json({ success: false, errors: [{ message: 'Zaraz unavailable' }] }, { status: 503 })
        return Response.json({ success: true, result: zarazConfig })
      }
      if (providerMode === 'live-cutover') {
        assert.equal(request.hostname, 'cloudflare-dns.com')
        const name = request.searchParams.get('name')
        const address = name === 'live.example.org' ? '192.0.2.17' : name === 'target.example.test' ? '192.0.2.53' : null
        return Response.json({ Status: 0, Answer: address && request.searchParams.get('type') === 'A' ? [{ type: 1, data: address }] : [] })
      }
      if (request.hostname === 'cloudflare-dns.com' && providerMode !== 'activate') {
        const name = request.searchParams.get('name')
        const flattened = name === 'custom.example.net' || name === 'target.example.test'
        return Response.json({ Status: 0, Answer: dnsCutover && flattened && request.searchParams.get('type') === 'A' ? [{ type: 1, data: '192.0.2.53' }] : [] })
      }
      if (providerMode === 'observe') {
        const id = request.pathname.split('/').at(-1)
        assert.equal(id, 'provider-id')
        assert.equal(init?.method ?? 'GET', 'GET')
        if (!providerAvailable) return Response.json({ success: false, errors: [{ message: 'provider unavailable' }] }, { status: 503 })
        return Response.json({ success: true, result: { id, hostname: 'custom.example.net', status: providerStatus, ssl: { status: 'active' } } })
      }
      if (providerMode === 'activate') {
        if (request.hostname === 'cloudflare-dns.com') return Response.json({ Status: 0, Answer: request.searchParams.get('type') === 'CNAME' ? [{ type: 5, data: 'target.example.test.' }] : [] })
        const id = request.pathname.split('/').at(-1)!
        assert.ok(['apex-provider', 'www-provider'].includes(id))
        if (init?.method === 'PATCH') {
          checkedHostnames.push(id)
          assert.equal(JSON.parse(String(init.body)).ssl.method, id === 'apex-provider' ? 'txt' : 'http')
        }
        const status = init?.method === 'PATCH' ? 'active' : 'pending'
        return Response.json({ success: true, result: { id, hostname: id === 'apex-provider' ? 'pair.example.test' : 'www.pair.example.test', status, ssl: { status } } })
      }
      assert.ok(String(url).startsWith('https://api.cloudflare.com/'))
      requestsMade += 1
      if (providerMode === 'stale') await db.prepare("UPDATE organization_domains SET status='disabled' WHERE id=?").bind(customId).run()
      if (providerMode === 'delete-failed') return Response.json({ success: false, errors: [{ message: 'provider unavailable' }] }, { status: 503 })
      if (providerMode === 'delete-success') { assert.equal(init?.method, 'DELETE'); return Response.json({ success: true, result: {} }) }
      return Response.json({ success: true, result: { id: 'provider-id', hostname: 'custom.example.net', status: 'pending', ssl: { status: 'pending_validation' } } })
    })
    providerMode = 'live-cutover'
    const events = captureEvents()
    const dashboardEnv = { ...env, DB: db, EVENTS: events.binding, CLOUDFLARE_API_TOKEN: 'test', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://provider.example.test',
      MEDIA_BUCKET: {}, ORGANIZATION_CACHE: {}, AI: {},
      CF_ACCOUNT_ID: 'account', CF_CUSTOM_HOSTNAMES_WEBHOOK_SECRET: 'domain-certificate-fixture',
      BETTER_AUTH_URL: 'https://provider.example.test', BETTER_AUTH_SECRET: 'fixture-domain-auth-secret-long-enough', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
    } as CloudflareEnv
    const actor = { organizationId: 'audit', organizationSlug: 'audit', actorId: 'operator', actorType: 'owner' } as const
    await assert.rejects(connectDashboardDomain(dashboardEnv, db,
      actor, 'live.example.org', true, false), {
      status: 409, data: {
        code: 'DOMAIN_LIVE_CUTOVER',
        live_cutover_warning: {
          hostname: 'live.example.org', records: [{ type: 'A', value: '192.0.2.17' }],
          message: 'live.example.org already resolves and may be live. Changing DNS can take it offline until Blawby validation finishes.',
        },
      },
    })
    assert.deepEqual(await getOrganizationDomains(db, 'audit'), [])
    providerMode = 'pending'
    const [custom] = await connectDashboardDomain(dashboardEnv, db, actor, 'custom.example.net', false, false)
    assert.ok(custom)
    const customId = custom.id
    assert.equal(custom.status, 'verifying')
    assert.equal(requestsMade, 1)
    assert.deepEqual(events.pending.find(item => item.body.type === 'domain.check_requested')?.body, {
      type: 'domain.check_requested', organization_id: 'audit', domains: [{ id: customId, cloudflare_hostname_id: 'provider-id' }],
    })
    await events.runNext(dashboardEnv, 'domain.check_requested')
    assert.equal(requestsMade, 2)
    assert.equal(events.take('domain.check_requested'), undefined)
    const [otherDomain] = await getOrganizationDomains(db, 'other')
    assert.equal(otherDomain?.status, 'pending')
    const auditCount = async (eventName: string) => (await db.prepare("SELECT count(*) AS n FROM activity_entries WHERE organization_id='audit' AND event_name=?").bind(eventName).first())?.n
    assert.equal(await auditCount('domain_state_changed'), 1)

    const app = new H3()
    const webhookPath = '/api/integrations/cloudflare/custom-hostnames/webhook'
    app.post(webhookPath, domainWebhook)
    const notification = (providerId = 'provider-id', zoneId = 'zone') => ({
      metadata: {
        event: { type: 'ssl.custom_hostname_certificate.deployment.succeeded' },
        account: { id: 'account' }, zone: { id: zoneId },
      },
      data: { id: providerId, hostname: 'custom.example.net', ssl: { status: 'active' } },
    })
    const deliverWebhook = (payload: unknown, secret = 'domain-certificate-fixture') => app.request(Object.assign(
      new Request(`https://provider.example.test${webhookPath}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-webhook-auth': secret }, body: JSON.stringify(payload),
      }), { runtime: { name: 'cloudflare', cloudflare: { env: dashboardEnv } } },
    ))
    assert.equal((await deliverWebhook(notification(), 'wrong-secret')).status, 401)
    assert.equal((await deliverWebhook(notification('provider-id', 'other-zone'))).status, 403)
    assert.equal((await deliverWebhook(notification('other-provider'))).status, 204)
    assert.equal(events.take('domain.check_requested'), undefined)

    providerMode = 'observe'
    assert.equal((await deliverWebhook(notification())).status, 202)
    await events.runNext(dashboardEnv, 'domain.check_requested')
    const [beforeCutover] = await getOrganizationDomains(db, 'audit')
    assert.deepEqual([beforeCutover?.status, beforeCutover?.dns_status, beforeCutover?.cloudflare_ssl_status], ['verifying', 'pending', 'active'])
    assert.equal(await auditCount('domain.verified'), 0)
    assert.equal(events.take('domain.check_requested'), undefined)
    providerAvailable = false
    dnsCutover = true
    assert.ok(beforeCutover)
    await checkDashboardDomainGroup(dashboardEnv, db, actor, beforeCutover)
    await assert.rejects(events.runNext(dashboardEnv, 'domain.check_requested'), /provider unavailable/)
    const [afterProviderFailure] = await getOrganizationDomains(db, 'audit')
    assert.deepEqual([afterProviderFailure?.status, afterProviderFailure?.error_message], ['verifying', 'provider unavailable'])
    providerAvailable = true
    zarazAvailable = false
    await assert.rejects(events.runNext(dashboardEnv, 'domain.check_requested'), /Zaraz unavailable/)
    assert.equal((await getOrganizationDomains(db, 'audit'))[0]?.status, 'active')
    zarazAvailable = true
    const readsBeforeActivationRetry = zarazReads
    await events.runNext(dashboardEnv, 'domain.check_requested')
    const [active] = await getOrganizationDomains(db, 'audit')
    assert.deepEqual([active?.status, active?.error_message, active?.dns_status, active?.dns_resolved_target],
      ['active', null, 'valid', 'A:192.0.2.53'])
    assert.ok(zarazReads > readsBeforeActivationRetry)
    assert.equal(await auditCount('domain.verified'), 1)
    assert.equal(events.take('domain.check_requested'), undefined)

    providerStatus = 'blocked'
    zarazAvailable = false
    assert.equal((await deliverWebhook(notification())).status, 202)
    await assert.rejects(events.runNext(dashboardEnv, 'domain.check_requested'), /Zaraz unavailable/)
    const [blocked] = await getOrganizationDomains(db, 'audit')
    assert.equal(blocked?.status, 'blocked')
    assert.ok(blocked?.activated_at)
    zarazAvailable = true
    const readsBeforeDeactivationRetry = zarazReads
    await events.runNext(dashboardEnv, 'domain.check_requested')
    assert.ok(zarazReads > readsBeforeDeactivationRetry)
    assert.equal(await auditCount('domain.failed'), 1)

    const domainChanges = await auditCount('domain_state_changed')
    providerMode = 'stale'
    const [beforeStale] = await getOrganizationDomains(db, 'audit')
    assert.ok(beforeStale)
    await assert.rejects(syncDomainWithCloudflare(dashboardEnv, db, beforeStale), /superseded/)
    assert.equal((await db.prepare('SELECT status FROM organization_domains WHERE id=?').bind(customId).first())?.status, 'disabled')
    // The superseded reconciliation changed nothing, so it recorded nothing.
    assert.equal(await auditCount('domain_state_changed'), domainChanges)
    await db.prepare("UPDATE organization_domains SET status='verifying',cloudflare_hostname_id='provider-id' WHERE id=?").bind(customId).run()
    providerMode = 'delete-failed'
    await assert.rejects(deleteCustomDomain(dashboardEnv, db, customId, 'system'))
    const failedDelete = await db.prepare("SELECT desired_state,status,error_message FROM organization_domains WHERE id=?").bind(customId).first()
    assert.equal(failedDelete?.desired_state, 'deleted')
    assert.equal(failedDelete?.status, 'verifying', 'a hostname Cloudflare still routes is not marked deleted here')
    assert.match(String(failedDelete?.error_message), /provider unavailable/)
    assert.equal(await auditCount('cloudflare_delete_failed'), 1)
    assert.equal(await auditCount('domain_deleted'), 0)
    // Provider events leave a domain the owner asked to delete alone.
    assert.equal((await deliverWebhook(notification())).status, 204)
    assert.equal(events.take('domain.check_requested'), undefined)
    providerMode = 'delete-success'
    await deleteCustomDomain(dashboardEnv, db, customId, 'system')
    assert.equal((await db.prepare("SELECT status FROM organization_domains WHERE id=?").bind(customId).first())?.status, 'deleted')
    // The deletion and its audit row commit together.
    assert.ok((await listDashboardEvents(db, 'audit', {})).events.some(event => event.event_name === 'domain_deleted'))
    assert.equal((await listDashboardEvents(db, 'other', {})).events.length, 0)
    await db.prepare(`INSERT INTO organization_domains(id,organization_id,domain,type,role,status,cloudflare_hostname_id,validation_strategy)
      VALUES ('apex','audit','pair.example.test','custom','secondary','verifying','apex-provider','txt_manual'),
      ('www','audit','www.pair.example.test','custom','canonical','verifying','www-provider','http_auto')`).run()
    const www = (await getOrganizationDomains(db, 'audit')).find(row => row.id === 'www')
    assert.ok(www)
    providerMode = 'activate'
    await checkDashboardDomainGroup(dashboardEnv, db, actor, www)
    assert.deepEqual(checkedHostnames, [])
    await events.runNext(dashboardEnv, 'domain.check_requested')
    assert.deepEqual(checkedHostnames.sort(), ['apex-provider', 'www-provider'])
    const [group] = groupCustomDomains(await getOrganizationDomains(db, 'audit'))
    assert.equal(group?.status, 'active')
    assert.deepEqual(group?.domains.map(row => row.dns_status), ['valid', 'valid'])

    // The audit trail belongs to the organization it describes: deleting the
    // organization takes its entries with it rather than stranding them.
    await db.prepare("DELETE FROM organization WHERE id='audit'").run()
    assert.equal((await db.prepare("SELECT count(*) AS n FROM activity_entries WHERE organization_id='audit'").first())?.n, 0)
  } finally { await miniflare.dispose() }
})
