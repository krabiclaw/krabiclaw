#!/usr/bin/env node
// Offline transfer of a database export into the current migration chain.
// Never imported by application runtime.
//
//   node scripts/transfer-database-export.mjs <source.sql|source.sqlite> <target.sqlite>
//     [--payload <payload.sql>] [--without-jwks] [--delta-from <earlier-target.sqlite>]
//
// A source is copied at the migration recorded in its D1 ledger, then the
// pending forward migrations run on the copy. Any ledger/schema mismatch
// fails visibly. The result is audited under CHECK and foreign-key enforcement.
//
// With --payload the script also writes the data-only replacement that
// `wrangler d1 execute --file` applies to a database built from the same
// migration chain. With --delta-from it instead inserts only the rows whose
// primary key the earlier transfer's target did not hold: the rows created in
// the source after the initial export, copied onto the live replacement.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { CONTENT_DOCUMENT_SCOPE_QUERY, MEDIA_PLACEMENT_OWNER_AUDIT_QUERY } from './audit-orphaned-media-placements.mjs'
import { isSupportedMediaPlacement } from '../shared/media-placement-contract.ts'
import { organizationRoles } from '../utils/organization-access.ts'
import { PRODUCT_KINDS } from '../shared/product-details.ts'

register('../tests/unit/support/alias-hooks.mjs', import.meta.url)

/** The roles the access matrix declares. Anything else evaluates to no permissions. */
const DECLARED_ORGANIZATION_ROLES = new Set(Object.keys(organizationRoles))

const MIGRATIONS_DIRECTORY = 'migrations'
const PREVIOUS_EPOCH_DIRECTORIES = ['migrations-history/v27', 'migrations-history/v28']
const hash = value => createHash('sha256').update(value).digest('hex')
const qi = value => `"${value.replaceAll('"', '""')}"`
const assert = (condition, message) => { if (!condition) throw new Error(message) }

function migrationFiles(directory) {
  return readdirSync(resolve(directory))
    .filter(name => /^\d{4}_.+\.sql$/u.test(name))
    .sort()
}

function migrationChainSql() {
  const migrations = migrationFiles(MIGRATIONS_DIRECTORY)
  assert(migrations[0] === '0000_baseline.sql', 'Migration chain must start with migrations/0000_baseline.sql')
  return migrations.map(name => readFileSync(resolve(MIGRATIONS_DIRECTORY, name), 'utf8')).join('\n')
}

/** SQLite may reformat whitespace outside literals when it persists DDL. */
function normalizedSchema(db) {
  return db.prepare(SCHEMA_OBJECTS_QUERY).all().map(row => {
    const sql = row.sql.split(/('(?:[^']|'')*')/).map((part, index) =>
      index % 2 ? part : part.replace(/\s+/g, ' ')).join('').trim()
    return `${row.type} ${row.name}\n${sql}`
  }).sort()
}

function sameSchema(left, right) {
  return JSON.stringify(normalizedSchema(left)) === JSON.stringify(normalizedSchema(right))
}

export function openDatabase(path) {
  if (!path.endsWith('.sql')) return new Database(path, { readonly: true, fileMustExist: true })
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  db.exec(readFileSync(path, 'utf8'))
  return db
}

const tableNames = db => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT IN ('d1_migrations', '__drizzle_migrations') ORDER BY name").all().map(row => row.name)
const columns = (db, table) => db.prepare(`PRAGMA table_info(${qi(table)})`).all().map(row => row.name)
const digest = (rows, names) => hash(rows.map(row => JSON.stringify(names.map(name => row[name]))).sort().join('\n'))

