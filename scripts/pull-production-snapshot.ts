/**
 * Local and staging start from a copy of production instead of hand-maintained
 * seed definitions, so what they test against is what customers actually have.
 *
 * The row copy is transferred through scripts/transfer-database-export.mjs:
 * rows are copied into the current migration chain and audited before a target
 * is written.
 *
 * Local development and a normal production-to-staging refresh omit jwks:
 * each destination retains its own signing keys. A same-environment replacement
 * names its source and carries that source's jwks across the binding repoint.
 *
 *   node --experimental-strip-types scripts/pull-production-snapshot.ts --local
 *   node --experimental-strip-types scripts/pull-production-snapshot.ts --staging
 *   node --experimental-strip-types scripts/pull-production-snapshot.ts --out <target.sqlite> [--source <database>]
 *   node --experimental-strip-types scripts/pull-production-snapshot.ts --production --source <replaced database> [--delta-from <initial.sqlite>]
 *
 * The default source is the deployed production Worker's `DB` binding unless
 * `--source` names a D1 database. This reads the live database even while the
 * repository configuration points to a prepared replacement.
 *
 * `--out` alone is the preflight: the transformed target, its data-only payload
 * and its manifest are kept at that path and nothing remote is written. Beside a
 * load, `--out` keeps the loaded target there.
 * `--delta-from <initial target.sqlite>` writes only the rows the initial
 * transfer did not hold, for the final copy after the binding is repointed, and
 * names every row it did hold that has changed or gone since.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { unstable_readConfig as readWranglerConfig } from 'wrangler'
import { printTransferReport, SCHEMA_OBJECTS_QUERY, transferDatabaseExport } from './transfer-database-export.mjs'

// Staging is a release gate, so it has to hold what production holds. It had no
// target here, so it was never refreshed and drifted to whatever an older
// epoch's migration left in it — a Kikuzuki homepage of four blocks against
// production's eight, three product sessions against production's 808. A gate
// standing in front of `main` on data that does not resemble production is the
// reason tenant rendering, booking and localisation defects kept reaching
// production green. Staging is the same restore as local with `--env staging`;
// ordinary refreshes retain staging signing keys; replacements retain source keys.
const { values } = parseArgs({
  options: {
    local: { type: 'boolean', default: false },
    staging: { type: 'boolean', default: false },
    production: { type: 'boolean', default: false },
    out: { type: 'string' },
    source: { type: 'string', default: 'DB' },
    'source-file': { type: 'string' },
    'delta-from': { type: 'string' },
  },
  strict: true,
})
// `--out` alone is the preflight. Beside a load it keeps the transformed
// target at that path, which is what a later `--delta-from` compares against.
const loads = (['local', 'staging', 'production'] as const).filter(name => values[name])
if (loads.length > 1 || (loads.length === 0 && !values.out)) throw new Error('Choose one of --local, --staging or --production, or --out <target.sqlite> alone for a preflight.')
const target = loads[0] ?? 'out'
try { process.loadEnvFile() } catch (error) {
  if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
}
if (target === 'local' && !values['source-file']) values['source-file'] = process.env.LOCAL_DATABASE_SOURCE_FILE
if (values['source-file'] && target !== 'local' && target !== 'out') throw new Error('--source-file is for a local migration or read-only preflight.')
if (values['source-file'] && values.source !== 'DB') throw new Error('Choose --source or --source-file, not both.')
const omitJwks = target === 'local' || (target === 'staging' && values.source === 'DB')
// Production is only ever loaded as a schema replacement: the top-level `DB`
// binding already names the replacement, and the database it replaces has to
// be named, or the source would be the destination.
if ((target === 'production' || (target === 'staging' && values['delta-from'])) && values.source === 'DB') {
  throw new Error(`--${target} loads a replacement database; name that environment's previous database with --source <database>.`)
}
const deltaFrom = values['delta-from'] ? resolve(values['delta-from']) : null

const wrangler = resolve('node_modules/wrangler/bin/wrangler.js')
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
if (values.source === 'DB' && !values['source-file']) {
  const workerName = readWranglerConfig({ config: 'wrangler.toml' }).name
  if (!accountId || !apiToken || !workerName) throw new Error('Production snapshot requires a configured Cloudflare account, API token and Worker name.')
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/settings`, {
    headers: { authorization: `Bearer ${apiToken}` },
  })
  if (!response.ok) throw new Error(`Could not resolve the production Worker's DB binding: HTTP ${response.status}`)
  const settings = await response.json() as { success?: boolean; result?: { bindings?: Array<{ type: string; name: string; id?: string }> } }
  const sourceId = settings.result?.bindings?.find(binding => binding.type === 'd1' && binding.name === 'DB')?.id
  if (!settings.success || !sourceId) throw new Error(`Could not resolve the production Worker's DB binding: HTTP ${response.status}`)
  values.source = sourceId
}

/**
 * A failed `d1 execute` prints `✘ [ERROR]` with nothing after it and writes the
 * reason to a file, so CI shows an import that died at query 16465 for no
 * stated cause. WRANGLER_LOG_PATH puts that file in a directory we own — the
 * default location differs per platform, and guessing it means the reporter
 * throws ENOENT over the very error it was meant to report.
 */
