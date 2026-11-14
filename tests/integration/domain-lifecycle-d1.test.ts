import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { createSystemSubdomain, isSystemSubdomainSpent, ensureDomainAvailable, reconcileDueDomains, syncDomainWithCloudflare, deleteCustomDomain } from '../../server/utils/domains.ts'
import { listDashboardEvents } from '../../server/utils/dashboard-events.ts'
import { checkDashboardDomainGroup, connectDashboardDomain } from '../../server/utils/domain-dashboard-actions.ts'
import { getOrganizationDomains, groupCustomDomains } from '../../server/utils/domain-read-model.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

test('a stale domain result changes nothing and permanent subdomain reservations survive organization deletion', async (t) => {
  const miniflare = new Miniflare({ workers: [{ config: { name: 'owner-domain-test', compatibilityDate: '2024-11-01', manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } }, env: { DB: { type: 'd1' } } } }] })
  try {
    const db = await miniflare.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
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
    await db.prepare("INSERT INTO organization_domains(id,organization_id,domain,type,status) VALUES('custom','audit','custom.example.test','custom','pending')").run()
    await db.prepare("INSERT INTO subscription (id, plan, referenceId, status) VALUES ('sub-audit', 'growth', 'audit', 'active')").run()
    let requestsMade = 0
    let providerMode: 'pending' | 'stale' | 'delete-failed' | 'delete-success' | 'activate' | 'live-cutover' = 'pending'
    const checkedHostnames: string[] = []
    let zarazConfig: unknown = { tools: {}, triggers: {}, settings: { ecommerce: true } }
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (providerMode === 'live-cutover') {
        const request = new URL(String(url))
        assert.equal(request.hostname, 'cloudflare-dns.com')
        return Response.json({ Status: 0, Answer: request.searchParams.get('name') === 'live.example.org' && request.searchParams.get('type') === 'A' ? [{ type: 1, data: '192.0.2.17' }] : [] })
      }
      if (providerMode === 'activate') {
        const request = new URL(String(url))
        if (request.hostname === 'cloudflare-dns.com') return Response.json({ Status: 0, Answer: request.searchParams.get('type') === 'CNAME' ? [{ type: 5, data: 'target.example.test.' }] : [] })
        if (request.pathname.endsWith('/settings/zaraz/config')) {
          if (init?.method === 'PUT') zarazConfig = JSON.parse(String(init.body))
          return Response.json({ success: true, result: zarazConfig })
        }
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
      if (providerMode === 'stale') await db.prepare("UPDATE organization_domains SET status='disabled' WHERE id='custom'").run()
      if (providerMode === 'delete-failed') return Response.json({ success: false, errors: [{ message: 'provider unavailable' }] }, { status: 503 })
      if (providerMode === 'delete-success') { assert.equal(init?.method, 'DELETE'); return Response.json({ success: true, result: {} }) }
      return Response.json({ success: true, result: { id: 'provider-id', hostname: 'custom.example.test', status: 'pending', ssl: { status: 'pending_validation' } } })
    })
    providerMode = 'live-cutover'
    const dashboardEnv = { ...env, DB: db, CLOUDFLARE_API_TOKEN: 'test', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://provider.example.test',
      BETTER_AUTH_URL: 'https://provider.example.test', BETTER_AUTH_SECRET: 'fixture-domain-auth-secret-long-enough', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
    } as CloudflareEnv
    await assert.rejects(connectDashboardDomain(dashboardEnv, db,
      { organizationId: 'audit', organizationSlug: 'audit', actorId: 'operator', actorType: 'owner' }, 'live.example.org', true, false), {
      status: 409, data: {
        code: 'DOMAIN_LIVE_CUTOVER',
        live_cutover_warning: {
          hostname: 'live.example.org', records: [{ type: 'A', value: '192.0.2.17' }],
          message: 'live.example.org currently points elsewhere and may be live. Changing DNS can take it offline until KrabiClaw validation finishes.',
        },
      },
    })
    assert.deepEqual((await getOrganizationDomains(db, 'audit')).map(domain => domain.domain), ['custom.example.test'])
    providerMode = 'pending'
    assert.deepEqual(await reconcileDueDomains(env, db), { checked: 1, failed: 0 })
    assert.equal(requestsMade, 1)
    assert.equal((await db.prepare("SELECT status FROM organization_domains WHERE id='custom'").first())?.status, 'verifying')
    const auditCount = async (eventName: string) => (await db.prepare("SELECT count(*) AS n FROM activity_entries WHERE organization_id='audit' AND event_name=?").bind(eventName).first())?.n
    assert.equal(await auditCount('domain_state_changed'), 1)
    providerMode = 'stale'
    await db.prepare("UPDATE organization_domains SET cloudflare_hostname_id=NULL WHERE id='custom'").run()
    await assert.rejects(syncDomainWithCloudflare(env, db, 'custom'))
    assert.equal((await db.prepare("SELECT status FROM organization_domains WHERE id='custom'").first())?.status, 'disabled')
    // The superseded reconciliation changed nothing, so it recorded nothing.
    assert.equal(await auditCount('domain_state_changed'), 1)
    await db.prepare("UPDATE organization_domains SET status='verifying',cloudflare_hostname_id='provider-id' WHERE id='custom'").run()
    providerMode = 'delete-failed'
    await assert.rejects(deleteCustomDomain(env, db, 'custom', 'system'))
    const failedDelete = await db.prepare("SELECT desired_state,status,error_message FROM organization_domains WHERE id='custom'").first()
    assert.equal(failedDelete?.desired_state, 'deleted')
    assert.equal(failedDelete?.status, 'verifying', 'a hostname Cloudflare still routes is not marked deleted here')
    assert.match(String(failedDelete?.error_message), /provider unavailable/)
    assert.equal(await auditCount('cloudflare_delete_failed'), 1)
    assert.equal(await auditCount('domain_deleted'), 0)
    // The scheduled check leaves a domain the owner asked to delete alone; deleting again asks Cloudflare again.
    assert.deepEqual(await reconcileDueDomains(env, db), { checked: 0, failed: 0 })
    providerMode = 'delete-success'
    await deleteCustomDomain(env, db, 'custom', 'system')
    assert.equal((await db.prepare("SELECT status FROM organization_domains WHERE id='custom'").first())?.status, 'deleted')
    // The deletion and its audit row commit together.
    assert.ok((await listDashboardEvents(db, 'audit', {})).events.some(event => event.event_name === 'domain_deleted'))
    assert.equal((await listDashboardEvents(db, 'other', {})).events.length, 0)
    await db.prepare(`INSERT INTO organization_domains(id,organization_id,domain,type,role,status,cloudflare_hostname_id,validation_strategy)
      VALUES ('apex','audit','pair.example.test','custom','secondary','verifying','apex-provider','txt_manual'),
      ('www','audit','www.pair.example.test','custom','canonical','verifying','www-provider','http_auto')`).run()
    const www = (await getOrganizationDomains(db, 'audit')).find(row => row.id === 'www')
    assert.ok(www)
    providerMode = 'activate'
    await checkDashboardDomainGroup(dashboardEnv, db,
      { organizationId: 'audit', organizationSlug: 'audit', actorId: 'operator', actorType: 'owner' }, www)
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
