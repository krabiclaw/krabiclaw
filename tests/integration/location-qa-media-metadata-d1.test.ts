import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import organizationQaRoute from '../../server/api/editor/organizations/[organizationId]/qa.get.ts'
import createOrganizationQaRoute from '../../server/api/editor/organizations/[organizationId]/qa.post.ts'
import updateOrganizationQaRoute from '../../server/api/editor/organizations/[organizationId]/qa/[qaId].patch.ts'
import reorderOrganizationQaRoute from '../../server/api/editor/organizations/[organizationId]/qa/reorder.post.ts'
import reorderLocationQaRoute from '../../server/api/editor/organizations/[organizationId]/locations/[locationId]/qa/reorder.post.ts'
import { handleQaTools } from '../../server/utils/mcp-tools/qa.ts'
import type { McpExecutorContext } from '../../server/utils/mcp-tools/execution.ts'
import { createQa, deleteQa, listQa, reorderQa, updateQa } from '../../server/utils/location-qa.ts'
import { createContentDocumentWithBlocks } from '../../server/utils/content/documents.ts'
import { getMediaAsset, updateMediaAssetMetadata } from '../../server/utils/media-asset-manager.ts'
import { applyOnboardingDraft } from '../../server/utils/onboarding-apply.ts'
import { buildOnboardingDraftPayload, onboardingDraftWriteGuard, readOnboardingDraft, upsertActiveOnboardingDraft } from '../../server/utils/onboarding-drafts.ts'
import { createLocation, getLocation, updateLocation } from '../../server/utils/location-management.ts'

const ORG = 'org'
const OTHER_ORG = 'other-org'
const NOW = '2026-09-28T00:00:00.000Z'

async function boot() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'location-qa-media-metadata-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
  await db.batch(statements.map(statement => db.prepare(statement)))
  for (const org of [ORG, OTHER_ORG]) {
    await db.prepare(`INSERT INTO organization (id, name, slug, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', ?, '{}', 'tenant-theme-v1', 'THB', 'active', 'complete', 'flat', 'restaurant', ?, 'Asia/Bangkok')`).bind(org, org, NOW).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, 'en', 1, 'published')")
      .bind(`locale-${org}`, org).run()
  }
  return { runtime, db }
}

