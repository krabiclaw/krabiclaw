import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import * as schema from '../../server/db/schema.ts'
import analyticsDaily from '../../server/tasks/analytics-aggregate-daily.ts'
import { logMcpToolCallEvent } from '../../server/utils/mcp-telemetry.ts'

// Privacy Policy: MCP tool-call telemetry is deleted 180 days after creation.
test('MCP telemetry stores only operational facts and the daily task deletes records older than 180 days', { timeout: 60_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'mcp-telemetry-retention', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    const privateText = 'Customer Alice customer@example.com token-private';
    await logMcpToolCallEvent(db, {
      env: { BETTER_AUTH_SECRET: 'telemetry-test-hash-key' },
      method: privateText, status: 'error', errorCode: -32602,
      arguments: { name: privateText, message: privateText, notes: privateText, password: privateText, confirm: true },
      result: { count: 2, status: 'error', content: [{ text: privateText }] },
      errorMessage: privateText, jsonrpcErrorMessage: privateText, userAgent: privateText, toolName: privateText, unknownToolName: privateText,
    })
    const telemetry = await db.prepare("SELECT * FROM mcp_tool_call_events WHERE method = 'unknown'").first<{ id: string; arguments_summary_json: string; result_summary_json: string; user_agent: string | null }>()
    assert.ok(telemetry)
    assert.deepEqual(JSON.parse(telemetry.arguments_summary_json), { confirm: true })
    assert.deepEqual(JSON.parse(telemetry.result_summary_json), { count: 2, status: 'error' })
    assert.equal(telemetry.user_agent, null)
    assert.doesNotMatch(JSON.stringify(telemetry), /Customer Alice|customer@example.com|token-private/)
    await logMcpToolCallEvent(db, {
      env: { MCP_DIAGNOSTICS_ENABLED: 'true' }, requestId: 'diagnostic-call',
      method: 'tools/call', toolName: 'set_collection_products', status: 'error', errorCode: -32603,
      arguments: { collection_id: 'menu-section', product_ids: ['invalid-product'], token: 'private-diagnostic-token' },
      result: { isError: true, content: [{ type: 'text', text: 'FOREIGN KEY constraint failed' }] },
      errorMessage: 'FOREIGN KEY constraint failed',
    })
    const diagnostic = await db.prepare("SELECT * FROM mcp_tool_call_events WHERE request_id = 'diagnostic-call'").first<{ id: string; arguments_summary_json: string; result_summary_json: string; error_message: string }>()
    assert.ok(diagnostic)
    assert.deepEqual(JSON.parse(diagnostic.arguments_summary_json).data.product_ids, ['invalid-product'])
    assert.equal(JSON.parse(diagnostic.result_summary_json).data.content[0].text, 'FOREIGN KEY constraint failed')
    assert.equal(diagnostic.error_message, 'FOREIGN KEY constraint failed')
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-diagnostic-token/)
    await db.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('telemetry-site', 'Telemetry site', 'telemetry-site', 'USD', 'UTC')").run()
    for (let call = 0; call < 2; call++) {
      await logMcpToolCallEvent(db, { organizationId: 'telemetry-site', requestId: 1,
        method: 'tools/call', toolName: 'list_products', status: 'success' })
    }
    const usage = await db.prepare("SELECT COUNT(*) AS count, SUM(quantity) AS quantity FROM usage_events WHERE organization_id = 'telemetry-site'").first<{ count: number; quantity: number }>()
    assert.deepEqual(usage, { count: 2, quantity: 2 })
    const metered = await db.prepare("SELECT id FROM mcp_tool_call_events WHERE organization_id = 'telemetry-site'").all<{ id: string }>()
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
    const insert = db.prepare("INSERT INTO mcp_tool_call_events (id, method, status, created_at) VALUES (?, 'tools/call', 'success', ?)")
    await db.batch([insert.bind('day-181', daysAgo(181)), insert.bind('day-179', daysAgo(179)), insert.bind('today', daysAgo(0))])
    await db.prepare("INSERT INTO mcp_tool_call_events (id, method, status, created_at, arguments_summary_json) VALUES ('diagnostic-day-8', 'tools/call', 'success', ?, ?)")
      .bind(daysAgo(8), diagnostic.arguments_summary_json).run()

    const outcome = await analyticsDaily.run({ name: 'analytics-aggregate-daily', payload: {}, context: { cloudflare: { env: { DB: db } } } })

    assert.equal((outcome as { result: { mcpToolCallEventsCleaned: number } }).result.mcpToolCallEventsCleaned, 2)
    const remaining = await db.prepare('SELECT id FROM mcp_tool_call_events ORDER BY id').all<{ id: string }>()
    assert.deepEqual(remaining.results.map(row => row.id).sort(), ['day-179', 'today', telemetry.id, diagnostic.id, ...metered.results.map(row => row.id)].sort())
  } finally { await runtime.dispose() }
})
