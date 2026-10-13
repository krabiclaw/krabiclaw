import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import organizationQaRoute from '../../server/api/editor/organizations/[organizationId]/qa.get.ts'
import { createQa, deleteQa, listQa, reorderQa, updateQa } from '../../server/utils/location-qa.ts'
import { createContentDocumentWithBlocks } from '../../server/utils/content/documents.ts'
import { getMediaAsset, updateMediaAssetMetadata } from '../../server/utils/media-asset-manager.ts'

const ORG = 'org'
const OTHER_ORG = 'other-org'
const NOW = '2026-09-28T00:00:00.000Z'

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'location-qa-media-metadata-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  await db.batch(statements.map(statement => db.prepare(statement)))
  for (const org of [ORG, OTHER_ORG]) {
    await db.prepare(`INSERT INTO organization (id, name, slug, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', ?, '{}', 'saya-theme-v1', 'THB', 'active', 'complete', 'flat', 'restaurant', ?, 'Asia/Bangkok')`).bind(org, org, NOW).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, 'en', 1, 'published')")
      .bind(`locale-${org}`, org).run()
  }
  return { runtime, db }
}

test('organization Q&A route finds a page record by id without widening tenant access', async () => {
  const { runtime, db } = await boot()
  try {
    const password = 'LocalQaRouteProof123!'
    await db.prepare("INSERT INTO user (id, name, email, emailVerified) VALUES ('qa-owner', 'QA Owner', 'qa-owner@proof.example', 1)").run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES ('qa-member', ?, 'qa-owner', 'owner')").bind(ORG).run()
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password) VALUES ('qa-credential', 'qa-owner', 'credential', 'qa-owner', ?)").bind(await hashPassword(password)).run()
    const general = await createQa(db, { organizationId: ORG, locationId: null }, { question: 'General question', answer: 'General answer' })
    const pricing = await createQa(db, { organizationId: ORG, locationId: null, pagePath: '/pricing' }, { question: 'Pricing question', answer: 'Pricing answer' })
    const other = await createQa(db, { organizationId: OTHER_ORG, locationId: null, pagePath: '/pricing' }, { question: 'Other tenant question', answer: 'Private answer' })
    const generalId = (general.data as { id: string }).id
    const pricingId = (pricing.data as { id: string }).id
    const otherId = (other.data as { id: string }).id
    const env = {
      DB: db, BETTER_AUTH_SECRET: 'local-qa-route-proof-secret-long-enough-for-auth',
      BETTER_AUTH_URL: 'https://proof.example', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example',
      STRIPE_SECRET_KEY: 'sk_test_local_qa_route_no_provider_requests',
      EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
    } as CloudflareEnv
    const login = await createAuth(env).api.signInEmail({ body: { email: 'qa-owner@proof.example', password }, asResponse: true })
    assert.equal(login.status, 200)
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const app = new H3()
    app.get('/api/editor/organizations/:organizationId/qa', organizationQaRoute)
    const request = (org: string, query = '', authenticated = true) => app.request(Object.assign(new Request(`https://proof.example/api/editor/organizations/${org}/qa${query}`, {
      headers: authenticated ? { cookie } : {},
    }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))

    const found = await request(ORG, `?id=${pricingId}`)
    assert.equal(found.status, 200)
    const { qa } = await found.json() as { qa: Array<{ id: string; page_path: string; answer: string }> }
    assert.deepEqual(qa.map(row => row.id), [pricingId])
    assert.equal(qa[0]?.page_path, '/pricing')
    assert.equal(qa[0]?.answer, 'Pricing answer')
    assert.deepEqual((await (await request(ORG)).json()).qa.map((row: { id: string }) => row.id), [generalId])
    assert.deepEqual((await (await request(ORG, '?page_path=%2Fpricing')).json()).qa.map((row: { id: string }) => row.id), [pricingId])
    for (const id of [otherId, 'unknown-qa-id']) {
      const response = await request(ORG, `?id=${id}`)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { qa: [] })
    }
    assert.equal((await request(OTHER_ORG, `?id=${otherId}`)).status, 404)
    assert.equal((await request(ORG, `?id=${pricingId}`, false)).status, 401)
  } finally {
    await runtime.dispose()
  }
})