test('resuming onboarding updates the existing location without changing its historical public path', async () => {
  const { runtime, db } = await boot()
  try {
    const userId = 'onboarding-owner'
    await db.prepare("INSERT INTO user (id, name, email, emailVerified) VALUES (?, 'Owner', 'onboarding@proof.example', 1)").bind(userId).run()
    await db.prepare("UPDATE organization SET onboarding_status = 'pending' WHERE id = ?").bind(ORG).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, timezone)
      VALUES ('historic-location', ?, 'original-restaurant', 'Original Restaurant', 'Asia/Bangkok')`).bind(ORG).run()
    const payload = buildOnboardingDraftPayload({
      name: 'Renamed Restaurant', vertical: 'restaurant', place: null,
      details: {
        name: 'Renamed Restaurant', streetAddress: '88 Beach Road', addressLine2: null, city: 'Ao Nang', region: null, postalCode: null,
        country: 'TH', phone: null, websiteUrl: null, openingHours: null, specialHours: null,
        timezone: 'Asia/Bangkok', currency: 'THB', sourceLocale: 'en',
      },
    })
    const draft = { id: 'onboarding-draft', user_id: userId, updated_at: NOW }
    await db.prepare(`INSERT INTO onboarding_drafts (id, user_id, organization_id, name, vertical, source_type, payload_json, updated_at)
      VALUES (?, ?, ?, ?, 'restaurant', 'manual', ?, ?)`).bind(draft.id, userId, ORG, payload.preview.brandName, JSON.stringify(payload), NOW).run()
    assert.equal(payload.preview.locations[0]?.slug, 'main')
    const env = { ...await runtime.getBindings<CloudflareEnv>(), DB: db } as CloudflareEnv
    const result = await applyOnboardingDraft(env, db, {
      userId, draft, payload,
      target: { vertical: 'restaurant', organizationId: ORG, subdomain: 'org', locationId: 'historic-location', locationSlug: 'original-restaurant', defaultCurrency: 'THB', timezone: 'Asia/Bangkok' },
    })
    assert.deepEqual(result, { locationSlug: 'original-restaurant' })
    const saved = await db.prepare('SELECT id, slug, title, address FROM business_locations WHERE organization_id = ?').bind(ORG).all<{ id: string; slug: string; title: string; address: string }>()
    assert.equal(saved.results.length, 1)
    assert.deepEqual({ ...saved.results[0], address: JSON.parse(saved.results[0]!.address) }, {
      id: 'historic-location', slug: 'original-restaurant', title: 'Renamed Restaurant',
      address: { regionCode: 'TH', addressLines: ['88 Beach Road'], locality: 'Ao Nang' },
    })
    const location = await getLocation(db, ORG, 'historic-location')
    assert.ok(location)
    const beforeNoop = await db.prepare("SELECT id, payload_json FROM activity_entries WHERE organization_id = ? AND event_name = 'location.updated' ORDER BY id").bind(ORG).all()
    const purgesBefore = await db.prepare("SELECT count(*) AS n FROM public_resource_cache_invalidations WHERE organization_id = ? AND reason = 'write-through-purge'").bind(ORG).first<number>('n')
    assert.ok(purgesBefore !== null)
    const unchangedInput = { phone: location.phone, expected_updated_at: location.updated_at }
    const guard = onboardingDraftWriteGuard(draft, ORG)
    assert.equal((await updateLocation(db, ORG, location.id, unchangedInput, userId, env, guard)).status, 200)
    assert.deepEqual(await getLocation(db, ORG, location.id), location)
    assert.equal(await db.prepare("SELECT count(*) AS n FROM public_resource_cache_invalidations WHERE organization_id = ? AND reason = 'write-through-purge'").bind(ORG).first('n'), purgesBefore + 1,
      'a current guarded no-op completes its public cache purge')

    const revised = await upsertActiveOnboardingDraft(db, {
      userId, draftId: draft.id, name: payload.preview.brandName, vertical: 'restaurant', sourceType: 'manual', payload, expectedUpdatedAt: draft.updated_at,
    })
    const currentDraft = await readOnboardingDraft(db, userId, draft.id)
    assert.equal(currentDraft.row.updated_at, revised.updatedAt)
    assert.notEqual(currentDraft.row.updated_at, draft.updated_at)
    await assert.rejects(updateLocation(db, ORG, location.id, unchangedInput, userId, env, guard), /malformed JSON/)
    assert.deepEqual(await getLocation(db, ORG, location.id), location)
    assert.deepEqual((await db.prepare("SELECT id, payload_json FROM activity_entries WHERE organization_id = ? AND event_name = 'location.updated' ORDER BY id").bind(ORG).all()).results, beforeNoop.results)
    assert.equal(await db.prepare("SELECT count(*) AS n FROM public_resource_cache_invalidations WHERE organization_id = ? AND reason = 'write-through-purge'").bind(ORG).first('n'), purgesBefore + 1,
      'a stale guarded no-op runs no public cache completion')

    assert.equal((await updateLocation(db, ORG, location.id, unchangedInput, userId, env, onboardingDraftWriteGuard(currentDraft.row, ORG))).status, 200)
    assert.deepEqual(await getLocation(db, ORG, location.id), location)
    assert.equal(await db.prepare("SELECT count(*) AS n FROM public_resource_cache_invalidations WHERE organization_id = ? AND reason = 'write-through-purge'").bind(ORG).first('n'), purgesBefore + 2)
    assert.deepEqual((await db.prepare("SELECT id, payload_json FROM activity_entries WHERE organization_id = ? AND event_name = 'location.updated' ORDER BY id").bind(ORG).all()).results, beforeNoop.results)
  } finally { await runtime.dispose() }
})

test('organization Q&A route finds a page record by id without widening tenant access', async () => {
  const { runtime, db } = await boot()
  try {
    const password = 'LocalQaRouteProof123!'
    await db.prepare("INSERT INTO user (id, name, email, emailVerified) VALUES ('qa-owner', 'QA Owner', 'qa-owner@proof.example', 1)").run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES ('qa-member', ?, 'qa-owner', 'owner')").bind(ORG).run()
    await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password) VALUES ('qa-credential', 'qa-owner', 'credential', 'qa-owner', ?)").bind(await hashPassword(password)).run()
    const general = await createQa(db, { organizationId: ORG, locationId: null }, { question: 'General question', answer: 'General answer' }, null)
    const pricing = await createQa(db, { organizationId: ORG, locationId: null, pagePath: '/pricing' }, { question: 'Pricing question', answer: 'Pricing answer' }, null)
    const other = await createQa(db, { organizationId: OTHER_ORG, locationId: null, pagePath: '/pricing' }, { question: 'Other tenant question', answer: 'Private answer' }, null)
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
    app.post('/api/editor/organizations/:organizationId/qa', createOrganizationQaRoute)
    app.patch('/api/editor/organizations/:organizationId/qa/:qaId', updateOrganizationQaRoute)
    app.post('/api/editor/organizations/:organizationId/qa/reorder', reorderOrganizationQaRoute)
    app.post('/api/editor/organizations/:organizationId/locations/:locationId/qa/reorder', reorderLocationQaRoute)
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
    const mutate = (path: string, method: string, body: unknown) => app.request(Object.assign(new Request(`https://proof.example/api/editor/organizations/${ORG}/qa${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    const createdResponse = await mutate('', 'POST', { question: 'Who answers?', answer: 'The legal team.', page_path: '/pricing', created_by: 'spoofed-user' })
    assert.equal(createdResponse.status, 201)
    const createdId = (await createdResponse.json() as { id: string }).id
    const createdRow = await db.prepare('SELECT created_by, updated_by, updated_at FROM content_documents WHERE id = ?').bind(createdId).first<{ created_by: string; updated_by: string; updated_at: string }>()
    assert.equal(createdRow?.created_by, 'qa-owner')
    assert.equal(createdRow?.updated_by, 'qa-owner')
    const readCreated = (await (await request(ORG, `?id=${createdId}`)).json()).qa[0]
    assert.equal(readCreated.answer_author, 'QA Owner')
    assert.match(readCreated.answer_date, /^\d{4}-\d{2}-\d{2}T/)
    const changed = await mutate(`/${createdId}`, 'PATCH', { answer: 'An attorney answers.', page_path: '/pricing', updated_by: 'spoofed-user' })
    assert.equal(changed.status, 200)
    const readChanged = (await (await request(ORG, `?id=${createdId}`)).json()).qa[0]
    assert.equal(readChanged.answer, 'An attorney answers.')
    assert.equal(readChanged.answer_author, 'QA Owner')
    assert.notEqual(readChanged.answer_date, readCreated.answer_date)
    const beforeRepeat = await db.prepare('SELECT updated_at FROM content_documents WHERE id = ?').bind(createdId).first('updated_at')
    const repeat = await mutate(`/${createdId}`, 'PATCH', { answer: 'An attorney answers.', page_path: '/pricing' })
    assert.equal(repeat.status, 200)
    assert.deepEqual(await repeat.json(), { updated: false, qa_id: createdId })
    assert.equal(await db.prepare('SELECT updated_at FROM content_documents WHERE id = ?').bind(createdId).first('updated_at'), beforeRepeat)
    const receipts = await db.prepare("SELECT actor_user_id, payload_json FROM activity_entries WHERE event_name = 'content.updated' AND json_extract(payload_json, '$.entityId') = ? ORDER BY occurred_at").bind(createdId).all<{ actor_user_id: string; payload_json: string }>()
    assert.equal(receipts.results.length, 2)
    assert.ok(receipts.results.every(entry => entry.actor_user_id === 'qa-owner'))
    assert.deepEqual(JSON.parse(receipts.results[1]!.payload_json).metadata.changed_fields, ['answer'])
    assert.deepEqual(JSON.parse(receipts.results[0]!.payload_json).afterState, { updated_at: createdRow!.updated_at, status: 'published' })
    assert.deepEqual(JSON.parse(receipts.results[1]!.payload_json).afterState, { updated_at: readChanged.updated_at, status: 'published' })
    const hidden = await mutate(`/${createdId}`, 'PATCH', { status: 'hidden', page_path: '/pricing' })
    assert.equal(hidden.status, 200)
    const hiddenRow = (await (await request(ORG, `?id=${createdId}`)).json()).qa[0]
    assert.equal(hiddenRow.status, 'hidden')
    const statusReceipt = await db.prepare("SELECT payload_json FROM activity_entries WHERE event_name = 'content.updated' AND json_extract(payload_json, '$.entityId') = ? ORDER BY occurred_at DESC, id DESC LIMIT 1").bind(createdId).first<string>('payload_json')
    const statusPayload = JSON.parse(statusReceipt!)
    assert.deepEqual(statusPayload.metadata.changed_fields, ['status'])
    assert.deepEqual(statusPayload.afterState, { updated_at: hiddenRow.updated_at, status: 'hidden' })
    const order = [{ id: pricingId, sort_order: 10 }, { id: createdId, sort_order: 11 }]
    const beforeOrder = await listQa(db, ORG, null, false, '/pricing')
    const reordered = await mutate('/reorder', 'POST', { page_path: '/pricing', updates: order, updated_by: 'spoofed-user' })
    assert.equal(reordered.status, 200)
    assert.deepEqual(await reordered.json(), { updated: 2 })
    const ordered = (await (await request(ORG, '?page_path=%2Fpricing')).json()).qa as Array<{ id: string; sort_order: number; updated_at: string; status: string }>
    assert.deepEqual(ordered.map(row => ({ id: row.id, sort_order: row.sort_order })), order)
    for (const row of ordered) {
      assert.equal(await db.prepare('SELECT updated_by FROM content_documents WHERE id = ?').bind(row.id).first('updated_by'), 'qa-owner')
      const previous = beforeOrder.find(item => item.id === row.id)!
      assert.notEqual(row.updated_at, previous.updated_at)
      const receipt = JSON.parse((await db.prepare("SELECT payload_json FROM activity_entries WHERE event_name='content.updated' AND json_extract(payload_json,'$.entityId')=? ORDER BY occurred_at DESC,id DESC LIMIT 1").bind(row.id).first<string>('payload_json'))!)
      assert.deepEqual(receipt.metadata.changed_fields, ['sort_order'])
      assert.deepEqual(receipt.beforeState, { updated_at: previous.updated_at, status: previous.status, sort_order: previous.sort_order })
      assert.deepEqual(receipt.afterState, { updated_at: row.updated_at, status: row.status, sort_order: row.sort_order })
    }
    const auditCount = () => db.prepare("SELECT count(*) FROM activity_entries WHERE organization_id=? AND event_name='content.updated'").bind(ORG).first<number>('count(*)')
    const afterOrderAuditCount = await auditCount()
    const repeatOrder = await mutate('/reorder', 'POST', { page_path: '/pricing', updates: order })
    assert.equal(repeatOrder.status, 200)
    assert.deepEqual(await repeatOrder.json(), { updated: 0 })
    assert.deepEqual(await listQa(db, ORG, null, false, '/pricing'), ordered)
    assert.equal(await auditCount(), afterOrderAuditCount)
    const mcpOrder = await handleQaTools({ toolName: 'reorder_qa', args: { page_path: '/pricing', updates: [{ id: pricingId, sort_order: 12 }] },
      organization: { db, env, organizationId: ORG, userId: 'qa-owner', role: 'owner', isPlatformAdmin: false, scopes: ['tenant'],
        membership: { id: 'qa-member', organizationId: ORG, userId: 'qa-owner', role: 'owner' } },
    } as McpExecutorContext)
    assert.deepEqual(mcpOrder, { updated: 1 })
    assert.equal((await (await request(ORG, `?id=${pricingId}`)).json()).qa[0].sort_order, 12)
    const mcpActor = await db.prepare("SELECT actor_user_id FROM activity_entries WHERE event_name='content.updated' AND json_extract(payload_json,'$.entityId')=? ORDER BY occurred_at DESC,id DESC LIMIT 1").bind(pricingId).first('actor_user_id')
    assert.equal(mcpActor, 'qa-owner')
    await db.prepare("INSERT INTO business_locations (id,organization_id,slug,title,timezone) VALUES ('qa-office',?,'office','Office','Asia/Bangkok')").bind(ORG).run()
    const locationQa = await createQa(db, { organizationId: ORG, locationId: 'qa-office' }, { question: 'Where is the office?', sort_order: 3 }, null)
    const locationOrder = await app.request(Object.assign(new Request(`https://proof.example/api/editor/organizations/${ORG}/locations/qa-office/qa/reorder`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ updates: [{ id: locationQa.data.id, sort_order: 0 }], updated_by: 'spoofed-user' }),
    }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    assert.equal(locationOrder.status, 200)
    assert.deepEqual(await locationOrder.json(), { updated: 1 })
    assert.equal((await listQa(db, ORG, 'qa-office'))[0]?.sort_order, 0)
    assert.equal(await db.prepare('SELECT updated_by FROM content_documents WHERE id=?').bind(locationQa.data.id).first('updated_by'), 'qa-owner')
    const locationActor = await db.prepare("SELECT actor_user_id FROM activity_entries WHERE location_id='qa-office' AND event_name='content.updated' ORDER BY occurred_at DESC,id DESC LIMIT 1").first('actor_user_id')
    assert.equal(locationActor, 'qa-owner')
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
    const created = await createQa(db, scope, { question: 'Is there a free plan?', answer: 'Yes.', status: 'published' }, null)
    assert.equal(created.status, 201)
    const qaId = (created.data as { id: string }).id

    const updated = await updateQa(db, scope, qaId, { answer: 'Yes, on a KrabiClaw subdomain.' }, null)
    assert.deepEqual(updated, { updated: true, qa_id: qaId })
    const [row] = await listQa(db, ORG, null, false, '/pricing')
    assert.equal(row?.answer, 'Yes, on a KrabiClaw subdomain.')
    const purges = async () => Number((await db.prepare("SELECT count(*) AS n FROM public_resource_cache_invalidations WHERE organization_id = ? AND reason IN ('qa-update', 'qa-reorder')").bind(ORG).first('n')) ?? 0)
    assert.equal(await purges(), 1, 'an edited answer queues a purge of the cached pages')

    await assert.rejects(
      updateQa(db, { ...scope, organizationId: OTHER_ORG }, qaId, { answer: 'stolen' }, null),
      /Q&A not found/,
    )

    const second = await createQa(db, scope, { question: 'Can I use my own domain?', answer: 'Yes.' }, null)
    const secondId = (second.data as { id: string }).id
    await reorderQa(db, scope, [{ id: secondId, sort_order: 0 }, { id: qaId, sort_order: 1 }], null)
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
    assert.equal(await updateMediaAssetMetadata(db, 'asset-1', ORG, { alt_text: 'KrabiClaw crab' }), true)
    assert.equal((await getMediaAsset(db, 'asset-1', ORG))?.alt_text, 'KrabiClaw crab')
  } finally {
    await runtime.dispose()
  }
})


