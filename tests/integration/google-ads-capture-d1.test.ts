import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { storeIntegration } from '../../server/utils/organization-integrations.ts'
import { handleGoogleAdsTools } from '../../server/utils/mcp-tools/google-ads.ts'
import type { McpExecutorContext } from '../../server/utils/mcp-tools/execution.ts'

test('ad mutations retain the authorized actor, actual changes and provider receipts without counting unchanged requests', { timeout: 60_000 }, async (t) => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'ads-capture-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(sql => db.prepare(sql)))
    await db.prepare("INSERT INTO organization (id,name,slug,default_currency,timezone) VALUES ('org','Org','org','USD','UTC'), ('other','Other','other','USD','UTC')").run()
    await db.prepare("INSERT INTO user (id,name,email) VALUES ('owner','Owner','owner@ads.example'), ('publisher','Publisher','publisher@ads.example')").run()
    await db.prepare("INSERT INTO member (id,organizationId,userId,role) VALUES ('owner-member','org','owner','owner'), ('publisher-member','org','publisher','admin')").run()
    // A linked account is a fixture, not a replacement token lifecycle. The
    // real handler reads its usable token through Better Auth's account API.
    await db.prepare('INSERT INTO account (id,accountId,providerId,userId,accessToken,accessTokenExpiresAt) VALUES (?,?,?,?,?,?)')
      .bind('google-account', 'google-owner', 'google', 'owner', 'ads-test-token', Math.floor(Date.now() / 1000) + 3600).run()
    await storeIntegration(db, 'org', 'google_ads', { account_id: 'google-account', target_id: '3317427925', target_name: 'Ads account' })
    const env = {
      DB: db, BETTER_AUTH_SECRET: 'ads-capture-proof-secret-long-enough', BETTER_AUTH_URL: 'https://ads.example',
      NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://ads.example', STRIPE_SECRET_KEY: 'sk_test_local_ads_no_stripe_requests',
      GOOGLE_ADS_DEVELOPER_TOKEN: 'ads-developer-token',
    } as CloudflareEnv
    const organization = { db, env, organizationId: 'org', userId: 'publisher', role: 'admin', isPlatformAdmin: false, scopes: ['tenant'],
      membership: { id: 'publisher-member', organizationId: 'org', userId: 'publisher', role: 'admin' } } as McpExecutorContext['organization']
    let campaignStatus = 'ENABLED', campaignName = 'Campaign', mutations = 0, dropNext = false, refuseNext = false, incompleteNext = false
    const providerFetch = t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'https://googleads.googleapis.com')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ads-test-token')
      const body = JSON.parse(String(init?.body))
      if (url.pathname.endsWith('/googleAds:search')) {
        if (body.query.includes('FROM customer')) return Response.json({ results: [{ customer: { descriptiveName: 'Ads account', currencyCode: 'USD', timeZone: 'UTC' } }] })
        if (body.query.includes('FROM campaign')) return Response.json({ results: [{ campaign: { id: '222', name: campaignName, status: campaignStatus, advertisingChannelType: 'SEARCH' }, campaignBudget: { id: '888', amountMicros: '10000000' } }] })
        return Response.json({ results: [] })
      }
      assert.ok(url.pathname.endsWith('/googleAds:mutate'))
      mutations += 1
      if (refuseNext) {
        refuseNext = false
        return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Campaign change refused',
          details: [{ errors: [{ errorCode: { campaignError: 'CANNOT_TARGET_SEARCH_NETWORK' }, message: 'This campaign change was refused' }] }] } },
        { status: 400, headers: { 'request-id': 'google-refusal-receipt' } })
      }
      const operations = body.mutateOperations as Array<Record<string, unknown>>
      if (operations.some(op => 'campaignOperation' in op && (op.campaignOperation as { create?: unknown }).create)) {
        const createdCampaign = (operations.find(op => 'campaignOperation' in op)!.campaignOperation as { create: { status: string; name: string } }).create
        campaignStatus = createdCampaign.status
        campaignName = createdCampaign.name
        return Response.json({ mutateOperationResponses: [
          { campaignBudgetResult: { resourceName: 'customers/3317427925/campaignBudgets/888' } },
          { campaignResult: { resourceName: 'customers/3317427925/campaigns/222' } },
          { adGroupResult: { resourceName: 'customers/3317427925/adGroups/333' } },
          { adGroupAdResult: { resourceName: 'customers/3317427925/adGroupAds/555' } },
        ] }, { headers: { 'request-id': 'google-create-receipt' } })
      }
      campaignStatus = ((operations[0]!.campaignOperation as { update: { status: string } }).update.status)
      if (dropNext) { dropNext = false; throw new TypeError('Provider response lost') }
      if (incompleteNext) { incompleteNext = false; return Response.json({}) }
      return Response.json({ mutateOperationResponses: [{ campaignResult: { resourceName: 'customers/3317427925/campaigns/222' } }] }, { headers: { 'request-id': 'google-update-receipt' } })
    })
    const call = (toolName: string, args: Record<string, unknown>) => handleGoogleAdsTools({ toolName, args, organization })
    const events = async () => (await db.prepare("SELECT id,actor_user_id,event_name,payload_json FROM activity_entries WHERE organization_id='org' AND event_name LIKE 'google_ads.%' ORDER BY occurred_at,id")
      .all<{ id: string; actor_user_id: string; event_name: string; payload_json: string }>()).results

    const createArgs = {
      name: 'New campaign', daily_budget_micros: 10_000_000, target_url: 'https://example.test/consultations', keywords: [],
      headlines: ['Legal consultations', 'Book a consultation', 'Talk with our legal team'], descriptions: ['Prepare for your legal consultation.', 'Read our practice areas before requesting a time.'], contains_eu_political_advertising: false,
    }
    await assert.rejects(call('create_google_ads_search_campaign', { ...createArgs, target_url: 'mailto:legal@example.test' }), /valid http or https URL/)
    await assert.rejects(call('create_google_ads_search_campaign', { ...createArgs, headlines: ['   ', 'Book a consultation', 'Talk with our legal team'] }), /unique nonempty headlines/)
    await assert.rejects(call('update_google_ads_campaign', { campaign_id: '222', daily_budget_micros: 10_000_000 }), /must be supplied together/)
    assert.equal(providerFetch.mock.callCount(), 0, 'local validation precedes all provider reads, mutations and durable intent')
    assert.deepEqual(await events(), [])

    assert.deepEqual(await call('create_google_ads_search_campaign', createArgs), { campaign_id: '222', status: 'PAUSED' })
    let recorded = await events()
    const created = recorded.find(row => row.event_name === 'google_ads.campaign_created')!
    const creation = JSON.parse(created.payload_json)
    assert.equal(created.actor_user_id, 'publisher')
    assert.equal(creation.entityId, '222')
    assert.equal(creation.metadata.provider_request_id, 'google-create-receipt')
    assert.equal(creation.afterState.status, 'PAUSED')
    assert.equal(recorded.find(row => row.id === creation.metadata.operation_id)?.event_name, 'google_ads.campaign_change_requested')
    assert.equal(recorded.length, 2)

    assert.equal(campaignStatus, 'PAUSED')
    assert.deepEqual(await call('update_google_ads_campaign', { campaign_id: '222', status: 'ENABLED' }), { campaign_id: '222', status: 'ENABLED', budget_id: null, daily_budget_micros: null })
    recorded = await events()
    const updated = JSON.parse(recorded.find(row => row.event_name === 'google_ads.campaign_updated')!.payload_json)
    assert.deepEqual(updated.beforeState, { name: 'New campaign', status: 'PAUSED', budget_id: '888', daily_budget_micros: 10_000_000, currency: 'USD' })
    assert.equal(updated.afterState.status, 'ENABLED')
    assert.deepEqual(updated.metadata.changed_fields, ['status'])
    assert.equal(updated.metadata.provider_request_id, 'google-update-receipt')
    const afterChange = recorded
    await call('update_google_ads_campaign', { campaign_id: '222', status: 'ENABLED' })
    assert.deepEqual(await events(), afterChange)
    assert.equal(mutations, 2)

    dropNext = true
    await assert.rejects(call('update_google_ads_campaign', { campaign_id: '222', status: 'PAUSED' }), /Provider response lost/)
    assert.equal(campaignStatus, 'PAUSED', 'a response can be lost after the provider applied the change')
    recorded = await events()
    const uncertain = recorded.find(row => row.event_name === 'google_ads.campaign_change_unconfirmed')!
    const uncertainty = JSON.parse(uncertain.payload_json)
    assert.equal(uncertain.actor_user_id, 'publisher')
    assert.equal(uncertainty.afterState, null)
    assert.equal(uncertainty.metadata.verification_status, 'unconfirmed')
    assert.equal(uncertainty.metadata.requested_state.status, 'PAUSED')
    assert.equal(uncertainty.metadata.error, 'Provider response lost')
    assert.ok(recorded.some(row => row.id === uncertainty.metadata.operation_id))
    assert.equal(recorded.filter(row => row.event_name === 'google_ads.campaign_updated').length, 1)

    refuseNext = true
    await assert.rejects(call('update_google_ads_campaign', { campaign_id: '222', status: 'ENABLED' }), /campaign change was refused/)
    assert.equal(campaignStatus, 'PAUSED')
    recorded = await events()
    const refused = JSON.parse(recorded.find(row => row.event_name === 'google_ads.campaign_change_failed')!.payload_json)
    assert.equal(refused.afterState, null)
    assert.equal(refused.metadata.verification_status, 'failed')
    assert.equal(refused.metadata.provider_request_id, 'google-refusal-receipt')
    assert.equal(refused.metadata.requested_state.status, 'ENABLED')
    assert.equal(recorded.filter(row => row.event_name === 'google_ads.campaign_change_unconfirmed').length, 1)

    incompleteNext = true
    await assert.rejects(call('update_google_ads_campaign', { campaign_id: '222', status: 'ENABLED' }), /complete campaign update receipt/)
    assert.equal(campaignStatus, 'ENABLED')
    recorded = await events()
    assert.equal(recorded.filter(row => row.event_name === 'google_ads.campaign_change_unconfirmed').length, 2)

    const beforeReceiptFailure = new Set(recorded.map(row => row.id))
    await db.prepare("CREATE TRIGGER refuse_ad_result BEFORE INSERT ON activity_entries WHEN NEW.event_name='google_ads.campaign_updated' BEGIN SELECT RAISE(ABORT,'Result receipt refused'); END").run()
    await assert.rejects(call('update_google_ads_campaign', { campaign_id: '222', status: 'PAUSED' }), /Google Ads accepted the campaign change, but its result could not be recorded/)
    assert.equal(campaignStatus, 'PAUSED', 'a failed local result write does not roll back the provider')
    recorded = await events()
    const partial = recorded.filter(row => !beforeReceiptFailure.has(row.id))
    assert.equal(partial.length, 1)
    assert.equal(partial[0]!.event_name, 'google_ads.campaign_change_requested')
    await db.prepare('DROP TRIGGER refuse_ad_result').run()

    const beforeIntentFailure = await events(), previousMutationCount = mutations
    await db.prepare("CREATE TRIGGER refuse_ad_intent BEFORE INSERT ON activity_entries WHEN NEW.event_name='google_ads.campaign_change_requested' BEGIN SELECT RAISE(ABORT,'Intent persistence refused'); END").run()
    await assert.rejects(call('update_google_ads_campaign', { campaign_id: '222', status: 'ENABLED' }), /Intent persistence refused/)
    assert.equal(mutations, previousMutationCount, 'failed durable intent prevents provider mutation')
    assert.equal(campaignStatus, 'PAUSED')
    assert.deepEqual(await events(), beforeIntentFailure)
    await db.prepare('DROP TRIGGER refuse_ad_intent').run()
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM activity_entries WHERE organization_id='other'").first('n'), 0)
  } finally { await runtime.dispose() }
})