/** Advance a private copy; the original replacement artifact stays immutable. */
function comparisonDatabase(path) {
  const original = new Database(path, { readonly: true, fileMustExist: true })
  let comparison
  try { comparison = new Database(original.serialize()) } finally { original.close() }
  const expected = new Database(':memory:')
  try {
    const files = migrationFiles(MIGRATIONS_DIRECTORY)
    const hasManifest = existsSync(`${path}.manifest.json`)
    const recorded = hasManifest ? JSON.parse(readFileSync(`${path}.manifest.json`, 'utf8')) : null
    if (hasManifest) {
      assert(recorded && typeof recorded === 'object' && !Array.isArray(recorded), 'The initial transfer manifest is invalid')
      assert(recorded.baseline_sha256 === hash(readFileSync(resolve(MIGRATIONS_DIRECTORY, files[0]), 'utf8')), 'The initial transfer was built from another baseline')
    }
    const matches = []
    for (let index = 0; index < files.length; index++) {
      expected.exec(readFileSync(resolve(MIGRATIONS_DIRECTORY, files[index]), 'utf8'))
      if (sameSchema(comparison, expected)) matches.push(index)
    }
    let applied
    if (recorded?.target_migrations !== undefined) {
      assert(Array.isArray(recorded.target_migrations) && recorded.target_migrations.length > 0
        && JSON.stringify(recorded.target_migrations) === JSON.stringify(files.slice(0, recorded.target_migrations.length)), 'The initial transfer does not record a prefix of the current migration chain')
      applied = recorded.target_migrations.length - 1
      assert(matches.includes(applied), 'The initial transfer schema differs from its recorded migration stage')
    } else {
      assert(matches.length === 1, 'The initial transfer migration stage is unknown or ambiguous; explicitly reconcile its migration history before a final delta')
      applied = matches[0]
    }
    comparison.pragma('foreign_keys = ON')
    for (const file of files.slice(applied + 1)) comparison.exec(readFileSync(resolve(MIGRATIONS_DIRECTORY, file), 'utf8'))
    assert(sameSchema(comparison, expected), 'The initial transfer cannot advance to the current migration chain')
    assert(comparison.pragma('foreign_key_check').length === 0, 'The advanced comparison has foreign key violations')
    return comparison
  } catch (error) {
    comparison.close()
    throw error
  } finally { expected.close() }
}

const LOCALIZED_OWNER_TABLES = {
  organization: 'organization', business_location: 'business_locations', product: 'products',
  collection: 'collections', media_asset: 'media_assets', article_category: 'article_categories',
}

