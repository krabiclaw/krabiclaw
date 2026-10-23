#!/usr/bin/env node
// Offline transfer of a database export into the current migration chain.
// Never imported by application runtime.
//
//   node scripts/transfer-database-export.mjs <source.sql|source.sqlite> <target.sqlite>
//     [--payload <payload.sql>] [--without-jwks] [--delta-from <earlier-target.sqlite>]
//
// A source is copied at the migration recorded in its D1 ledger, then the
// pending forward migrations run on the copy. Recognized archived schemas are
// transferred into the current baseline. Any ledger/schema mismatch
// fails visibly. The result is audited under CHECK and foreign-key enforcement.
//
// With --payload the script also writes the data-only replacement that
// `wrangler d1 execute --file` applies to a database built from the same
// migration chain. With --delta-from it instead inserts only the rows whose
// primary key the earlier transfer's target did not hold: the rows created in
// the source after the initial export, copied onto the live replacement.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { CONTENT_DOCUMENT_SCOPE_QUERY, MEDIA_PLACEMENT_OWNER_AUDIT_QUERY } from './audit-orphaned-media-placements.mjs'
import { isSupportedMediaPlacement } from '../shared/media-placement-contract.ts'
import { organizationRoles } from '../utils/organization-access.ts'
import { PRODUCT_KINDS, validateProductDetails, assertProductKind } from '../shared/product-details.ts'
import { DEFAULT_SITE_PALETTE, parseSitePalette } from '../shared/site-palette.ts'
import { getDarkModeVariant } from '../utils/color-utils.ts'

register('../tests/unit/support/alias-hooks.mjs', import.meta.url)

/** The roles the access matrix declares. Anything else evaluates to no permissions. */
const DECLARED_ORGANIZATION_ROLES = new Set(Object.keys(organizationRoles))

const MIGRATIONS_DIRECTORY = 'migrations'
const hash = value => createHash('sha256').update(value).digest('hex')
const qi = value => `"${value.replaceAll('"', '""')}"`
const assert = (condition, message) => { if (!condition) throw new Error(message) }