// Both writers bound one value more than their SQL had placeholders, which D1
// refuses; every Q&A edit answered 400 and every alt-text edit 500 on
// production. The proof is the real function against real D1: a mocked
// database accepts any bind count.
test('a Q&A can be edited and deleted through the scoped writers', async () => {
  const { runtime, db } = await boot()
  try {
    const scope = { organizationId: ORG, locationId: null, pagePath: '/pricing' }
    const created = await createQa(db, scope, { question: 'Is there a free plan?', answer: 'Yes.', status: 'published' })
    assert.equal(created.status, 201)
    const qaId = (created.data as { id: string }).id

    const updated = await updateQa(db, scope, qaId, { answer: 'Yes, on a Krabiclaw subdomain.' })
    assert.deepEqual(updated, { updated: true, qa_id: qaId })
    const [row] = await listQa(db, ORG, null, false, '/pricing')
    assert.equal(row?.answer, 'Yes, on a Krabiclaw subdomain.')
    const purges = async () => Number((await db.prepare("SELECT count(*) AS n FROM public_resource_cache_invalidations WHERE organization_id = ? AND reason IN ('qa-update', 'qa-reorder')").bind(ORG).first('n')) ?? 0)
    assert.equal(await purges(), 1, 'an edited answer queues a purge of the cached pages')

    await assert.rejects(
      updateQa(db, { ...scope, organizationId: OTHER_ORG }, qaId, { answer: 'stolen' }),
      /Q&A not found/,
    )

    const second = await createQa(db, scope, { question: 'Can I use my own domain?', answer: 'Yes.' })
    const secondId = (second.data as { id: string }).id
    await reorderQa(db, scope, [{ id: secondId, sort_order: 0 }, { id: qaId, sort_order: 1 }])
    assert.deepEqual((await listQa(db, ORG, null, false, '/pricing')).map(item => item.id), [secondId, qaId])
    assert.equal(await purges(), 2, 'a reorder queues a purge too')
    await deleteQa(db, scope, secondId)

    const deletedElsewhere = await deleteQa(db, { ...scope, organizationId: OTHER_ORG }, qaId)
    assert.equal(deletedElsewhere.status, 404)
    const deleted = await deleteQa(db, scope, qaId)
    assert.equal(deleted.status, 200)
    assert.equal((await listQa(db, ORG, null, false, '/pricing')).length, 0)
  } finally {
    await runtime.dispose()
  }
})

test('media metadata is updated only within its organization', async () => {
  const { runtime, db } = await boot()
  try {
    await db.prepare(`INSERT INTO media_assets (id, organization_id, kind, provider, source, public_url, mime_type, alt_text, status, created_at, updated_at)
      VALUES ('asset-1', ?, 'image', 'cloudflare_images', 'uploaded', 'https://imagedelivery.net/acct/asset-1/public', 'image/png', 'KrabiClaw crab', 'active', ?, ?)`)
      .bind(ORG, NOW, NOW).run()

    assert.equal(await updateMediaAssetMetadata(db, 'asset-1', OTHER_ORG, { alt_text: 'stolen' }), false)
    assert.equal(await updateMediaAssetMetadata(db, 'asset-1', ORG, { alt_text: 'Krabiclaw crab' }), true)
    assert.equal((await getMediaAsset(db, 'asset-1', ORG))?.alt_text, 'Krabiclaw crab')
  } finally {
    await runtime.dispose()
  }
})