/** Every query must return no rows on a valid target. */
export const TARGET_INVARIANT_QUERIES = {
  article_tags_absent: "SELECT id FROM content_documents WHERE kind = 'article' AND json_type(metadata_json, '$.tags') IS NOT NULL",
  // Every media object is addressed by the organization that owns it; a key left
  // anywhere else is a row the rename did not reach.
  // A placement renders its asset; one left pointing at a deleted asset is a
  // broken image on a live page.
  placements_show_live_assets: `SELECT p.id FROM media_placements p JOIN media_assets a ON a.id = p.asset_id
    WHERE p.status = 'active' AND a.status = 'deleted'`,
  media_keys_live_under_their_organization: `SELECT id FROM media_assets
    WHERE r2_key IS NOT NULL AND instr(r2_key, 'organizations/' || organization_id || '/') <> 1`,
  retired_site_names_are_gone: `SELECT id FROM analytics_summaries WHERE kind = 'site_day'
    UNION ALL SELECT id FROM content_blocks WHERE data_json ->> '$.source' LIKE 'site\\_%' ESCAPE '\\'
    UNION ALL SELECT id FROM activity_entries WHERE json_type(payload_json, '$.visibility_scope') IS NOT NULL OR instr(payload_json ->> '$.deep_link', '/sites/') > 0`,
  media_owner_scope: MEDIA_PLACEMENT_OWNER_AUDIT_QUERY,
  document_owner_scope: `WITH scope AS (${CONTENT_DOCUMENT_SCOPE_QUERY}) SELECT d.id FROM content_documents d WHERE (SELECT count(*) FROM scope s WHERE s.id = d.id) <> 1`,
  editorial_representation_scope: `SELECT d.id FROM content_documents d WHERE d.row_role = 'representation' AND d.kind <> 'resource' AND NOT EXISTS (
    SELECT 1 FROM content_documents r WHERE r.id = d.root_id AND r.row_role = 'root'
      AND r.kind = d.kind AND r.organization_id = d.organization_id)`,
  organization_source_locale: `SELECT o.id FROM organization o WHERE
    (o.subdomain IS NOT NULL OR EXISTS(SELECT 1 FROM organization_locales l WHERE l.organization_id=o.id)
     OR EXISTS(SELECT 1 FROM content_documents d WHERE d.organization_id=o.id AND d.row_role='root'))
    AND (SELECT count(*) FROM organization_locales l WHERE l.organization_id=o.id AND l.is_source=1 AND l.status='published')<>1`,
  block_parent_scope: `SELECT b.id FROM content_blocks b WHERE b.parent_block_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM content_blocks p WHERE p.id = b.parent_block_id AND p.document_id = b.document_id)`,
  // Every localized resource is scoped by its organization. This used to add a
  // site to that scope for all but Product, which was the same organization
  // said twice.
  localized_resource_owner_scope: `SELECT r.id FROM content_documents r WHERE r.kind = 'resource' AND NOT (
    ${Object.entries(LOCALIZED_OWNER_TABLES).map(([type, table]) => `(r.resource_type = '${type}' AND EXISTS (SELECT 1 FROM ${table} o WHERE o.id = r.resource_id AND ${type === 'organization' ? 'o.id' : 'o.organization_id'} = r.organization_id))`).join(' OR ')})`,
  channel_thread_scope: `SELECT t.external_thread_id FROM channel_threads t JOIN conversations r ON r.id = t.conversation_id
    LEFT JOIN product_stay_configs c ON c.product_id = t.product_id AND c.organization_id = t.organization_id
    LEFT JOIN bookings b ON b.id = r.booking_id AND b.organization_id = r.organization_id
    WHERE r.kind <> 'booking' OR r.organization_id <> t.organization_id OR c.product_id IS NULL
       OR (CASE WHEN b.id IS NULL THEN r.location_id IS NOT c.location_id
          ELSE t.product_id IS NOT coalesce(b.booked_product_id, b.product_id) END)`,
  // A conversation titled by its channel is a channel's thread, or a channel reservation's that named no guest.
  channel_participant_addressable: `SELECT r.id FROM conversations r WHERE json_type(r.payload_json, '$.participant') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM channel_threads t WHERE t.conversation_id = r.id AND t.organization_id = r.organization_id)
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = r.booking_id AND b.organization_id = r.organization_id AND b.owner = 'channel')`,
  channel_booking_thread_scope: `SELECT t.external_thread_id FROM channel_threads t JOIN bookings s
    ON s.provider = t.provider AND s.external_booking_id = t.external_booking_id
    WHERE s.organization_id <> t.organization_id OR s.product_id <> t.product_id
      OR (SELECT c.id FROM conversations c WHERE c.booking_id = s.id AND c.kind = 'booking') IS NOT t.conversation_id`,
  // The retired model must leave no trace.
  no_hero_description: "SELECT id FROM content_blocks WHERE type = 'hero' AND json_type(data_json, '$.description') IS NOT NULL",
  no_slug_cased_page_titles: "SELECT id FROM content_documents WHERE kind = 'page' AND title IN ('home','about','contact','location','services','pricing','donate','schedule','privacy','terms','third-party-notices')",
  no_offering_grid_blocks: "SELECT id FROM content_blocks WHERE type = 'offering_grid'",
  // Every Product is buyable: at least one variant. SQL cannot express this as
  // a constraint without making inserts circular, so it is audited here.
  every_product_has_a_variant: 'SELECT p.id FROM products p WHERE NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)',
  // A place to stay is at one location with its stay settings; the kind alone is not a home.
  every_home_has_stay_settings: "SELECT p.id FROM products p WHERE p.kind = 'stay' AND NOT EXISTS (SELECT 1 FROM product_stay_configs c WHERE c.organization_id = p.organization_id AND c.product_id = p.id)",
  // A location-scoped price belongs to a product that location actually offers.
  price_location_scope: `SELECT p.id FROM prices p WHERE p.location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM product_variants v JOIN product_locations pl ON pl.product_id = v.product_id AND pl.location_id = p.location_id
     WHERE v.id = p.product_variant_id)`,
  // A page grid names pages published by the same organization.
  page_grid_targets_exist: `SELECT b.id FROM content_blocks b, json_each(b.data_json, '$.page_ids') j
    WHERE b.type = 'page_grid' AND NOT EXISTS (
      SELECT 1 FROM content_documents d JOIN content_documents owner ON owner.id = b.document_id
       WHERE d.id = j.value AND d.kind = 'page' AND d.row_role = 'root' AND d.organization_id = owner.organization_id)`,
  // A booking holds a seat at a real occurrence of the product it names.
  booking_session_scope: `SELECT b.id FROM bookings b WHERE b.product_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM product_sessions s WHERE s.id = b.product_session_id AND s.product_id = b.product_id)`,
  // `visibility` says whether a document is listed in its index, and those are
  // the only two answers. The CHECK covers root articles and social posts; this
  // covers every row, so a value stranded on a kind the CHECK does not reach is
  // still caught.
  document_visibility_is_listed_or_unlisted: `SELECT id FROM content_documents
    WHERE visibility IS NOT NULL AND visibility NOT IN ('listed', 'unlisted')`,
  // Social posts are read by the social_posts block from the canonical feed;
  // a grid that copied them, or a block holding its own copy, is stale data.
  social_posts_are_read_not_copied: `SELECT id FROM content_blocks WHERE (type = 'feature_grid' AND data_json ->> '$.source' = 'organization_updates')
    OR (type = 'social_posts' AND json_type(data_json, '$.items') IS NOT NULL)`,

}