test('authored Q&A validation is shared and mixed imported reorders are atomic', async () => {
  const { runtime, db } = await boot()
  const scope = { organizationId: ORG, locationId: null, pagePath: '/pricing' }
  try {
    const authored = await createQa(db, scope, { question: '  Authored question  ', answer: '  Original answer  ', sort_order: 4 }, null)
    const secondAuthored = await createQa(db, scope, { question: 'Second authored question', sort_order: 9 }, null)
    const imported = await createQa(db, scope, { question: 'Imported fixture', sort_order: 7 }, null)
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
      await assert.rejects(createQa(db, scope, { question: 'Valid', ...input }, null), expected)
      await assert.rejects(updateQa(db, scope, authored.data.id, input, null), expected)
    }
    await assert.rejects(reorderQa(db, scope, [{ id: authored.data.id, sort_order: 0 }, { id: imported.data.id, sort_order: 1 }], null), /outside the requested scope/)
    assert.deepEqual(await listQa(db, ORG, null, false, '/pricing'), before)
    // Refuse one row of a real multi-row reorder: the other row and its audit must roll back too.
    const beforeReorderAudits = await db.prepare("SELECT count(*) FROM activity_entries WHERE organization_id=? AND event_name='content.updated'").bind(ORG).first('count(*)')
    await db.prepare("CREATE TRIGGER skip_qa_reorder BEFORE UPDATE OF sort_order ON content_documents WHEN OLD.kind = 'qa' AND OLD.sort_order=4 BEGIN SELECT RAISE(IGNORE); END").run()
    try {
      await assert.rejects(reorderQa(db, scope, [{ id: authored.data.id, sort_order: 0 }, { id: secondAuthored.data.id, sort_order: 1 }], null),
        { status: 409, statusText: 'Q&A reorder changed concurrently. Reload and try again.' })
      assert.deepEqual(await listQa(db, ORG, null, false, '/pricing'), before)
      assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE organization_id=? AND event_name='content.updated'").bind(ORG).first('count(*)'), beforeReorderAudits)
    } finally {
      await db.prepare('DROP TRIGGER skip_qa_reorder').run()
    }

    await assert.rejects(updateQa(db, scope, imported.data.id, { answer: 'Overwrite' }, null), /Q&A not found/)
    assert.equal((await deleteQa(db, scope, imported.data.id)).status, 404)
    await assert.rejects(createQa(db, { ...scope, locationId: 'foreign-location', pagePath: null }, { question: 'Wrong tenant' }, null), /Q&A scope not found/)
    await assert.rejects(createQa(db, { ...scope, locationId: 'foreign-location' }, { question: 'Ambiguous scope' }, null), /not both/)
    await updateQa(db, scope, authored.data.id, { answer: null, is_owner_answer: false }, null)
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


test('location edits record exact changed facts and do not manufacture an edit for unchanged input', async () => {
  const { runtime, db } = await boot()
  try {
    const actor = 'location-editor'
    await db.prepare("INSERT INTO user (id, name, email, emailVerified) VALUES (?, 'Editor', 'location-editor@proof.example', 1)").bind(actor).run()
    await db.prepare("UPDATE organization SET onboarding_status = 'active' WHERE id = ?").bind(ORG).run()
    const env = { ...await runtime.getBindings<CloudflareEnv>(), DB: db } as CloudflareEnv
    const created = await createLocation(env, db, ORG, { title: 'Office', timezone: 'Asia/Bangkok' }, actor)
    assert.equal(created.status, 201)
    const id = (created.data as { location: { id: string } }).location.id
    const original = await getLocation(db, ORG, id)
    assert.ok(original)
    const changed = await updateLocation(db, ORG, id, { phone: '+66812345678', expected_updated_at: original.updated_at }, actor, env)
    assert.equal(changed.status, 200)
    const read = await getLocation(db, ORG, id)
    assert.equal(read!.phone, '+66812345678')
    const entries = async () => (await db.prepare("SELECT actor_user_id, payload_json FROM activity_entries WHERE event_name = 'location.updated' AND json_extract(payload_json, '$.entityId') = ?")
      .bind(id).all<{ actor_user_id: string; payload_json: string }>()).results
    const receipts = await entries()
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0]!.actor_user_id, actor)
    assert.deepEqual(JSON.parse(receipts[0]!.payload_json).metadata.changed_fields, ['phone'])
    const repeat = await updateLocation(db, ORG, id, { phone: '+66812345678', expected_updated_at: read!.updated_at }, actor, env)
    assert.equal(repeat.status, 200)
    assert.equal((await getLocation(db, ORG, id))!.updated_at, read!.updated_at)
    assert.deepEqual(await entries(), receipts)
    const stale = await updateLocation(db, ORG, id, { phone: '+66812345679', expected_updated_at: original.updated_at }, actor, env)
    assert.equal(stale.status, 409)
    assert.equal((await getLocation(db, ORG, id))!.phone, '+66812345678')
  } finally { await runtime.dispose() }
})