const logDirectory = mkdtempSync(join(tmpdir(), 'krabiclaw-wrangler-logs-'))

function printWranglerLogs(): void {
  const names = readdirSync(logDirectory)
  if (names.length === 0) {
    console.error(`wrangler wrote no log under ${logDirectory}.`)
    return
  }
  for (const name of names) {
    const path = join(logDirectory, name)
    console.error(`--- ${path} ---`)
    console.error(readFileSync(path, 'utf8'))
    console.error(`--- end ${path} ---`)
  }
}

const run = (args: string[], json = false) => {
  try {
    return execFileSync(process.execPath, [wrangler, ...args], {
      cwd: process.cwd(),
      stdio: json ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, WRANGLER_LOG_PATH: logDirectory },
    })
  } catch (error) {
    console.error(`wrangler ${args.join(' ')} failed.`)
    printWranglerLogs()
    throw error
  }
}

// Cloudflare's export operation rejects concurrent application queries for the
// duration of the export. Copy rows with ordinary SELECTs instead; the existing
// transfer audit still validates the copy before either target is written.
// https://developers.cloudflare.com/d1/best-practices/import-export-data/
function sourceRows<T>(sql: string): T[] {
  const output = run(['d1', 'execute', values.source, '--remote', '--command', sql, '--json'], true)
  const results = JSON.parse(output) as Array<{ success: boolean; results: T[] }>
  if (results.length !== 1 || !results[0]!.success) throw new Error(`${values.source} snapshot query failed`)
  return results[0]!.results
}

const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"'