export async function auditTargetInvariants(target) {
  const results = Object.entries(TARGET_INVARIANT_QUERIES).map(([name, query]) => ({
    name, violations: target.prepare(query).all().reduce((total, row) => total + Number(row.orphaned_count ?? 1), 0), sql_sha256: hash(query),
  }))
  // The owner/slot vocabulary is declared in TypeScript, not in SQL: a slot the
  // contract does not know renders nowhere, and no constraint would catch it.
  const placements = target.prepare('SELECT DISTINCT owner_type, slot FROM media_placements').all()
  const unsupported = placements.filter(row => !isSupportedMediaPlacement(row))
  results.push({ name: 'media_placement_slots_are_declared', violations: unsupported.length, unsupported: unsupported.map(row => `${row.owner_type}:${row.slot}`) })
  // Roles are declared in TypeScript (utils/organization-access.ts), not in SQL.
  // A role the matrix does not know evaluates to no permissions at all, so a row
  // carrying a retired one is a person who quietly cannot reach their own tenant.
  //
  // This fails rather than rewriting the row. Mapping a retired role onto a
  // surviving one is a privilege decision: `member` granted nothing and
  // `editor` was scoped to a single location, so rewriting either to `admin`
  // hands out settings, billing and member management that nobody approved —
  // and an audit that accepts the resulting `admin` cannot see it happened.
  // Whoever runs the transfer resolves the row first.
  //
  // Only live authorization counts. A member row authorizes; an invitation
  // authorizes while it is pending. An accepted or revoked one is a record of
  // what happened and grants nothing.
  const roles = target.prepare(`
    SELECT DISTINCT role FROM member WHERE role IS NOT NULL
    UNION SELECT DISTINCT role FROM invitation WHERE role IS NOT NULL AND status = 'pending'
  `).all().map(row => String(row.role))
  const undeclared = roles.filter(role => !DECLARED_ORGANIZATION_ROLES.has(role))
  results.push({ name: 'organization_roles_are_declared', violations: undeclared.length, undeclared })
  // The R2 keys are the ones this transfer rewrites, and the objects were
  // copied to organizations/<id>/ in R2, outside this file. So every active
  // R2 row's public URL is fetched: one that does not answer 200 is an image
  // the rewrite would break, and the transfer names it. A deleted asset's
  // object is gone on purpose.
  const media = target.prepare("SELECT id, public_url FROM media_assets WHERE status = 'active' AND provider = 'cloudflare_r2' AND public_url IS NOT NULL").all()
  const unserved = []
  let dnsRetries = 0
  for (let offset = 0; offset < media.length; offset += 12) {
    const batch = await Promise.all(media.slice(offset, offset + 12).map(async (row) => {
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await fetch(String(row.public_url), { method: 'HEAD', signal: AbortSignal.timeout(20_000) })
          return response.status === 200 ? null : `${row.id} ${row.public_url}: HTTP ${response.status}`
        } catch (error) {
          // "fetch failed" says nothing; the reason is its cause.
          const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null
          const code = cause && Reflect.get(cause, 'code')
          if (attempt < 3 && (code === 'ENOTFOUND' || code === 'EAI_AGAIN')) {
            dnsRetries++
            await delay(250 * attempt)
            continue
          }
          const detail = cause ? [code, Reflect.get(cause, 'syscall'), Reflect.get(cause, 'hostname'), cause.message].filter(Boolean).join(' ') : null
          return `${row.id} ${row.public_url}: ${error instanceof Error ? error.message : String(error)}${detail ? ` (${detail})` : ''} after ${attempt} attempt(s)`
        }
      }
    }))
    unserved.push(...batch.filter(Boolean))
  }
  results.push({ name: 'media_objects_are_served', violations: unserved.length, unserved, dns_retries: dnsRetries })
  return results
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`
  return `'${String(value).replaceAll("'", "''")}'`
}

