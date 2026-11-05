import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import { recordSuggestionAccepted, suggestedDraft, suggestGuestReplies } from '../../server/domain/suggested-reply.ts'
import { memberAccessPrincipal } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'

// Suggested replies are charged for, so the usage ledger records each
// generation the model completed and, once, a reply sent from one of its drafts.

const ORG = 'org'
const OWNER = 'owner-user'
const THREAD = 'contact-thread'
const NOW = '2026-11-05T00:00:00.000Z'

test('suggested replies meter each generation and one acceptance per generation, and a failed generation meters nothing', { timeout: 120000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'suggested-replies-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Cabin Co', 'org', 'org', '{}', 'tenant-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', ?, 'America/Denver')`).bind(ORG, NOW).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner Person', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    const payload = JSON.stringify({ guest: { name: 'Jamie Rivera', email: 'jamie@example.test', phone: null }, subject: null, message: 'Is early check-in possible?', consent_at: null, ip_hash: null })
    await db.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json, created_at, updated_at) VALUES (?, 'contact', ?, 'needs_attention', ?, ?, ?)").bind(THREAD, ORG, payload, NOW, NOW).run()
    await db.prepare(`INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, channel, body, event_name, payload_json, dedupe_key, sequence, occurred_at, created_at)
      VALUES ('opening', ?, 'submission', 'request', 'guest', 'web', NULL, NULL, '{}', 'opening', 1, ?, ?)`).bind(THREAD, NOW, NOW).run()

    let modelAnswer = { response: '["We can check that for you.", "Early check-in is usually fine."]', usage: { prompt_tokens: 120, completion_tokens: 30 } }
    let modelCalls = 0
    const env = { ...await runtime.getBindings<CloudflareEnv>(), AI: { run: async () => { modelCalls += 1; return modelAnswer } } } as unknown as CloudflareEnv
    const principal = memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env })
    const events = () => db.prepare("SELECT unit, quantity, provider, source, idempotency_key, metadata_json FROM usage_events WHERE organization_id = ? AND resource = 'suggested_replies' ORDER BY created_at, unit").bind(ORG).all<{ unit: string; quantity: number; provider: string; source: string; idempotency_key: string; metadata_json: string }>()

    // A generation the model completed is metered once, keyed by its id, before its drafts are returned.
    const first = await suggestGuestReplies(db, env as unknown as Record<string, unknown>, principal, THREAD)
    assert.deepEqual(first.suggestions, ['We can check that for you.', 'Early check-in is usually fine.'])
    let rows = (await events()).results
    assert.equal(rows.length, 1)
    assert.deepEqual({ ...rows[0]!, metadata_json: undefined }, { unit: 'generation', quantity: 1, provider: 'workers_ai', source: 'guest_thread', idempotency_key: first.generationId, metadata_json: undefined })
    const generated = JSON.parse(rows[0]!.metadata_json) as Record<string, unknown>
    assert.deepEqual({ ...generated, draftDigests: undefined }, { threadId: THREAD, organizationId: ORG, userId: OWNER, count: 2, model: '@cf/meta/llama-3.1-8b-instruct-fast', promptTokens: 120, outputTokens: 30, draftDigests: undefined })
    assert.equal((generated.draftDigests as unknown[]).length, 2)
    assert.ok(!JSON.stringify(generated).includes('check-in is usually'), 'the ledger keeps digests of the drafts, not their words')

    // A generation the model did not complete meters nothing.
    modelAnswer = { response: 'not a list', usage: { prompt_tokens: 120, completion_tokens: 3 } }
    await assert.rejects(suggestGuestReplies(db, env as unknown as Record<string, unknown>, principal, THREAD), { data: { code: 'SUGGESTION_INVALID', field: 'suggestions' } })
    assert.equal(modelCalls, 2)
    assert.equal((await events()).results.length, 1)

    // Sending the second draft unedited is one acceptance; the same reply retried records nothing more.
    const draft = await suggestedDraft(db, { organizationId: ORG, threadId: THREAD, suggestion: { generationId: first.generationId, index: 1 } })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await recordSuggestionAccepted(db, { organizationId: ORG, threadId: THREAD, userId: OWNER, body: 'Early check-in is usually fine.', draft })
    }
    rows = (await events()).results
    const accepted = rows.filter(row => row.unit === 'accepted')
    assert.equal(accepted.length, 1)
    assert.equal(accepted[0]!.idempotency_key, `${first.generationId}:accepted`)
    assert.deepEqual(JSON.parse(accepted[0]!.metadata_json), { generationId: first.generationId, index: 1, threadId: THREAD, userId: OWNER, edited: false })

    // A draft edited before sending is still an acceptance of that generation, marked edited.
    modelAnswer = { response: '["Sure, from 1 pm."]', usage: { prompt_tokens: 110, completion_tokens: 8 } }
    const second = await suggestGuestReplies(db, env as unknown as Record<string, unknown>, principal, THREAD)
    await recordSuggestionAccepted(db, { organizationId: ORG, threadId: THREAD, userId: OWNER, body: 'Sure, from 2 pm.',
      draft: await suggestedDraft(db, { organizationId: ORG, threadId: THREAD, suggestion: { generationId: second.generationId, index: 0 } }) })
    const edited = (await events()).results.find(row => row.idempotency_key === `${second.generationId}:accepted`)
    assert.equal((JSON.parse(edited!.metadata_json) as { edited: boolean }).edited, true)

    // A claim to a generation of another conversation, or to a draft it did not have, is refused before anything is sent.
    await assert.rejects(suggestedDraft(db, { organizationId: ORG, threadId: 'another-thread', suggestion: { generationId: first.generationId, index: 0 } }), { data: { code: 'INVALID_SUGGESTION', field: 'suggestion.generationId' } })
    await assert.rejects(suggestedDraft(db, { organizationId: ORG, threadId: THREAD, suggestion: { generationId: first.generationId, index: 2 } }), { data: { code: 'INVALID_SUGGESTION', field: 'suggestion.index' } })
    await assert.rejects(suggestedDraft(db, { organizationId: ORG, threadId: THREAD, suggestion: { generationId: 'never-generated', index: 0 } }), { data: { code: 'INVALID_SUGGESTION', field: 'suggestion.generationId' } })
    assert.deepEqual((await events()).results.map(row => row.unit).sort(), ['accepted', 'accepted', 'generation', 'generation'])
  } finally {
    await runtime.dispose()
  }
})