function migrationChainSql() {
  const migrations = readdirSync(resolve(MIGRATIONS_DIRECTORY))
    .filter(name => /^\d{4}_.+\.sql$/u.test(name))
    .sort()
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

/**
 * Columns the current schema dropped, so a v7 export still carries them. Each
 * is either mapped below or must hold nothing; a value nobody maps fails.
 */
const RETIRED_COLUMNS = {
  organization: ['integrations_json', 'feature_overrides'],
  business_locations: ['description_provenance', 'feature_overrides'],
  products: ['tags'],
  product_booking_configs: ['online_timezone', 'calendar_group'],
  payment_checkout_holds: ['calendar_group'],
}

/**
 * v7 kept each organization's connections as keys of
 * `organization.integrations_json`; v8 keeps one `organization_integrations`
 * row per connection. Every key maps to exactly one row or the transfer fails.
 */
const INTEGRATION_KEYS = {
  facebook: { target_id: 'page_id', target_name: 'page_name' },
  instagram: { target_id: 'instagram_user_id', target_name: 'username' },
  google_analytics: { target_id: 'property_id', target_name: 'property_name' },
  google_search_console: { target_id: 'site_url', target_name: 'site_url' },
}

/**
 * Blawby's built-in colors before v13, as `settings_json.theme_by_template`
 * stored them. v13 has no per-template token store; stored tokens equal to
 * these are the template's own palette, and any other value fails the transfer.
 */
const BLAWBY_V12_TOKENS = {
  bg: '#fbfaf7', surface: '#ffffff', primary: '#25356c', primaryDark: '#161f3b', primary100: '#f2f5ff',
  primary200: '#b4c5e5', primary800: '#1d294f', accent: '#c19855', accent100: '#faf5ea', accent200: '#f8f0e1',
  accentButton: '#b58c4f', accentStrong: '#a37732', border: '#e5e7eb', ink: '#162033',
}
const SAYA_THEME_ID = 'saya-theme-v1'
const SAYA_LOGO_PRESENTATION = JSON.stringify({ shape: 'circle', focus: { x: 0.5, y: 0.5 } })

/**
 * v13 replaces `config.brand_color` (Saya's one accent) and the unwritten
 * `theme_by_template` tokens with `config.palette`. A Saya brand color becomes
 * the action color of Saya's palette, lightened for dark mode once, here.
 */
function sitePaletteChanges(stage) {
  let changes = 0
  const update = stage.prepare('UPDATE organization SET settings_json = ? WHERE id = ?')
  for (const organization of stage.prepare("SELECT id, theme_id, settings_json FROM organization WHERE json_type(settings_json, '$.config.brand_color') IS NOT NULL OR json_type(settings_json, '$.theme_by_template') IS NOT NULL").all()) {
    const settings = JSON.parse(organization.settings_json)
    const brandColor = settings.config?.brand_color
    if (brandColor !== undefined) {
      assert(typeof brandColor === 'string' && /^#[0-9a-f]{6}$/iu.test(brandColor), `organization ${organization.id} brand_color ${JSON.stringify(brandColor)} is not a #RRGGBB color; no rows were copied`)
      assert(organization.theme_id === SAYA_THEME_ID, `organization ${organization.id} has a brand_color outside Saya; nothing maps it; no rows were copied`)
      const saya = DEFAULT_SITE_PALETTE
      settings.config.palette = parseSitePalette({
        light: { ...saya.light, action: brandColor },
        dark: { ...saya.dark, action: getDarkModeVariant(brandColor) },
      })
      delete settings.config.brand_color
    }
    for (const [template, theme] of Object.entries(settings.theme_by_template ?? {})) {
      assert(template === 'blawby' && theme !== null && typeof theme === 'object' && JSON.stringify(theme.tokens) === JSON.stringify(BLAWBY_V12_TOKENS),
        `organization ${organization.id} theme_by_template.${template} holds tokens other than Blawby's defaults; nothing maps them; no rows were copied`)
    }
    delete settings.theme_by_template
    update.run(JSON.stringify(settings), organization.id)
    changes++
  }
  return changes
}

function integrationRows(stage) {
  const rows = []
  for (const organization of stage.prepare("SELECT id, integrations_json FROM organization WHERE integrations_json <> '{}'").all()) {
    for (const [provider, value] of Object.entries(JSON.parse(organization.integrations_json))) {
      const keys = INTEGRATION_KEYS[provider]
      assert(keys, `${organization.id}: unmapped integration ${provider}`)
      assert(value.status === 'active', `${organization.id}: ${provider} is ${value.status}; only an active connection maps`)
      const row = {
        id: `${organization.id}:${provider}`, organization_id: organization.id, provider, account_id: value.account_id,
        target_id: value[keys.target_id], target_name: value[keys.target_name],
        measurement_id: provider === 'google_analytics' ? value.measurement_id : null,
        verified: provider === 'google_search_console' ? Number(Boolean(value.verified)) : null,
        verification_token: provider === 'google_search_console' ? value.verification_token ?? null : null,
        revision: value.revision, created_at: value.created_at, updated_at: value.updated_at,
      }
      for (const name of ['account_id', 'target_id', 'target_name', 'revision', 'created_at', 'updated_at', ...(provider === 'google_analytics' ? ['measurement_id'] : [])]) {
        assert(typeof row[name] === 'string' && row[name].trim(), `${organization.id}: ${provider}.${name} is missing`)
      }
      rows.push(row)
    }
  }
  return rows
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
  editorial_representation_scope: `SELECT d.id FROM content_documents d WHERE d.row_role = 'representation' AND NOT EXISTS (
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
  localized_resource_owner_scope: `SELECT r.id FROM resource_localizations r WHERE NOT (
    ${Object.entries(LOCALIZED_OWNER_TABLES).map(([type, table]) => `(r.resource_type = '${type}' AND EXISTS (SELECT 1 FROM ${table} o WHERE o.id = r.resource_id AND ${type === 'organization' ? 'o.id' : 'o.organization_id'} = r.organization_id))`).join(' OR ')})`,
  activity_request_scope: `SELECT e.id FROM activity_entries e WHERE e.scope_kind = 'request' AND NOT EXISTS (
    SELECT 1 FROM requests r WHERE r.id = e.request_id AND r.kind IN ('contact','reservation','booking','stay'))`,
  channel_thread_scope: `SELECT t.external_thread_id FROM channel_threads t JOIN requests r ON r.id = t.request_id
    JOIN product_stay_configs c ON c.product_id = t.product_id AND c.organization_id = t.organization_id
    WHERE r.kind <> 'stay' OR r.organization_id <> t.organization_id OR r.location_id IS NOT c.location_id`,
  channel_participant_addressable: `SELECT r.id FROM requests r WHERE json_type(r.payload_json, '$.participant') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM channel_threads t WHERE t.request_id = r.id AND t.organization_id = r.organization_id)`,
  channel_booking_thread_scope: `SELECT t.external_thread_id FROM channel_threads t JOIN stays s
    ON s.provider = t.provider AND s.external_booking_id = t.external_booking_id
    WHERE s.organization_id <> t.organization_id OR s.product_id <> t.product_id OR s.request_id IS NOT t.request_id`,
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
  booking_session_scope: `SELECT b.id FROM bookings b WHERE NOT EXISTS (
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

export function auditTargetInvariants(target) {
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
  const unserved = media.filter(row => {
    const probe = spawnSync('curl', ['-s', '-o', '/dev/null', '-I', '-w', '%{http_code}', '--max-time', '20', String(row.public_url)], { encoding: 'utf8' })
    if (probe.error) throw probe.error
    return probe.stdout.trim() !== '200'
  })
  results.push({ name: 'media_objects_are_served', violations: unserved.length, unserved: unserved.map(row => `${row.id} ${row.public_url}`) })
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

/**
 * The full replacement, or with `deltaFrom` only the rows the earlier target
 * did not hold. A delta never deletes or updates: it is applied to a live
 * replacement database that has taken its own writes since, and a row it
 * cannot insert fails the import visibly rather than overwriting one.
 */
export function writePayload(target, payloadPath, schemaSql, { withoutJwks = false, deltaFrom = null } = {}) {
  const tables = tableNames(target).filter(table => !(withoutJwks && table === 'jwks'))
  const order = childFirstOrder(target, tables)
  const earlier = deltaFrom ? new Database(deltaFrom, { readonly: true, fileMustExist: true }) : null
  const delta = {}
  const leftBehind = {}
  try {
    const lines = ['PRAGMA foreign_keys = OFF;', 'PRAGMA defer_foreign_keys = ON;', ...(earlier ? [] : order.map(table => `DELETE FROM ${qi(table)};`))]
    let chunkedText = false
    for (const table of [...order].reverse()) {
      const names = columns(target, table)
      let rows = target.prepare(`SELECT * FROM ${qi(table)}`).all()
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
        for (const row of earlier.prepare(`SELECT * FROM ${qi(table)}`).all()) {
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
          for (const row of earlier.prepare(`SELECT * FROM ${qi(table)}`).all()) insert.run(...names.map(name => row[name]))
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
 * @typedef {{ baseline_sha256: string, source_migrations: string[], tables: TableTransfer[], transforms: Array<{ name: string, changes: number, sql_sha256: string }>,
 *   invariants: Array<{ name: string, violations: number, sql_sha256: string }>, payload?: { tables: number, statements: number, delta?: Record<string, number>, left_behind?: Record<string, { changed: string[], deleted: string[] }> },
 *   provider_hours_session_ids: string[], provider_hours_session_source_hashes: Record<string, string>, schema?: Array<{ type: string, name: string, sql: string }> }} TransferManifest
 */

/**
 * Copy a recognized v7 or current export through the canonical migration chain.
 * The source's D1 ledger determines the exact applied files and their order,
 * so interleaved branch histories retain pending data-only migrations. A v7
 * source's integration connections become `organization_integrations` rows,
 * including during the final delta after a
 * binding repoint.
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {{ payloadPath?: string | null, withoutJwks?: boolean, deltaFrom?: string | null }} [options]
 * @returns {Promise<TransferManifest>}
 */
export async function transferDatabaseExport(sourcePath, targetPath, { payloadPath = null, withoutJwks = false, deltaFrom = null } = {}) {
  assert(!existsSync(targetPath), `Target already exists: ${targetPath}`)
  assert(!deltaFrom || payloadPath, 'A delta is a payload; pass --payload with --delta-from')
  const files = readdirSync(resolve(MIGRATIONS_DIRECTORY)).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort()
  assert(files[0] === '0000_baseline.sql', 'Migration chain must start with migrations/0000_baseline.sql')
  const baseSql = readFileSync(resolve(MIGRATIONS_DIRECTORY, files[0]), 'utf8')
  const schemaSql = migrationChainSql()
  const source = openDatabase(resolve(sourcePath))
  const stage = new Database(':memory:')
  // The target holds customer and credential rows during preflight. Create it
  // privately before SQLite opens it, including when --out keeps the file.
  writeFileSync(targetPath, '', { flag: 'wx', mode: 0o600 })
  const target = new Database(targetPath)
  /** @type {TransferManifest} */
  const manifest = {
    baseline_sha256: hash(baseSql), source_migrations: [], tables: [], transforms: [], invariants: [], provider_hours_session_ids: [], provider_hours_session_source_hashes: {},
  }
  try {
    const hasLedger = source.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'").get().n === 1
    const ledger = hasLedger ? source.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map(row => row.name) : []
    manifest.source_migrations = ledger
    let sourceDirectory = MIGRATIONS_DIRECTORY
    let sourceFiles = files
    assert(ledger.length > 0, 'Source migration ledger is missing')
    const applied = new Set(ledger)
    assert(applied.size === ledger.length, 'Source migration ledger contains duplicate filenames')
    assert(ledger[0] === '0000_baseline.sql', 'Source migration ledger must start with 0000_baseline.sql')
    let recognized = false
    for (const directory of [MIGRATIONS_DIRECTORY, 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16', 'migrations-history/v15', 'migrations-history/v14', 'migrations-history/v13', 'migrations-history/v12', 'migrations-history/v11', 'migrations-history/v10', 'migrations-history/v9', 'migrations-history/v8', 'migrations-history/v7']) {
      const candidates = readdirSync(resolve(directory)).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort()
      if (!ledger.every(name => candidates.includes(name))) continue
      const expected = new Database(':memory:')
      let matches
      try {
        expected.exec(ledger.map(name => readFileSync(resolve(directory, name), 'utf8')).join('\n'))
        matches = sameSchema(source, expected)
      } finally { expected.close() }
      if (!matches) continue
      sourceDirectory = directory
      sourceFiles = candidates
      recognized = true
      break
    }
    assert(recognized, 'Source schema differs from every recorded migration chain; no rows were copied')
    stage.exec(ledger.map(name => readFileSync(resolve(sourceDirectory, name), 'utf8')).join('\n'))
    stage.pragma('foreign_keys = OFF')
    const sourceTables = tableNames(source)
    const baseTables = tableNames(stage)
    const omitted = baseTables.filter(table => !sourceTables.includes(table))
    const unexpected = sourceTables.filter(table => !baseTables.includes(table))
    assert(omitted.length === 0 && unexpected.length === 0,
      `Source tables differ from their migration stage: missing [${omitted.join(', ')}], extra [${unexpected.join(', ')}]`)
    for (const table of sourceTables) {
      const targetColumns = columns(stage, table)
      const sourceColumns = columns(source, table)
      assert(JSON.stringify(sourceColumns) === JSON.stringify(targetColumns), `${table}: source columns differ from the schema being copied`)
      const rows = source.prepare(`SELECT * FROM ${qi(table)}`).all()
      const insert = stage.prepare(`INSERT INTO ${qi(table)} (${targetColumns.map(qi).join(',')}) VALUES (${targetColumns.map(() => '?').join(',')})`)
      for (const row of rows) insert.run(...targetColumns.map(name => row[name]))
      assert(digest(rows, targetColumns) === digest(stage.prepare(`SELECT * FROM ${qi(table)}`).all(), targetColumns), `${table}: copy differs`)
    }
    for (const name of sourceFiles.filter(name => !applied.has(name))) stage.exec(readFileSync(resolve(sourceDirectory, name), 'utf8'))

    const fromV7 = columns(stage, 'organization').includes('integrations_json')
    const integrations = fromV7 ? integrationRows(stage) : []
    if (fromV7) {
      assert(stage.prepare('SELECT count(*) AS n FROM business_locations WHERE description_provenance IS NOT NULL').get().n === 0,
        'business_locations.description_provenance holds values nothing maps; no rows were copied')
    }
    if (fromV7) {
      for (const name of readdirSync('migrations-history/v8').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v8', name), 'utf8'))
      }
    }
    // v12 retires per-site capability overrides: capabilities come from the vertical and theme alone.
    for (const table of ['organization', 'business_locations']) {
      if (columns(stage, table).includes('feature_overrides')) {
        assert(stage.prepare(`SELECT count(*) AS n FROM ${qi(table)} WHERE feature_overrides IS NOT NULL`).get().n === 0,
          `${table}.feature_overrides holds values nothing maps; no rows were copied`)
      }
    }
    if (columns(stage, 'products').includes('tags')) {
      const tagged = stage.prepare("SELECT count(*) AS n FROM products WHERE tags <> '[]'").get().n
      const localized = stage.prepare("UPDATE resource_localizations SET values_json = json_remove(values_json, '$.tags') WHERE resource_type = 'product' AND json_type(values_json, '$.tags') IS NOT NULL").run().changes
      manifest.transforms.push({ name: 'remove_product_tags', changes: tagged + localized })
    }
    if (!columns(stage, 'products').includes('kind')) {
      stage.exec('ALTER TABLE products ADD COLUMN kind TEXT; ALTER TABLE products ADD COLUMN details_json TEXT NOT NULL DEFAULT \'{}\';')
      const kinds = { restaurant: 'dish', experience: 'experience', service: 'service' }
      const keyMap = {
        'pricing.note': 'pricing_note', 'experience.tagline': 'tagline',
        'experience.meeting_point': 'meeting_point', 'experience.included_items': 'included_items',
        'experience.what_to_bring': 'what_to_bring', 'experience.cancellation_policy': 'cancellation_policy',
        'details.allergens': 'allergens', 'details.noodle': 'noodle', 'details.sizes': 'sizes',
        'details.soup': 'soup', 'details.toppings': 'toppings', 'menu.dietary-notes': 'dietary_notes',
      }
      const mappedKey = key => { assert(Object.hasOwn(keyMap, key), `Unmapped product detail ${key}; no rows were copied`); return keyMap[key] }
      const facts = stage.prepare('SELECT pm.product_id, d.namespace || \'.\' || d.key AS handle, pm.value FROM product_metafields pm JOIN metafield_definitions d ON d.id = pm.definition_id AND d.organization_id = pm.organization_id').all()
      const byProduct = new Map()
      for (const fact of facts) {
        const details = byProduct.get(fact.product_id) ?? {}
        const key = mappedKey(fact.handle)
        assert(!Object.hasOwn(details, key), `Duplicate product detail ${fact.product_id}.${key}`)
        details[key] = JSON.parse(fact.value)
        byProduct.set(fact.product_id, details)
      }
      const update = stage.prepare('UPDATE products SET kind = ?, details_json = ? WHERE id = ?')
      for (const product of stage.prepare('SELECT p.id, o.vertical, EXISTS(SELECT 1 FROM product_booking_configs c WHERE c.product_id = p.id) AS bookable FROM products p JOIN organization o ON o.id = p.organization_id').all()) {
        assert(Object.hasOwn(kinds, product.vertical) && (product.vertical !== 'experience' || product.bookable), `Product ${product.id} has no recognized offering kind; no rows were copied`)
        const kind = product.vertical === 'service' ? 'service' : product.bookable ? 'experience' : kinds[product.vertical]
        update.run(kind, JSON.stringify(validateProductDetails(kind, byProduct.get(product.id) ?? {})), product.id)
      }
      const localizations = stage.prepare("SELECT rl.id, rl.values_json, p.kind FROM resource_localizations rl JOIN products p ON p.id = rl.resource_id AND p.organization_id = rl.organization_id WHERE rl.resource_type = 'product'").all()
      const localize = stage.prepare('UPDATE resource_localizations SET values_json = ? WHERE id = ?')
      for (const row of localizations) {
        const values = JSON.parse(row.values_json)
        if (values.metafields) {
          assert(!values.details, `Product localization ${row.id} has two detail sources`)
          values.details = validateProductDetails(assertProductKind(row.kind), Object.fromEntries(Object.entries(values.metafields).map(([key, value]) => [mappedKey(key), value])))
          delete values.metafields
          localize.run(JSON.stringify(values), row.id)
        }
      }
      stage.exec('DROP TABLE product_metafields; DROP TABLE metafield_definitions;')
      manifest.transforms.push({ name: 'named_product_details', changes: facts.length })
    }
    const unsupported = stage.prepare('SELECT organization_id, id, kind FROM products ORDER BY organization_id, id').all().filter(row => !PRODUCT_KINDS.includes(row.kind))
    assert(unsupported.length === 0, `Unsupported offerings: ${unsupported.map(row => `${row.organization_id}/${row.id} (${row.kind})`).join(', ')}; no rows were copied`)
    if (fromV7) {
      const normalizedTable = readFileSync('migrations-history/v8/0000_baseline.sql', 'utf8').split('--> statement-breakpoint').find(statement => statement.includes('CREATE TABLE `organization_integrations`'))
      assert(normalizedTable, 'Archived normalized integration schema is missing')
      stage.exec(normalizedTable)
    }
    // An older archived chain reaches v11 through v11's forward migrations, which the v12 baseline absorbed.
    if (![MIGRATIONS_DIRECTORY, 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16', 'migrations-history/v15', 'migrations-history/v14', 'migrations-history/v13', 'migrations-history/v12', 'migrations-history/v11'].includes(sourceDirectory)) {
      for (const name of readdirSync('migrations-history/v11').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v11', name), 'utf8'))
      }
    }
    // An older archived chain reaches v12 through v12's forward migrations, which the v13 baseline absorbed.
    if (![MIGRATIONS_DIRECTORY, 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16', 'migrations-history/v15', 'migrations-history/v14', 'migrations-history/v13', 'migrations-history/v12'].includes(sourceDirectory)) {
      for (const name of readdirSync('migrations-history/v12').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v12', name), 'utf8'))
      }
    }
    // v13: one site palette, and a presentation on each logo placement. Saya
    // drew every logo as a circle, so its logos keep that shape.
    if (!columns(stage, 'media_placements').includes('presentation_json')) {
      stage.exec('ALTER TABLE media_placements ADD COLUMN presentation_json TEXT')
      const logos = stage.prepare(`UPDATE media_placements SET presentation_json = ? WHERE owner_type = 'organization' AND slot = 'logo'
        AND organization_id IN (SELECT id FROM organization WHERE theme_id = ?)`).run(SAYA_LOGO_PRESENTATION, SAYA_THEME_ID).changes
      manifest.transforms.push({ name: 'saya_logo_circle_presentation', changes: logos })
    }
    const paletteChanges = sitePaletteChanges(stage)
    if (paletteChanges) manifest.transforms.push({ name: 'brand_color_and_theme_tokens_to_site_palette', changes: paletteChanges })
    // v14 absorbs v13's deployed forward chain. Native Better Auth teams
    // start empty; existing booking commitments and source languages keep every
    // recorded fact. The new nullable fields stay unknown until an owner sets
    // them or a native financial event supplies its actual billing basis.
    if (![MIGRATIONS_DIRECTORY, 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16', 'migrations-history/v15', 'migrations-history/v14', 'migrations-history/v13'].includes(sourceDirectory)) {
      for (const name of readdirSync('migrations-history/v13').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v13', name), 'utf8'))
      }
    }
    for (const [table, column, type] of [
      ['invitation', 'teamId', 'TEXT'],
      ['product_booking_configs', 'assigned_team_id', 'TEXT'],
      ['reservations', 'policy_json', 'TEXT'],
      ['location_reservation_configs', 'duration_minutes', 'INTEGER'],
      ['location_reservation_configs', 'deposit_amount', 'INTEGER'],
      ['location_reservation_configs', 'deposit_currency', 'TEXT'],
      ['location_reservation_configs', 'deposit_tax_behavior', 'TEXT'],
      ['payment_checkout_holds', 'location_id', 'TEXT'],
      ['payment_checkout_holds', 'timezone', 'TEXT'],
      ['payment_checkout_holds', 'converted_reservation_id', 'TEXT'],
      ['payment_usage_events', 'billing_basis_json', 'TEXT'],
      ['payment_cost_snapshots', 'billing_basis_json', 'TEXT'],
    ]) {
      if (!columns(stage, table).includes(column)) stage.exec(`ALTER TABLE ${qi(table)} ADD COLUMN ${qi(column)} ${type}`)
    }
    for (const table of ['team', 'teamMember']) {
      if (tableNames(stage).includes(table)) continue
      const definition = baseSql.split('--> statement-breakpoint').find(statement => statement.includes(`CREATE TABLE \`${table}\``))
      assert(definition, `Native Better Auth ${table} schema is missing`)
      stage.exec(definition)
    }
    // v15 relaxes the calendar group CHECK only. Older chains still pass
    // through v14's canonical content data migration before the exact copy.
    if (![MIGRATIONS_DIRECTORY, 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16', 'migrations-history/v15', 'migrations-history/v14'].includes(sourceDirectory)) {
      for (const name of readdirSync('migrations-history/v14').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v14', name), 'utf8'))
      }
    }
    // v16: the facts a business, a location and an online offering cannot run
    // without are required, and nothing stands in for them. A row without one
    // fails the transfer rather than receiving a value nobody chose.
    if (!columns(stage, 'organization').includes('timezone')) {
      const unanswered = stage.prepare(`SELECT id FROM organization WHERE default_currency IS NULL
        OR json_type(settings_json, '$.config.default_timezone') IS NOT 'text' OR json_extract(settings_json, '$.config.default_timezone') = 'UTC'`).all()
      assert(unanswered.length === 0, `Organizations without their own currency or timezone (the retired 'UTC' default is not one): ${unanswered.map(row => row.id).join(', ')}; no rows were copied`)
      const placeless = stage.prepare('SELECT id FROM business_locations WHERE timezone IS NULL OR timezone = \'\'').all()
      assert(placeless.length === 0, `Locations without a timezone: ${placeless.map(row => row.id).join(', ')}; no rows were copied`)
      const grouped = stage.prepare('SELECT (SELECT count(*) FROM product_booking_configs WHERE calendar_group IS NOT NULL) + (SELECT count(*) FROM payment_checkout_holds WHERE calendar_group IS NOT NULL) AS n').get().n
      assert(grouped === 0, 'Shared online calendars are retired: a provider\'s own hours and bookings exclude overlaps; no rows were copied')
      // The stage keeps v15's CHECK on the settings key; the target drops the key after the copy.
      stage.exec(`ALTER TABLE organization ADD COLUMN timezone TEXT;
        UPDATE organization SET timezone = json_extract(settings_json, '$.config.default_timezone');`)
      manifest.transforms.push({ name: 'organization_timezone_column', changes: stage.prepare('SELECT count(*) AS n FROM organization').get().n })
      // An online offering's times are its provider's hours, in the provider's zone.
      const unprovided = stage.prepare(`SELECT product_id FROM product_booking_configs WHERE online_timezone IS NOT NULL
        AND NOT (scheduling_mode = 'provider' AND (assigned_member_id IS NOT NULL OR assigned_team_id IS NOT NULL))`).all()
      assert(unprovided.length === 0, `Online offerings with nobody to provide them: ${unprovided.map(row => row.product_id).join(', ')}; no rows were copied`)
      const unheld = stage.prepare(`SELECT s.id FROM product_sessions s JOIN product_booking_configs c ON c.product_id = s.product_id AND c.organization_id = s.organization_id
        WHERE s.location_id IS NULL AND s.assigned_member_id IS NULL AND (c.online_timezone IS NULL OR c.assigned_member_id IS NULL)`).all()
      assert(unheld.length === 0, `Online sessions without a single provider to hold them: ${unheld.length}; no rows were copied`)
      stage.exec('ALTER TABLE product_booking_configs ADD COLUMN held_online INTEGER NOT NULL DEFAULT 0')
      const held = stage.prepare('UPDATE product_booking_configs SET held_online = 1 WHERE online_timezone IS NOT NULL').run().changes
      const assigned = stage.prepare(`UPDATE product_sessions SET assigned_member_id = (SELECT c.assigned_member_id FROM product_booking_configs c WHERE c.product_id = product_sessions.product_id AND c.organization_id = product_sessions.organization_id)
        WHERE location_id IS NULL AND assigned_member_id IS NULL`).run().changes
      // Their weekly rules become provenance only; the sessions they made keep
      // every booking and take the provider-hours identity the generator uses,
      // so it reopens or retires them instead of adding a twin beside them.
      const detached = stage.prepare(`UPDATE product_sessions SET availability_rule_id = NULL,
          source_occurrence_key = 'hours:' || assigned_member_id || ':' || starts_at
        WHERE location_id IS NULL`).run().changes
      const rules = stage.prepare('DELETE FROM product_availability_rules WHERE location_id IS NULL').run().changes
      manifest.transforms.push({ name: 'online_offerings_held_by_providers', changes: held + assigned + detached + rules })
    }
    // v17 absorbs v16's deployed forward chain (authored contact sections, the
    // retired public OAuth flag, team member times, the Google Ads provider,
    // invite links, full-remaining refunds and payment intents). Older chains pass through it before the exact copy; a v16
    // source already ran its pending ones above.
    if (![MIGRATIONS_DIRECTORY, 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16'].includes(sourceDirectory)) {
      for (const name of readdirSync('migrations-history/v16').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v16', name), 'utf8'))
      }
    }
    // A baseline can introduce tables an older chain never had (v17's places to
    // stay), and a later forward migration may change one of them, so the stage
    // gets each such table, empty, with its indexes (a composite foreign key
    // needs its parent's unique index), before that chain's forward migrations run.
    const withBaselineTables = baseline => {
      const statements = baseline.split('--> statement-breakpoint')
      const added = new Set()
      for (const statement of statements) {
        const table = statement.match(/CREATE TABLE `([^`]+)`/u)?.[1]
        if (table && !tableNames(stage).includes(table)) {
          stage.exec(statement)
          added.add(table)
        }
      }
      for (const statement of statements) {
        const table = statement.match(/CREATE (?:UNIQUE )?INDEX `[^`]+` ON `([^`]+)`/u)?.[1]
        if (table && added.has(table)) stage.exec(statement)
      }
    }
    // v18 absorbs v17's deployed forward chain (Channex connections, channel
    // mappings, the sync log, night pushes and stay threads). Older chains pass
    // through it before the exact copy; a v17 source already ran its pending ones above.
    if (![MIGRATIONS_DIRECTORY, 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17'].includes(sourceDirectory)) {
      withBaselineTables(readFileSync('migrations-history/v17/0000_baseline.sql', 'utf8'))
      for (const name of readdirSync('migrations-history/v17').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v17', name), 'utf8'))
      }
    }
    if (sourceDirectory !== MIGRATIONS_DIRECTORY && sourceDirectory !== 'migrations-history/v19') withBaselineTables(readFileSync('migrations-history/v19/0000_baseline.sql', 'utf8'))
    // v19 adds facts no older row has: no copied stay was received as a new
    // reservation and no home has private instructions yet. A saved category
    // preference predates push, so its push switch is that category's
    // product default, exactly as for a person who never saved one.
    for (const [table, column, type] of [
      ['stays', 'booking_received_at', 'TEXT'],
      ['product_stay_configs', 'check_in_instructions', 'TEXT'],
    ]) {
      if (!columns(stage, table).includes(column)) stage.exec(`ALTER TABLE ${qi(table)} ADD COLUMN ${qi(column)} ${type}`)
    }
    if (tableNames(stage).includes('user_notification_preferences') && !columns(stage, 'user_notification_preferences').includes('push_enabled')) {
      const { NOTIFICATION_CATEGORY_DEFAULTS } = await import('../shared/notification-categories.ts')
      stage.exec('ALTER TABLE user_notification_preferences ADD COLUMN push_enabled INTEGER')
      const update = stage.prepare('UPDATE user_notification_preferences SET push_enabled = ? WHERE category = ?')
      const changes = Object.entries(NOTIFICATION_CATEGORY_DEFAULTS).reduce((total, [category, setting]) => total + update.run(setting.push ? 1 : 0, category).changes, 0)
      const unmapped = stage.prepare('SELECT count(*) AS n FROM user_notification_preferences WHERE push_enabled IS NULL').get().n
      assert(unmapped === 0, `${unmapped} notification preferences name a category with no push default; no rows were copied`)
      if (changes) manifest.transforms.push({ name: 'notification_preferences_push_default', changes })
    }
    // Older epochs reach v19 through its full archived forward chain before
    // receiving tables and forward migrations from the current baseline.
    if (sourceDirectory !== MIGRATIONS_DIRECTORY && sourceDirectory !== 'migrations-history/v19') {
      for (const name of readdirSync('migrations-history/v19').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v19', name), 'utf8'))
      }
    }
    if (sourceDirectory !== MIGRATIONS_DIRECTORY) withBaselineTables(baseSql)
    // The current chain's forward migrations run on the complete prior shape.
    if (sourceDirectory !== MIGRATIONS_DIRECTORY) {
      for (const name of files.slice(1)) stage.exec(readFileSync(resolve(MIGRATIONS_DIRECTORY, name), 'utf8'))
    }
    const names = tableNames(stage)
    const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${qi(table)}`).get().n
    target.exec(schemaSql)
    target.pragma('foreign_keys = OFF')
    const copy = target.transaction(() => {
      for (const table of names) {
        const targetColumns = columns(target, table)
        const retiredColumns = columns(stage, table).filter(name => !targetColumns.includes(name))
        const allowedRetired = RETIRED_COLUMNS[table] ?? []
        assert(retiredColumns.every(name => allowedRetired.includes(name)), `${table}: unmapped columns [${retiredColumns.join(', ')}]`)
        const rows = stage.prepare(`SELECT ${targetColumns.map(qi).join(',')} FROM ${qi(table)}`).all()
        const insert = target.prepare(`INSERT INTO ${qi(table)} (${targetColumns.map(qi).join(',')}) VALUES (${targetColumns.map(() => '?').join(',')})`)
        for (const row of rows) insert.run(...targetColumns.map(name => row[name]))
        assert(digest(rows, targetColumns) === digest(target.prepare(`SELECT * FROM ${qi(table)}`).all(), targetColumns), `${table}: target copy differs`)
      }
    })
    copy()
    const retiredSettings = target.prepare("UPDATE organization SET settings_json = json_remove(settings_json, '$.config.default_timezone') WHERE json_type(settings_json, '$.config.default_timezone') IS NOT NULL").run().changes
    if (retiredSettings) manifest.transforms.push({ name: 'organization_timezone_out_of_settings', changes: retiredSettings })
    if (fromV7) {
      const names = Object.keys(integrations[0] ?? { id: null })
      const insert = target.prepare(`INSERT INTO organization_integrations (${names.map(qi).join(',')}) VALUES (${names.map(() => '?').join(',')})`)
      target.transaction(() => { for (const row of integrations) insert.run(...names.map(name => row[name])) })()
      assert(count(target, 'organization_integrations') === integrations.length, 'organization_integrations differs from the connections it maps')
      manifest.transforms.push({ name: 'integrations_json_to_organization_integrations', changes: integrations.length })
    }
    if (sourceDirectory !== MIGRATIONS_DIRECTORY && sourceDirectory !== 'migrations-history/v19') {
      const configs = target.prepare('SELECT * FROM product_booking_configs WHERE held_online = 1 ORDER BY product_id').all()
      const previousSourceRows = new Map()
      if (deltaFrom) {
        const { sessionMemberSql } = await import('../server/utils/provider-allocation.ts')
        const currentProvider = target.prepare(`WITH candidate AS (SELECT ? AS id, ? AS organization_id, ? AS product_id, ? AS assigned_member_id)
          SELECT 1 FROM candidate JOIN member_scheduling ms ON ms.member_id=candidate.assigned_member_id AND ms.organization_id=candidate.organization_id
            JOIN member m ON m.id=ms.member_id AND m.organizationId=ms.organization_id
          WHERE ${sessionMemberSql('candidate')} IS candidate.assigned_member_id`)
        // These rows were derived on the replacement, never held by the old
        // source. Seed their canonical occurrences before regeneration so the
        // native unique index retains their identities across a final delta.
        // Real source sessions are not inventoried, so their deletions remain
        // visible in the payload audit rather than being restored here.
        const previous = JSON.parse(readFileSync(`${deltaFrom}.manifest.json`, 'utf8'))
        assert(previous.baseline_sha256 === manifest.baseline_sha256, 'The initial transfer was built from another baseline')
        assert(Array.isArray(previous.provider_hours_session_ids) && previous.provider_hours_session_ids.every(id => typeof id === 'string')
          && new Set(previous.provider_hours_session_ids).size === previous.provider_hours_session_ids.length,
        'The initial transfer has no valid provider-hours session inventory; repeat the initial preflight before deriving a delta')
        assert(previous.provider_hours_session_source_hashes && typeof previous.provider_hours_session_source_hashes === 'object'
          && !Array.isArray(previous.provider_hours_session_source_hashes) && Object.values(previous.provider_hours_session_source_hashes).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)),
        'The initial transfer has no valid provider-hours source signatures; repeat the initial preflight before deriving a delta')
        const earlier = new Database(deltaFrom, { readonly: true, fileMustExist: true })
        try {
          assert(sameSchema(earlier, target), 'The initial transfer schema differs from the current target')
          for (const [id, signature] of Object.entries(previous.provider_hours_session_source_hashes)) {
            const row = earlier.prepare('SELECT * FROM product_sessions WHERE id = ?').get(id)
            assert(row, `Initial provider-hours source session is missing: ${id}`)
            previousSourceRows.set(id, { row, signature })
          }
          const sessionColumns = columns(target, 'product_sessions')
          const insert = target.prepare(`INSERT INTO product_sessions (${sessionColumns.map(qi).join(',')}) VALUES (${sessionColumns.map(() => '?').join(',')})`)
          const sourceOccurrence = target.prepare('SELECT id FROM product_sessions WHERE product_id = ? AND starts_at = ? AND assigned_member_id = ? AND location_id IS NULL LIMIT 1')
          const held = new Set(configs.map(config => config.product_id))
          let retained = 0
          target.transaction(() => {
            for (const id of previous.provider_hours_session_ids) {
              const row = earlier.prepare('SELECT * FROM product_sessions WHERE id = ?').get(id)
              assert(row && row.location_id === null && row.assigned_member_id !== null
                && row.source_occurrence_key === `hours:${row.assigned_member_id}:${row.starts_at}`, `Invalid initial provider-hours session: ${id}`)
              if (!held.has(row.product_id) || !currentProvider.get(row.id, row.organization_id, row.product_id, row.assigned_member_id)) continue
              const occupied = sourceOccurrence.get(row.product_id, row.starts_at, row.assigned_member_id)
              assert(!occupied, `Source session ${occupied?.id} occupies initial derived session ${id}; explicitly reconcile this occurrence before a creations-only delta. No replacement rows were overwritten.`)
              insert.run(...sessionColumns.map(name => row[name]))
              retained++
            }
          })()
          manifest.transforms.push({ name: 'provider_hours_session_identities_retained', changes: retained })
        } finally { earlier.close() }
      }
      if (configs.length) {
        const { prepareProviderHoursSessions } = await import('../server/utils/availability.ts')
        const db = drizzle(target)
        const before = new Map(target.prepare('SELECT * FROM product_sessions').all().map(row => [row.id, row]))
        const now = new Date().toISOString()
        const queries = []
        for (const config of configs) queries.push(...await prepareProviderHoursSessions(db, config, { actorId: 'system', now }))
        const changes = target.transaction(() => queries.reduce((total, { query, params }) => total + target.prepare(query).run(...params).changes, 0))()
        const sourceSessions = new Map(source.prepare('SELECT * FROM product_sessions').all().map(row => [row.id, hash(JSON.stringify(row))]))
        const sessions = target.prepare('SELECT * FROM product_sessions ORDER BY id').all()
        const retainTimestamp = target.prepare('UPDATE product_sessions SET updated_at = ?, updated_by = ? WHERE id = ?')
        target.transaction(() => {
          for (const row of sessions.filter(row => sourceSessions.has(row.id))) {
            const original = before.get(row.id)
            const signature = sourceSessions.get(row.id)
            const previous = previousSourceRows.get(row.id)
            // A raw source may still say scheduled where the canonical
            // horizon cancels the slot. Rebuilding that unchanged source must
            // not invent a new audit time for identical derived facts. Only
            // the metadata is retained, after the generator has respected the
            // current source's bookings/holds and provider configuration.
            if (previous?.signature === signature && Object.keys(row).every(name => ['updated_at', 'updated_by'].includes(name) || row[name] === previous.row[name])) {
              retainTimestamp.run(previous.row.updated_at, previous.row.updated_by, row.id)
              row.updated_at = previous.row.updated_at
              row.updated_by = previous.row.updated_by
            }
            if (JSON.stringify(row) !== JSON.stringify(original)) manifest.provider_hours_session_source_hashes[row.id] = signature
          }
        })()
        manifest.provider_hours_session_ids = sessions.filter(row => !sourceSessions.has(row.id)).map(row => row.id)
        const created = sessions.filter(row => !before.has(row.id)).length
        manifest.transforms.push({ name: 'online_provider_hours_sessions_created', changes: created }, { name: 'online_provider_hours_sessions_updated', changes: changes - created })
      }
    }
    manifest.tables = names.map(table => ({ table, source_rows: sourceTables.includes(table) ? count(source, table) : 0, target_rows: count(target, table) }))
    const violations = target.pragma('foreign_key_check')
    assert(violations.length === 0, `Foreign key violations after transfer (${violations.length}): ${JSON.stringify(violations.slice(0, 8))}`)
    assert(target.pragma('integrity_check', { simple: true }) === 'ok', 'Integrity check failed')
    const expected = new Database(':memory:')
    expected.exec(schemaSql)
    manifest.schema = target.prepare(SCHEMA_OBJECTS_QUERY).all()
    assert(sameSchema(target, expected), 'Target schema differs from the migration chain')
    expected.close()
    manifest.invariants = auditTargetInvariants(target)
    const broken = manifest.invariants.filter(result => result.violations > 0)
    assert(broken.length === 0, `Invariant violations: ${broken.map(result => `${result.name}=${result.violations}`).join(', ')}`)
    if (payloadPath) manifest.payload = writePayload(target, payloadPath, schemaSql, { withoutJwks, deltaFrom })
    writeFileSync(`${targetPath}.manifest.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    return manifest
  } finally {
    source.close()
    stage.close()
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