/** Child-first order: a table appears before every table it references. */
function childFirstOrder(db, tables) {
  const fks = tables.flatMap(table => db.prepare(`PRAGMA foreign_key_list(${qi(table)})`).all().map(row => ({ child: table, parent: row.table })))
  // requests -> reviews -> review_requests -> requests is the schema's cycle; requests leads.
  const order = tables.includes('requests') ? ['requests'] : []
  const pending = new Set(tables.filter(table => !order.includes(table)))
  while (pending.size) {
    const leaves = [...pending].filter(table => !fks.some(fk => fk.parent === table && fk.child !== table && pending.has(fk.child))).sort()
    assert(leaves.length > 0, `Unresolved foreign key cycle: ${[...pending].join(', ')}`)
    for (const table of leaves) { order.push(table); pending.delete(table) }
  }
  return order
}

/** Primary-key columns in key order; a table without one cannot be copied as a delta. */
function primaryKey(db, table) {
  return db.prepare(`PRAGMA table_info(${qi(table)})`).all().filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name)
}

// Restore local claims before channel claims. A channel may have sold a night
// that was already occupied by a local booking.
function transferRows(db, table, projection = '*') {
  const order = table === 'stay_nights'
    ? " ORDER BY (SELECT owner FROM bookings WHERE id = stay_nights.booking_id) = 'channel'"
    : ''
  return db.prepare(`SELECT ${projection} FROM ${qi(table)}${order}`).all()
}

/**
 * The full replacement, or with `deltaFrom` only the rows the earlier target
 * did not hold. A delta never deletes or updates: it is applied to a live
 * replacement database that has taken its own writes since, and a row it
 * cannot insert fails the import visibly rather than overwriting one.
 */
