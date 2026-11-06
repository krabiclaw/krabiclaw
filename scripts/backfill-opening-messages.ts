// One-time data repair (inbox-parity.md, Revision 2026-11-06): writes the
// opening messages into reservation, booking and site-stay conversations
// created before creation wrote them. Idempotent: a conversation that already
// has its opening is skipped.
//
//   node --experimental-strip-types --import ./tests/unit/support/register-aliases.mjs scripts/backfill-opening-messages.ts --staging
//   … --production
import { parseArgs } from 'node:util'
import { Miniflare } from 'miniflare'
import { startRemoteProxySession, unstable_readConfig } from 'wrangler'
import { backfillOpeningMessages } from '../server/domain/guest-threads/opening.ts'

const { values } = parseArgs({ options: { staging: { type: 'boolean', default: false }, production: { type: 'boolean', default: false }, organization: { type: 'string' } }, strict: true })
if (values.staging === values.production) throw new Error('Pass exactly one of --staging or --production.')
const env = values.staging ? 'staging' : undefined
const config = unstable_readConfig({ config: 'wrangler.toml', env }, { hideWarnings: true })
const database = config.d1_databases.find((binding: { binding: string }) => binding.binding === 'DB')
if (!database?.database_id) throw new Error(`wrangler.toml has no DB database_id for ${env ?? 'production'}`)

const session = await startRemoteProxySession({ DB: { type: 'd1', database_id: database.database_id } })
const runtime = new Miniflare({ workers: [{
  dev: { remoteProxyConnectionString: session.remoteProxyConnectionString },
  config: {
    name: 'backfill-opening-messages', compatibilityDate: config.compatibility_date ?? '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1', id: database.database_id, dev: { remote: true } } },
  },
}] })
try {
  const db = await runtime.getD1Database('DB')
  const result = await backfillOpeningMessages(db, values.organization)
  console.log(`Opening messages on ${database.database_name}: ${result.written} written, ${result.skipped} skipped`)
} finally {
  await runtime.dispose()
  await session.dispose()
}