function copyProductionRows(path: string) {
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
  // Keep D1's migration ledger in the source snapshot: the transfer must know
  // which forward files have already run, including data-only migrations.
  const catalog = "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND tbl_name <> '__drizzle_migrations'"
  const tableCatalog = `SELECT name, sql FROM (${catalog}) WHERE type = 'table'`
  const tables = sourceRows<{ name: string; sql: string; column_names: string }>(
    `SELECT name, sql, (SELECT json_group_array(name) FROM pragma_table_xinfo(tables.name) WHERE hidden = 0) AS column_names FROM (${tableCatalog}) tables ORDER BY name`,
  )
  const schemaObjects = sourceRows<{ name: string; phase: number; sql: string }>(
    `SELECT name, CASE WHEN type = 'table' THEN 0 ELSE 2 END AS phase, sql FROM (${catalog}) ORDER BY phase, name`,
  )
  const queries = [`SELECT name AS table_name, CASE WHEN type = 'table' THEN 0 ELSE 2 END AS phase, sql AS statement FROM (${catalog})`]
  for (const table of tables) {
    if (omitJwks && table.name === 'jwks') continue
    const names = (JSON.parse(table.column_names) as string[]).map(identifier)
    const prefix = `INSERT INTO ${identifier(table.name)} (${names.join(',')}) VALUES (`
    const expression = literal(prefix) + ' || ' + names.map(name => `quote(${name})`).join(" || ',' || ") + " || ');'"
    queries.push(`SELECT ${literal(table.name)}, 1, ${expression} FROM ${identifier(table.name)}`)
  }
  // One SELECT gives all tables the same SQLite read snapshot. Include the
  // catalog in that read and reject schema changes since column discovery.
  // The existing buffer limit rejects oversized copies before target writes.
  // workerd limits each compound SELECT to five terms. CTEs keep each group
  // within that limit without forcing multiple full copies of the snapshot.
  // https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c++
  const ctes: string[] = []
  let groups = queries
  while (groups.length > 1) {
    const next: string[] = []
    for (let index = 0; index < groups.length; index += 5) {
      const name = `snapshot_group_${ctes.length}`
      ctes.push(`${name} AS (${groups.slice(index, index + 5).join(' UNION ALL ')})`)
      next.push(`SELECT * FROM ${name}`)
    }
    groups = next
  }
  const rows = sourceRows<{ table_name: string; phase: number; statement: string; total_rows: number }>(
    `WITH ${ctes.join(', ')} SELECT *, count(*) OVER () AS total_rows FROM (${groups[0]})`,
  )
  if (!rows.length || rows[0]!.total_rows !== rows.length) throw new Error(`Incomplete ${values.source} copy; no target data was written`)
  // Order the complete single-snapshot read locally instead of sorting the
  // full SQL dump inside D1.
  rows.sort((left, right) => left.phase - right.phase || (left.table_name < right.table_name ? -1 : left.table_name > right.table_name ? 1 : 0))
  const schema = rows.filter(row => row.phase !== 1)
  if (schema.length !== schemaObjects.length || schema.some((row, index) => row.table_name !== schemaObjects[index]!.name || row.phase !== schemaObjects[index]!.phase || row.statement !== schemaObjects[index]!.sql)) {
    throw new Error(`${values.source} schema changed during column discovery; no target data was written`)
  }
  writeFileSync(path, 'PRAGMA foreign_keys=OFF;\n' + rows.map(row => row.statement + (row.phase === 1 ? '' : ';')).join('\n'), { mode: 0o600 })
  for (const table of tables) console.log(`Copied ${table.name}: ${rows.filter(row => row.phase === 1 && row.table_name === table.name).length} rows`)
}

// The baseline this transfer builds must be the one server/db/schema.ts
// describes, or the payload is written for a schema no deploy will run.
execFileSync(process.execPath, ['scripts/check-schema-drift.mjs'], { cwd: process.cwd(), stdio: 'inherit' })