export function writePayload(target, payloadPath, schemaSql, { withoutJwks = false, deltaFrom = null } = {}) {
  const tables = tableNames(target).filter(table => !(withoutJwks && table === 'jwks'))
  const order = childFirstOrder(target, tables)
  const earlier = deltaFrom ? comparisonDatabase(deltaFrom) : null
  const delta = {}
  const leftBehind = {}
  try {
    const lines = ['PRAGMA foreign_keys = OFF;', 'PRAGMA defer_foreign_keys = ON;', ...(earlier ? [] : order.map(table => `DELETE FROM ${qi(table)};`))]
    let chunkedText = false
    for (const table of [...order].reverse()) {
      const names = columns(target, table)
      let rows = transferRows(target, table)
      if (earlier) {
        const key = primaryKey(target, table)
        assert(key.length > 0, `${table} has no primary key, so its new rows cannot be told apart`)
        const held = new Set(earlier.prepare(`SELECT ${key.map(qi).join(', ')} FROM ${qi(table)}`).raw().all().map(values => JSON.stringify(values)))
        rows = rows.filter(row => !held.has(JSON.stringify(key.map(name => row[name]))))
        delta[table] = rows.length
        // A delta carries creations only. What it leaves behind is every row
        // the earlier target held whose values have changed since, or which is
        // gone from the source. Those are named, table by table, for whoever
        // repoints the binding to read first; nothing is updated for them.
        const current = new Map(target.prepare(`SELECT * FROM ${qi(table)}`).all().map(row => [JSON.stringify(key.map(name => row[name])), JSON.stringify(names.map(name => row[name]))]))
        const changed = []
        const deleted = []
        for (const row of transferRows(earlier, table)) {
          const id = JSON.stringify(key.map(name => row[name]))
          if (!current.has(id)) deleted.push(id)
          else if (current.get(id) !== JSON.stringify(names.map(name => row[name]))) changed.push(id)
        }
        if (changed.length || deleted.length) leftBehind[table] = { changed, deleted }
      }
      for (const row of rows) {
        let values = names.map(name => sqlLiteral(row[name]))
        const insert = () => `INSERT INTO ${qi(table)} (${names.map(qi).join(', ')}) VALUES (${values.join(', ')});`
        // A D1 row may hold 2 MB, but each SQL statement is limited to 100 KB.
        // Assemble oversized text inside this import, preserving its exact bytes
        // and JSON constraints. The import table is removed before verification.
        if (Buffer.byteLength(insert()) > 100_000) {
          if (!chunkedText) lines.push('CREATE TABLE IF NOT EXISTS __transfer_payload_text (column_name TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (column_name, part));')
          chunkedText = true
          lines.push('DELETE FROM __transfer_payload_text;')
          values = names.map(name => {
            if (typeof row[name] !== 'string') return sqlLiteral(row[name])
            let text = '', bytes = 0, part = 0
            const flush = () => { lines.push(`INSERT INTO __transfer_payload_text VALUES (${sqlLiteral(name)}, ${part++}, ${sqlLiteral(text)});`); text = ''; bytes = 0 }
            for (const character of row[name]) {
              const size = Buffer.byteLength(character)
              if (bytes + size > 40_000) flush()
              text += character; bytes += size
            }
            flush()
            return `(SELECT group_concat(value, '') FROM (SELECT value FROM __transfer_payload_text WHERE column_name=${sqlLiteral(name)} ORDER BY part))`
          })
        }
        assert(Buffer.byteLength(insert()) <= 100_000, `D1 statement exceeds 100 KB: ${table}`)
        lines.push(insert())
      }
    }
    if (chunkedText) lines.push('DROP TABLE __transfer_payload_text;')
    lines.push('PRAGMA foreign_keys = ON;')
    writeFileSync(payloadPath, lines.join('\n') + '\n', { mode: 0o600 })

    const replay = new Database(':memory:')
    try {
      replay.exec(schemaSql)
      replay.pragma('foreign_keys = ON')
      if (earlier) {
        // The delta lands on what the earlier target held and must complete it:
        // every row of this target is then present, and nothing dangles.
        replay.pragma('foreign_keys = OFF')
        for (const table of tables) {
          const names = columns(earlier, table)
          const insert = replay.prepare(`INSERT INTO ${qi(table)} (${names.map(qi).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
          for (const row of transferRows(earlier, table)) insert.run(...names.map(name => row[name]))
        }
        replay.pragma('foreign_keys = ON')
        replay.exec(readFileSync(payloadPath, 'utf8'))
        for (const table of tables) {
          const key = primaryKey(target, table)
          const present = new Set(replay.prepare(`SELECT ${key.map(qi).join(', ')} FROM ${qi(table)}`).raw().all().map(values => JSON.stringify(values)))
          const missing = target.prepare(`SELECT ${key.map(qi).join(', ')} FROM ${qi(table)}`).raw().all().filter(values => !present.has(JSON.stringify(values)))
          assert(missing.length === 0, `Delta replay is missing ${missing.length} ${table} rows`)
        }
      } else {
        // Replaying the payload onto a populated copy must reproduce the target exactly.
        replay.exec(readFileSync(payloadPath, 'utf8'))
        replay.exec(readFileSync(payloadPath, 'utf8'))
        for (const table of tables) {
          const names = columns(target, table)
          assert(digest(target.prepare(`SELECT * FROM ${qi(table)}`).all(), names) === digest(replay.prepare(`SELECT * FROM ${qi(table)}`).all(), names), `Payload replay differs: ${table}`)
        }
      }
      assert(replay.pragma('foreign_key_check').length === 0, 'Payload replay has foreign key violations')
    } finally {
      replay.close()
    }
    return { tables: tables.length, statements: lines.length, ...(earlier ? { delta, left_behind: leftBehind } : {}) }
  } finally {
    earlier?.close()
  }
}

/** Every schema object, as SQLite reports it; what a destination must carry for the payload to apply. */
export const SCHEMA_OBJECTS_QUERY = "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND tbl_name NOT IN ('d1_migrations', '__drizzle_migrations') ORDER BY type, name"

/**
 * @typedef {{ table: string, source_rows: number, target_rows: number }} TableTransfer
 * @typedef {{ baseline_sha256: string, source_migrations: string[], target_migrations: string[], tables: TableTransfer[], transforms: Array<{ name: string, changes: number, sql_sha256: string }>,
 *   invariants: Array<{ name: string, violations: number, sql_sha256: string }>, payload?: { tables: number, statements: number, delta?: Record<string, number>, left_behind?: Record<string, { changed: string[], deleted: string[] }> },
 *   schema?: Array<{ type: string, name: string, sql: string }> }} TransferManifest
 */

/**
 * Copy an export of the current migration chain into a new target. The
 * source's D1 ledger names the exact applied files and their order, so an
 * interleaved branch history keeps its pending data-only migrations.
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {{ payloadPath?: string | null, withoutJwks?: boolean, deltaFrom?: string | null }} [options]
 * @returns {Promise<TransferManifest>}
 */
export async function transferDatabaseExport(sourcePath, targetPath, { payloadPath = null, withoutJwks = false, deltaFrom = null } = {}) {
  assert(!existsSync(targetPath), `Target already exists: ${targetPath}`)
  assert(!deltaFrom || payloadPath, 'A delta is a payload; pass --payload with --delta-from')
  const files = migrationFiles(MIGRATIONS_DIRECTORY)
  assert(files[0] === '0000_baseline.sql', 'Migration chain must start with migrations/0000_baseline.sql')
  const baseSql = readFileSync(resolve(MIGRATIONS_DIRECTORY, files[0]), 'utf8')
  const schemaSql = migrationChainSql()
  const source = openDatabase(resolve(sourcePath))
  let stage
  // The target holds customer and credential rows during preflight. Create it
  // privately before SQLite opens it, including when --out keeps the file.
  writeFileSync(targetPath, '', { flag: 'wx', mode: 0o600 })
  const target = new Database(targetPath)
  /** @type {TransferManifest} */
  const manifest = {
    baseline_sha256: hash(baseSql), source_migrations: [], target_migrations: files, tables: [], transforms: [], invariants: [],
  }
  try {
    const hasLedger = source.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'").get().n === 1
    const ledger = hasLedger ? source.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map(row => row.name) : []
    manifest.source_migrations = ledger
    assert(ledger.length > 0, 'Source migration ledger is missing')
    const applied = new Set(ledger)
    assert(applied.size === ledger.length, 'Source migration ledger contains duplicate filenames')
    assert(ledger[0] === '0000_baseline.sql', 'Source migration ledger must start with 0000_baseline.sql')
    const sourceChain = [MIGRATIONS_DIRECTORY, ...PREVIOUS_EPOCH_DIRECTORIES].find(directory => {
      const migrations = migrationFiles(directory)
      if (!ledger.every((name, index) => name === migrations[index])) return false
      const candidate = new Database(':memory:')
      try {
        candidate.exec(ledger.map(name => readFileSync(resolve(directory, name), 'utf8')).join('\n'))
        if (!sameSchema(source, candidate)) return false
        stage = candidate
        return true
      } finally {
        if (stage !== candidate) candidate.close()
      }
    })
    assert(sourceChain && stage, 'Source schema differs from its recorded migration stage; no rows were copied')
    stage.pragma('foreign_keys = OFF')
    const sourceTables = tableNames(source)
    for (const table of sourceTables) {
      const tableColumns = columns(stage, table)
      assert(JSON.stringify(columns(source, table)) === JSON.stringify(tableColumns), `${table}: source columns differ from the schema being copied`)
      const rows = transferRows(source, table)
      const insert = stage.prepare(`INSERT INTO ${qi(table)} (${tableColumns.map(qi).join(',')}) VALUES (${tableColumns.map(() => '?').join(',')})`)
      for (const row of rows) insert.run(...tableColumns.map(name => row[name]))
      assert(digest(rows, tableColumns) === digest(stage.prepare(`SELECT * FROM ${qi(table)}`).all(), tableColumns), `${table}: copy differs`)
    }
    const forward = migrationFiles(sourceChain).slice(ledger.length).map(name => resolve(sourceChain, name))
    if (sourceChain === PREVIOUS_EPOCH_DIRECTORIES[0]) {
      // v28 was a new baseline of the end of v27. Its forward migrations apply to those same rows.
      const nextEpoch = PREVIOUS_EPOCH_DIRECTORIES[1]
      forward.push(...migrationFiles(nextEpoch).slice(1).map(name => resolve(nextEpoch, name)))
    }
    for (const migration of forward) stage.exec(readFileSync(migration, 'utf8'))
    const unsupported = stage.prepare('SELECT organization_id, id, kind FROM products ORDER BY organization_id, id').all().filter(row => !PRODUCT_KINDS.includes(row.kind))
    assert(unsupported.length === 0, `Unsupported offerings: ${unsupported.map(row => `${row.organization_id}/${row.id} (${row.kind})`).join(', ')}; no rows were copied`)
    const names = tableNames(stage)
    const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${qi(table)}`).get().n
    target.exec(schemaSql)
    target.pragma('foreign_keys = OFF')
    target.transaction(() => {
      for (const table of names) {
        const targetColumns = columns(target, table)
        const rows = transferRows(stage, table, targetColumns.map(qi).join(','))
        const insert = target.prepare(`INSERT INTO ${qi(table)} (${targetColumns.map(qi).join(',')}) VALUES (${targetColumns.map(() => '?').join(',')})`)
        for (const row of rows) insert.run(...targetColumns.map(name => row[name]))
        assert(digest(rows, targetColumns) === digest(target.prepare(`SELECT * FROM ${qi(table)}`).all(), targetColumns), `${table}: target copy differs`)
      }
    })()
    manifest.tables = names.map(table => ({ table, source_rows: sourceTables.includes(table) ? count(source, table) : 0, target_rows: count(target, table) }))
    const violations = target.pragma('foreign_key_check')
    assert(violations.length === 0, `Foreign key violations after transfer (${violations.length}): ${JSON.stringify(violations.slice(0, 8))}`)
    assert(target.pragma('integrity_check', { simple: true }) === 'ok', 'Integrity check failed')
    const expected = new Database(':memory:')
    expected.exec(schemaSql)
    manifest.schema = target.prepare(SCHEMA_OBJECTS_QUERY).all()
    assert(sameSchema(target, expected), 'Target schema differs from the migration chain')
    expected.close()
    manifest.invariants = await auditTargetInvariants(target)
    const broken = manifest.invariants.filter(result => result.violations > 0)
    assert(broken.length === 0, `Invariant violations: ${JSON.stringify(broken)}`)
    if (payloadPath) manifest.payload = writePayload(target, payloadPath, schemaSql, { withoutJwks, deltaFrom })
    writeFileSync(`${targetPath}.manifest.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    return manifest
  } finally {
    source.close()
    stage?.close()
    target.close()
  }
}

/** The row-count comparison a cutover reads before it repoints anything. */
export function printTransferReport(manifest) {
  const width = Math.max(...manifest.tables.map(entry => entry.table.length))
  console.log(`${'table'.padEnd(width)}  source  target`)
  for (const entry of manifest.tables) {
    console.log(`${entry.table.padEnd(width)}  ${String(entry.source_rows).padStart(6)}  ${String(entry.target_rows).padStart(6)}${entry.source_rows === entry.target_rows ? '' : '  (changed by a forward migration or transform)'}`)
  }
  console.log(`Transforms: ${manifest.transforms.filter(transform => transform.changes > 0).map(transform => `${transform.name}=${transform.changes}`).join(', ') || 'no changes'}`)
  const media = manifest.invariants.find(result => result.name === 'media_objects_are_served')
  if (media?.dns_retries) console.log(`Media audit repeated ${media.dns_retries} failed DNS lookup(s); all active R2 media returned HTTP 200.`)
  for (const [table, rows] of Object.entries(manifest.payload?.left_behind ?? {})) {
    if (rows.changed.length) console.log(`Not carried, changed since the initial export: ${table} ${rows.changed.length}: ${rows.changed.join(' ')}`)
    if (rows.deleted.length) console.log(`Not carried, deleted since the initial export: ${table} ${rows.deleted.length}: ${rows.deleted.join(' ')}`)
  }
  if (manifest.payload?.delta) console.log(`Delta: ${Object.entries(manifest.payload.delta).filter(([, rows]) => rows > 0).map(([table, rows]) => `${table}=${rows}`).join(', ') || 'no new rows'}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = name => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 1).length > 0 : false }
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : null }
  const withoutJwks = flag('--without-jwks')
  const payloadPath = option('--payload')
  const deltaFrom = option('--delta-from')
  const [sourcePath, targetPath] = args
  if (!sourcePath || !targetPath) throw new Error('Usage: transfer-database-export.mjs <source.sql|source.sqlite> <target.sqlite> [--payload <payload.sql>] [--without-jwks] [--delta-from <earlier-target.sqlite>]')
  printTransferReport(await transferDatabaseExport(sourcePath, targetPath, { payloadPath, withoutJwks, deltaFrom }))
  console.log('Transfer passed.')
}
