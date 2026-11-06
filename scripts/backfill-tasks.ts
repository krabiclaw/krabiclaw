// One-time derivation of existing data (tasks-and-opportunities.md, "Existing
// data"): opens the tasks that writes open from now on, for what is already
// there — turnovers for confirmed stays checking out today or later, reply
// tasks for conversations with a guest question nobody has answered, and
// delivery tasks for scheduled messages that failed or need review. Each uses
// the same statements the live writes use, and each is idempotent by its
// dedupe_key. --dry-run reads only and reports what it would open.
//
//   yarn db:tasks --staging --dry-run
//   yarn db:tasks --production
import { parseArgs } from 'node:util'
import { Miniflare } from 'miniflare'
import { startRemoteProxySession, unstable_readConfig } from 'wrangler'
import { executeBatch, queryAll, type DbClient } from '../server/db/index.ts'
import { businessReplyAfterSql, CANCELLED_AFTER_SQL, conversationTaskQueries, GUEST_QUESTION_SQL } from '../server/domain/guest-threads/repository.ts'
import { messageDeliveryTaskQueries, turnoverTaskQueries, type StayWindow } from '../server/domain/tasks.ts'
import { localDateAt } from '../utils/timezone.ts'

const { values } = parseArgs({ options: { staging: { type: 'boolean', default: false }, production: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } }, strict: true })
if (values.staging === values.production) throw new Error('Pass exactly one of --staging or --production.')
const dryRun = values['dry-run']

async function backfill(db: DbClient) {
  const now = new Date()
  // Before the migration that creates tasks has run, a dry run counts everything as still to open; a real run refuses.
  const migrated = (await queryAll(db, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'")).length === 1
  if (!migrated && !dryRun) throw new Error('This database has no tasks table yet: apply migrations/0010_tasks_and_opportunities.sql first.')
  const absent = (sql: string) => migrated ? `AND NOT EXISTS (${sql})` : ''
  const stays = (await queryAll<StayWindow & { organization_id: string; timezone: string }>(db, `
    SELECT s.id, s.organization_id, s.product_id, s.status, s.check_in_date, s.check_out_date, l.timezone
      FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
      JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
     WHERE s.status = 'confirmed' AND s.check_out_date >= date('now', '-1 day')
       ${absent("SELECT 1 FROM tasks t WHERE t.dedupe_key = 'turnover:' || s.id")}
     ORDER BY s.check_out_date, s.id`)).filter(stay => stay.check_out_date >= localDateAt(now, stay.timezone))
  const conversations = await queryAll<{ id: string; was_needs_attention: number }>(db, `
    SELECT DISTINCT r.id, r.conversation_state = 'needs_attention' AS was_needs_attention
      FROM requests r JOIN activity_entries guest_entry ON guest_entry.request_id = r.id
     WHERE r.archived_at IS NULL AND r.blocked_at IS NULL AND ${GUEST_QUESTION_SQL}
       AND NOT ${businessReplyAfterSql('guest_entry')} AND NOT ${CANCELLED_AFTER_SQL}
       ${absent("SELECT 1 FROM tasks t WHERE t.kind = 'guest_reply' AND t.subject_type = 'request' AND t.subject_id = r.id AND t.status = 'open'")}`)
  const needsAttention = await queryAll<{ count: number }>(db, "SELECT COUNT(*) AS count FROM requests WHERE conversation_state = 'needs_attention' AND archived_at IS NULL AND blocked_at IS NULL")
  const messages = await queryAll<{ id: string }>(db, `SELECT id FROM scheduled_guest_messages m WHERE m.status IN ('failed', 'needs_review')
    ${absent("SELECT 1 FROM tasks t WHERE t.dedupe_key = 'message_delivery:' || m.id")}`)
  const report = {
    tasksTableExists: migrated,
    turnovers: stays.length, guestReplies: conversations.length, messageDeliveries: messages.length,
    // For comparison with the retired stored guess: conversations it marked needs_attention, and how many of those have an unanswered question.
    retiredNeedsAttention: needsAttention[0]?.count ?? 0, guestRepliesAlsoNeedsAttention: conversations.filter(row => row.was_needs_attention).length,
  }
  if (dryRun) return report
  const at = now.toISOString()
  for (const stay of stays) {
    await executeBatch(db, await turnoverTaskQueries(db, { organizationId: stay.organization_id, after: stay, before: null, now: at }), { operation: 'Backfill turnover task' })
  }
  for (const conversation of conversations) await executeBatch(db, conversationTaskQueries(conversation.id, at), { operation: 'Backfill reply task' })
  for (const message of messages) await executeBatch(db, messageDeliveryTaskQueries(message.id, at), { operation: 'Backfill delivery task' })
  const opened = await queryAll<{ kind: string; count: number }>(db, "SELECT kind, COUNT(*) AS count FROM tasks WHERE created_at >= ? GROUP BY kind ORDER BY kind", [at])
  return { ...report, opened }
}

const env = values.staging ? 'staging' : undefined
const config = unstable_readConfig({ config: 'wrangler.toml', env }, { hideWarnings: true })
const database = config.d1_databases.find((binding: { binding: string }) => binding.binding === 'DB')
if (!database?.database_id) throw new Error(`wrangler.toml has no DB database_id for ${env ?? 'production'}`)

const session = await startRemoteProxySession({ DB: { type: 'd1', database_id: database.database_id } })
const runtime = new Miniflare({ workers: [{
  dev: { remoteProxyConnectionString: session.remoteProxyConnectionString },
  config: {
    name: 'backfill-tasks', compatibilityDate: config.compatibility_date ?? '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1', id: database.database_id, dev: { remote: true } } },
  },
}] })
try {
  const result = await backfill(await runtime.getD1Database('DB'))
  console.log(`Tasks on ${database.database_name}${dryRun ? ' (dry run, nothing written)' : ''}: ${JSON.stringify(result, null, 2)}`)
} finally {
  await runtime.dispose()
  await session.dispose()
}