const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-snapshot-'))
try {
  const dumpPath = join(directory, 'source.sql')
  if (!values['source-file']) copyProductionRows(dumpPath)

  const targetPath = values.out ? resolve(values.out) : join(directory, 'target.sqlite')
  const payloadPath = values.out ? `${targetPath}.payload.sql` : join(directory, 'payload.sql')
  const manifest = await transferDatabaseExport(values['source-file'] ? resolve(values['source-file']) : dumpPath, targetPath, { payloadPath, withoutJwks: omitJwks, deltaFrom })
  printTransferReport(manifest)
  const rows = manifest.tables.reduce((total, table) => total + table.target_rows, 0)
  if (target === 'out') {
    console.log(`Preflight passed: ${manifest.tables.length} tables (${rows} rows) from ${values.source} into ${targetPath}; payload ${payloadPath}. Nothing remote was written.`)
  } else {
    const destination = target === 'local' ? ['--local'] : target === 'production' ? ['--remote'] : ['--env', target, '--remote']
    // The payload is data only and must match the exact current migration
    // chain before any remote row is written.
    const expectedSchema = manifest.schema
    if (!expectedSchema) throw new Error('The transfer did not report the schema it built')
    const [actual] = JSON.parse(run(['d1', 'execute', 'DB', ...destination, '--command', SCHEMA_OBJECTS_QUERY, '--json'], true)) as Array<{ results: Array<{ type: string; name: string; sql: string }> }>
    const key = (object: { type: string; name: string }) => `${object.type} ${object.name}`
    const actualSchema = new Map((actual?.results ?? []).map(object => [key(object), object.sql]))
    const drift = expectedSchema.filter(object => actualSchema.get(key(object)) !== object.sql).map(key)
    if (drift.length || actualSchema.size !== expectedSchema.length) {
      throw new Error(`${target} D1 does not carry the current migration chain (${drift.length ? drift.slice(0, 5).join(', ') : 'extra objects'} differ); no data was written. ${target === 'local'
        ? 'Delete .wrangler/state/v3/d1 and run `corepack yarn local:setup` again.'
        : 'Apply pending forward migrations or use the schema replacement in docs/operations/release-and-outage-prevention.md if a referenced constraint changed.'}`)
    }
    // Every deploy runs `d1 migrations apply` before it ships. A destination
    // whose ledger does not already record each migration file would have the
    // baseline applied again on top of the rows loaded here, so it is refused
    // until it was built with `wrangler d1 migrations apply`.
    const query = <T>(sql: string) => (JSON.parse(run(['d1', 'execute', 'DB', ...destination, '--command', sql, '--json'], true)) as Array<{ results: T[] }>)[0]?.results ?? []
    const ledgered = query<{ n: number }>("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'")[0]?.n === 1
      ? query<{ name: string }>('SELECT name FROM d1_migrations ORDER BY name').map(row => row.name)
      : []
    const migrationFiles = readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()
    if (JSON.stringify(ledgered) !== JSON.stringify(migrationFiles)) {
      throw new Error(`${target} D1 records migrations [${ledgered.join(', ')}] but the repository has [${migrationFiles.join(', ')}]; no data was written. Build it with \`wrangler d1 migrations apply\`, not by executing the baseline file.`)
    }
    if (deltaFrom && target !== 'local') {
      if (!accountId || !apiToken) throw new Error('Remote delta requires a configured Cloudflare account and API token.')
      const config = readWranglerConfig({ config: 'wrangler.toml', env: target === 'staging' ? 'staging' : undefined })
      const databaseId = config.d1_databases.find((database: { binding: string; database_id?: string }) => database.binding === 'DB')?.database_id
      if (!databaseId) throw new Error(`${target} delta requires an explicit DB database_id in wrangler.toml.`)
      // One normal query batch is atomic and retains foreign-key deferral.
      // A live delta must not use the blocking bulk-import operation.
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sql: readFileSync(payloadPath, 'utf8') }),
      })
      if (!response.ok) throw new Error(`${target} delta query failed: HTTP ${response.status}`)
      const applied = await response.json().catch(() => {
        throw new Error(`${target} delta query returned invalid JSON: HTTP ${response.status}`)
      }) as { success?: boolean; result?: Array<{ success?: boolean } | null> } | null
      if (applied?.success !== true || !Array.isArray(applied.result) || applied.result.length === 0 || applied.result.some(result => result?.success !== true)) {
        throw new Error(`${target} delta query did not return successful D1 results: HTTP ${response.status}`)
      }
    } else {
      // A remote `--file` import prints its upload progress to stdout ahead of
      // the JSON even with `--json`, and an interrupted import exits zero with
      // no JSON at all — so success is the parsed result, not the exit code.
      const importOutput = run(['d1', 'execute', 'DB', ...destination, '--file', payloadPath, '--json'], true)
      const imported = JSON.parse(importOutput.slice(importOutput.indexOf('['))) as Array<{ success: boolean }>
      if (!Array.isArray(imported) || imported.length === 0 || imported.some(result => result.success !== true)) {
        throw new Error(`${target} import did not return a successful D1 result`)
      }
    }
    if (!deltaFrom) {
      // Cross-environment payloads deliberately leave the destination's signing keys
      // untouched. Verify only the tables the payload actually replaces.
      const restoredTables = manifest.tables.filter(table => !(omitJwks && table.table === 'jwks'))
      // Rows of scalar counts: D1 refuses a UNION ALL across every table
      // ("too many terms in compound SELECT") and more than 100 result
      // columns, so the tables are counted 50 to a row.
      const loaded: Record<string, number> = {}
      for (let start = 0; start < restoredTables.length; start += 50) {
        const [counts] = query<Record<string, number>>(`SELECT ${restoredTables.slice(start, start + 50).map(table =>
          `(SELECT count(*) FROM ${identifier(table.table)}) AS ${identifier(table.table)}`,
        ).join(', ')}`)
        Object.assign(loaded, counts)
      }
      const mismatches = restoredTables.filter(table => loaded?.[table.table] !== table.target_rows)
      if (mismatches.length) throw new Error(`${target} import row counts differ: ${mismatches.map(table => table.table).join(', ')}`)
    }
    console.log(`Restored ${manifest.tables.length} tables (${rows} rows) from ${values.source} into ${target} D1${deltaFrom ? ' as a delta' : ''}.`)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
  rmSync(logDirectory, { recursive: true, force: true })
}