test('authored Q&A validation is shared and mixed imported reorders are atomic', async () => {
  const { runtime, db } = await boot()
  const scope = { organizationId: ORG, locationId: null, pagePath: '/pricing' }
  try {
    const authored = await createQa(db, scope, { question: '  Authored question  ', answer: '  Original answer  ', sort_order: 4 })
    const imported = await createQa(db, scope, { question: 'Imported fixture', sort_order: 7 })
    await db.prepare("UPDATE content_documents SET source = 'import' WHERE id = ?").bind(imported.data.id).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('qa-locale-ja', ?, 'ja', 0, 'published')").bind(ORG).run()
    await createContentDocumentWithBlocks(db, {
      id: 'qa-translation', rowRole: 'representation', rootId: authored.data.id, kind: 'qa', locale: 'ja',
      organizationId: ORG, title: 'Translated question', summary: 'Translated answer',
    }, [])
    const before = await listQa(db, ORG, null, false, '/pricing')
    assert.equal(before.find(row => row.id === authored.data.id)?.question, 'Authored question')
    for (const [input, expected] of [
      [{ question: '' }, /question required/],
      [{ question: 'q'.repeat(501) }, /500 characters/],
      [{ sort_order: '3' }, /sort_order must be an integer/],
      [{ is_owner_answer: 1 }, /is_owner_answer must be a boolean/],
      [{ answer: 123 }, /answer must be a string or null/],
      [{ status: 'draft' }, /Invalid Q&A status/],
    ] as const) {
      await assert.rejects(createQa(db, scope, { question: 'Valid', ...input }), expected)
      await assert.rejects(updateQa(db, scope, authored.data.id, input), expected)
    }
    await assert.rejects(reorderQa(db, scope, [{ id: authored.data.id, sort_order: 0 }, { id: imported.data.id, sort_order: 1 }]), /outside the requested scope/)
    assert.deepEqual(await listQa(db, ORG, null, false, '/pricing'), before)
    // Exercise the zero-write conflict result on actual D1 without changing any Q&A.
    await db.prepare("CREATE TRIGGER skip_qa_reorder BEFORE UPDATE OF sort_order ON content_documents WHEN OLD.kind = 'qa' BEGIN SELECT RAISE(IGNORE); END").run()
    try {
      await assert.rejects(reorderQa(db, scope, [{ id: authored.data.id, sort_order: 0 }]),
        { status: 409, statusText: 'Q&A reorder changed concurrently. Reload and try again.' })
      assert.deepEqual(await listQa(db, ORG, null, false, '/pricing'), before)
    } finally {
      await db.prepare('DROP TRIGGER skip_qa_reorder').run()
    }

    await assert.rejects(updateQa(db, scope, imported.data.id, { answer: 'Overwrite' }), /Q&A not found/)
    assert.equal((await deleteQa(db, scope, imported.data.id)).status, 404)
    await assert.rejects(createQa(db, { ...scope, locationId: 'foreign-location', pagePath: null }, { question: 'Wrong tenant' }), /Q&A scope not found/)
    await assert.rejects(createQa(db, { ...scope, locationId: 'foreign-location' }, { question: 'Ambiguous scope' }), /not both/)
    await updateQa(db, scope, authored.data.id, { answer: null, is_owner_answer: false })
    const changed = (await listQa(db, ORG, null, false, '/pricing')).find(row => row.id === authored.data.id)
    assert.equal(changed?.answer, null)
    assert.equal(changed?.is_owner_answer, 0)
    assert.equal(changed?.question, 'Authored question')
    assert.equal((await listQa(db, ORG, null, false, '/pricing', 'ja'))[0]?.answer, 'Translated answer')
    await deleteQa(db, scope, authored.data.id)
    assert.equal(await db.prepare('SELECT count(*) n FROM content_documents WHERE id = ? OR root_id = ?').bind(authored.data.id, authored.data.id).first('n'), 0)
    assert.equal((await listQa(db, ORG, null, false, '/pricing'))[0]?.source, 'import')
  } finally { await runtime.dispose() }
})
