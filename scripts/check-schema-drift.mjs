#!/usr/bin/env node
//
//   node scripts/check-schema-drift.mjs --env staging | --production
//
// The live database's schema is what the full migration chain builds.
// `d1 migrations apply` skips a tag already in `d1_migrations`, so a
// regenerated baseline would otherwise leave the database on what it first
// carried. A replacement baseline needs a new D1 resource.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

const { values: options } = parseArgs({
  options: { env: { type: 'string' }, production: { type: 'boolean', default: false } },
  strict: true,
})
if (Boolean(options.env) === options.production) throw new Error('Choose one of --env <name> or --production.')
const target = options.production ? 'production' : options.env

const root = process.cwd()
const temporaryParent = join(root, '.tmp')
mkdirSync(temporaryParent, { recursive: true })
const temporaryRoot = mkdtempSync(join(temporaryParent, 'schema-drift-'))

/**
 * Formatting differences are not schema differences, but the contents of a
 * string literal are: `status IN ('a', 'b')` and `status IN ('a',  'b')` are the
 * same constraint, while `'a  b'` and `'a b'` are different values. So
 * whitespace collapses between literals and is left alone inside them.
 */
function normalizeSql(sql) {
  return sql
    .split(/('(?:[^']|'')*')/)
    .map((part, index) => (index % 2 ? part : part.replace(/\s+/g, ' ')))
    .join('')
    .trim()
}

/** Every object the baseline defines, as the database itself reports it. */
function schemaOf(rows) {
  return rows
    .filter(row => row.name && !row.name.startsWith('sqlite_') && !row.name.startsWith('_cf_') && row.name !== 'd1_migrations')
    .map(row => `${row.type} ${row.name}\n${normalizeSql(row.sql ?? '')}`)
    .sort()
}

const SCHEMA_QUERY = "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'"

try {
  compareLiveSchema(target)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}

function compareLiveSchema(name) {
  const scratch = join(temporaryRoot, 'baseline.sqlite')
  const database = new DatabaseSync(scratch)
  for (const file of readdirSync(join(root, 'migrations')).filter(entry => entry.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join(root, 'migrations', file), 'utf8').replaceAll('--> statement-breakpoint', ''))
  }
  const expected = schemaOf(database.prepare(SCHEMA_QUERY).all())
  database.close()

  const args = ['d1', 'execute', 'DB', '--remote', '--json', '--command', SCHEMA_QUERY]
  if (name !== 'production') args.splice(3, 0, '--env', name)
  const result = spawnSync(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Could not read the ${name} schema: ${(result.stderr || result.stdout || '').trim()}`)
  const live = schemaOf(JSON.parse(result.stdout.slice(result.stdout.indexOf('[')))[0].results)

  const missing = expected.filter(entry => !live.includes(entry))
  const extra = live.filter(entry => !expected.includes(entry))
  if (missing.length || extra.length) {
    const name0 = entry => entry.split('\n')[0]
    throw new Error([
      `The ${name} database does not carry the schema this migration chain builds.`,
      'Apply pending forward migrations, or use the documented replacement procedure for a changed constraint on a referenced table.',
      missing.length ? `  the baseline defines, the database lacks: ${missing.map(name0).join(', ')}` : '',
      extra.length ? `  the database carries, the baseline does not: ${extra.map(name0).join(', ')}` : '',
    ].filter(Boolean).join('\n'))
  }
  console.log(`The ${name} database carries the schema this migration chain builds.`)
}
