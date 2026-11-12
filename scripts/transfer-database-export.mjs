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
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { CONTENT_DOCUMENT_SCOPE_QUERY, MEDIA_PLACEMENT_OWNER_AUDIT_QUERY } from './audit-orphaned-media-placements.mjs'
import { isSupportedMediaPlacement } from '../shared/media-placement-contract.ts'
import { organizationRoles } from '../utils/organization-access.ts'
import { PRODUCT_KINDS, validateProductDetails, assertProductKind } from '../shared/product-details.ts'
import { STAY_CHANNEL_LABELS } from '../shared/bookings.ts'
import { DEFAULT_SITE_PALETTE, parseSitePalette } from '../shared/site-palette.ts'
import { getDarkModeVariant } from '../utils/color-utils.ts'

register('../tests/unit/support/alias-hooks.mjs', import.meta.url)

/** The roles the access matrix declares. Anything else evaluates to no permissions. */
const DECLARED_ORGANIZATION_ROLES = new Set(Object.keys(organizationRoles))

const MIGRATIONS_DIRECTORY = 'migrations'
const V26_DIRECTORY = 'migrations-history/v26'
const v26Baseline = () => readFileSync(resolve(V26_DIRECTORY, '0000_baseline.sql'), 'utf8')
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

/** Advance a private copy; the original replacement artifact stays immutable. */
function comparisonDatabase(path) {
  const original = new Database(path, { readonly: true, fileMustExist: true })
  let comparison
  try { comparison = new Database(original.serialize()) } finally { original.close() }
  const expected = new Database(':memory:')
  try {
    const files = readdirSync(resolve(MIGRATIONS_DIRECTORY)).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort()
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
  payments: ['state'],
  product_nights: ['min_stay_through'],
  // v24: whether a reply is owed is an open guest_reply task.
  requests: ['conversation_state', 'resolved_at'],
  // v26: the buyer confirms a PaymentIntent on the site; nothing wrote these.
  // v26: working windows and Google busy times are read live, never stored.
  member_scheduling: ['windows_json', 'windows_until', 'calendar_revision', 'busy_json', 'busy_from', 'busy_until', 'busy_checked_at', 'busy_error'],
}

/**
 * v23 to v24. Feedback was per person; the latest decision about a reference
 * is the business's: accept becomes accepted with its task, dismiss and
 * correct become dismissed with the note, defer becomes available_at.
 */
const RECOMMENDATION_FEEDBACK_TO_OPPORTUNITIES = `
-- Every recommendation_feedback row becomes the business's opportunity at its
-- evidence revision. Feedback was per person; the latest decision about a
-- reference is the business's. accept -> accepted with its task, dismiss and
-- correct -> dismissed keeping the note, defer -> open until defer_until.
INSERT INTO \`opportunities\` (\`id\`, \`organization_id\`, \`operation\`, \`subject_id\`, \`evidence_revision\`, \`goal_id\`, \`goal_revision\`, \`status\`, \`available_at\`, \`decision_note\`, \`decided_at\`, \`decided_by_user_id\`, \`created_at\`, \`updated_at\`)
SELECT \`id\`, \`organization_id\`, \`operation\`, \`subject_id\`, \`evidence_revision\`, \`goal_id\`, \`goal_revision\`,
  CASE \`decision\` WHEN 'accept' THEN 'accepted' WHEN 'dismiss' THEN 'dismissed' WHEN 'correct' THEN 'dismissed' WHEN 'defer' THEN 'open' END,
  \`defer_until\`, \`note\`,
  CASE WHEN \`decision\` IN ('accept', 'dismiss', 'correct') THEN \`updated_at\` END,
  CASE WHEN \`decision\` IN ('accept', 'dismiss', 'correct') THEN \`user_id\` END,
  \`created_at\`, \`updated_at\`
FROM (SELECT *, row_number() OVER (PARTITION BY \`organization_id\`, \`operation\`, \`subject_id\`, \`evidence_revision\`, coalesce(\`goal_id\`, '') ORDER BY \`updated_at\` DESC, \`id\` DESC) AS \`latest\` FROM \`recommendation_feedback\`)
WHERE \`latest\` = 1;
INSERT INTO \`tasks\` (\`id\`, \`organization_id\`, \`kind\`, \`subject_type\`, \`subject_id\`, \`product_id\`, \`opportunity_id\`, \`title\`, \`assigned_member_id\`, \`timezone\`, \`status\`, \`dedupe_key\`, \`version\`, \`created_by_user_id\`, \`created_at\`, \`updated_at\`)
SELECT 'opportunity-task:' || o.\`id\`, o.\`organization_id\`, 'opportunity',
  CASE WHEN o.\`operation\` IN ('article.update', 'article.publish', 'article.distribute') THEN 'article' WHEN o.\`operation\` = 'post.publish' THEN 'post'
    WHEN o.\`operation\` = 'product.payment' AND p.\`id\` IS NOT NULL THEN 'product' WHEN o.\`operation\` = 'stay.gap' AND p.\`id\` IS NOT NULL THEN 'product'
    WHEN o.\`operation\` = 'guest_thread.reply' THEN 'request' END,
  CASE WHEN o.\`operation\` IN ('article.update', 'article.publish', 'article.distribute', 'post.publish', 'guest_thread.reply') THEN o.\`subject_id\`
    WHEN o.\`operation\` IN ('product.payment', 'stay.gap') THEN p.\`id\` END,
  p.\`id\`, o.\`id\`,
  CASE o.\`operation\` WHEN 'article.create' THEN 'Write a blog article' WHEN 'article.update' THEN 'Update the article' WHEN 'article.publish' THEN 'Publish the blog draft'
    WHEN 'article.distribute' THEN 'Share the article' WHEN 'post.create' THEN 'Prepare a photo post' WHEN 'post.publish' THEN 'Finish sharing the post'
    WHEN 'social.connect' THEN 'Connect your social account' WHEN 'google_ads.connect' THEN 'Connect Google Ads' WHEN 'payments.connect' THEN 'Finish your payment setup'
    WHEN 'product.payment' THEN 'Take payment at booking' WHEN 'stay.gap' THEN 'Fill the calendar gap' WHEN 'guest_thread.reply' THEN 'Reply to the guest' END,
  m.\`id\`, org.\`timezone\`, 'open', 'opportunity:' || o.\`id\`, 1, o.\`decided_by_user_id\`, o.\`decided_at\`, o.\`decided_at\`
FROM \`opportunities\` o JOIN \`organization\` org ON org.\`id\` = o.\`organization_id\`
LEFT JOIN \`member\` m ON m.\`organizationId\` = o.\`organization_id\` AND m.\`userId\` = o.\`decided_by_user_id\`
LEFT JOIN \`products\` p ON p.\`organization_id\` = o.\`organization_id\` AND p.\`id\` = CASE WHEN o.\`operation\` = 'stay.gap' THEN json_extract(o.\`subject_id\`, '$[0]') WHEN o.\`operation\` = 'product.payment' THEN o.\`subject_id\` END
WHERE o.\`status\` = 'accepted';
`

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
 * @typedef {{ baseline_sha256: string, source_migrations: string[], target_migrations: string[], tables: TableTransfer[], transforms: Array<{ name: string, changes: number, sql_sha256: string }>,
 *   invariants: Array<{ name: string, violations: number, sql_sha256: string }>, payload?: { tables: number, statements: number, delta?: Record<string, number>, left_behind?: Record<string, { changed: string[], deleted: string[] }> },
 *   hours_session_ids: string[], hours_session_source_hashes: Record<string, string>, schema?: Array<{ type: string, name: string, sql: string }> }} TransferManifest
 */

/** Collapse the v26 records on the private copy. The replacement's ledger still applies the native baseline. */
async function consolidateV26(stage, baseline, manifest) {
  const { localDateTimeToInstant } = await import('../utils/timezone.ts')
  const source = readFileSync(new URL('./database-transfers/v26-to-v27.sql', import.meta.url), 'utf8')
  const sections = source.split(/^-- stage: /mu).slice(1).map(section => {
    const line = section.indexOf('\n')
    return [section.slice(0, line), section.slice(line + 1)]
  })
  const parts = new Map(sections)
  const ddl = baseline.split('--> statement-breakpoint')
  const create = (...tables) => {
    for (const table of tables) {
      const statements = ddl.filter(sql => sql.match(/(?:CREATE TABLE|ON) \x60(\w+)\x60/u)?.[1] === table)
      assert(statements.some(sql => sql.includes('CREATE TABLE')), 'v27 baseline has no table ' + table)
      for (const statement of statements) stage.exec(statement)
    }
  }
  const rename = (...tables) => {
    for (const table of tables) {
      const indexes = stage.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table)
      for (const { name } of indexes) stage.exec('DROP INDEX ' + qi(name))
      stage.exec('ALTER TABLE ' + qi(table) + ' RENAME TO ' + qi('old_' + table))
    }
  }
  const copy = (table, overrides = {}) => {
    const previous = 'old_' + table
    const sourceColumns = new Set(columns(stage, previous))
    const kept = columns(stage, table).filter(column => sourceColumns.has(column) || Object.hasOwn(overrides, column))
    stage.exec('INSERT INTO ' + qi(table) + ' (' + kept.map(qi).join(',') + ') SELECT '
      + kept.map(column => overrides[column] ?? qi(column)).join(',') + ' FROM ' + qi(previous))
  }
  const drop = (...tables) => {
    for (const table of tables) stage.exec('DROP TABLE ' + qi(table))
  }
  const run = (name) => {
    const script = parts.get(name)
    assert(script, 'Missing v26 data move section ' + name)
    const statements = script.replace(/^--.*$/gmu, '').split(/;\s*(?=\n|$)/u).map(sql => sql.trim()).filter(Boolean)
    for (const sql of statements) {
      if (!/^SELECT\b/iu.test(sql)) {
        try { stage.exec(sql) }
        catch (cause) { throw new Error('v26 ' + name + ': ' + cause.message + ' (' + sql.slice(0, 115) + ')', { cause }) }
        continue
      }
      const rows = stage.prepare(sql).all()
      if (/\bAS personal_sends_dropped\b/iu.test(sql)) {
        if (rows[0].personal_sends_dropped) manifest.transforms.push({ name: 'personal_sends_without_anchor', changes: rows[0].personal_sends_dropped })
        continue
      }
      assert(rows.length === 0 || (rows.length === 1 && Object.values(rows[0]).length === 1 && Object.values(rows[0])[0] === 0),
        'v26 ' + name + ' verification failed: ' + sql.slice(0, 180))
    }
  }
  const count = table => stage.prepare('SELECT count(*) n FROM ' + qi(table)).get().n
  stage.pragma('foreign_keys = OFF')
  stage.pragma('legacy_alter_table = ON')
  stage.transaction(() => {
    assert(count('team') === 0 && count('teamMember') === 0, 'v26 still has Better Auth Teams or team memberships')
    rename('products')
    create('products')
    copy('products')
    drop('old_products')
    for (const [column, definition] of Object.entries({
      unit: "TEXT NOT NULL DEFAULT 'slot'", seating_interval_minutes: 'INTEGER', party_size_min: 'INTEGER', party_size_max: 'INTEGER',
      minimum_guest_age: 'INTEGER', accessibility_contact_required: 'INTEGER NOT NULL DEFAULT 0',
      payment_basis: "TEXT NOT NULL DEFAULT 'per_guest'", payment_min_party_size: 'INTEGER',
    })) stage.exec('ALTER TABLE product_booking_configs ADD COLUMN ' + qi(column) + ' ' + definition)
    stage.exec('ALTER TABLE bookings ADD COLUMN policy_json TEXT')
    // Early proposals recorded a local date and time. Resolve it using the
    // named location and the originally booked duration before moving sessions.
    const localProposals = stage.prepare(`SELECT e.id, l.timezone,
      json_extract(e.payload_json, '$.after.bookingDate') date,
      json_extract(e.payload_json, '$.after.bookingTime') time,
      json_extract(e.payload_json, '$.before.startsAt') starts_at,
      json_extract(e.payload_json, '$.before.endsAt') ends_at
      FROM activity_entries e JOIN requests r ON r.id = e.request_id
      JOIN business_locations l ON l.organization_id = r.organization_id
        AND l.id = COALESCE(json_extract(e.payload_json, '$.afterLocationId'), json_extract(e.payload_json, '$.after.locationId'))
      WHERE e.event_name IN ('booking_change.requested', 'booking_change.moved')
        AND json_extract(e.payload_json, '$.after.kind') = 'reservation'
        AND json_extract(e.payload_json, '$.afterStartsAt') IS NULL`).all()
    const dateProposal = stage.prepare("UPDATE activity_entries SET payload_json = json_set(payload_json, '$.afterStartsAt', ?, '$.afterEndsAt', ?, '$.afterTimezone', ?) WHERE id = ?")
    for (const proposal of localProposals) {
      const duration = Date.parse(proposal.ends_at) - Date.parse(proposal.starts_at)
      assert(Number.isFinite(duration) && duration > 0, 'A legacy table proposal has no recorded original duration')
      const starts = localDateTimeToInstant(proposal.date, proposal.time, proposal.timezone, 'reject')
      dateProposal.run(starts.toISOString(), new Date(starts.valueOf() + duration).toISOString(), proposal.timezone, proposal.id)
    }
    if (localProposals.length) manifest.transforms.push({ name: 'local_reservation_proposals_resolved', changes: localProposals.length })
    const reservations = count('reservations')
    run('reservations')
    run('open-time')
    if (reservations) manifest.transforms.push({ name: 'table_reservations_to_bookings', changes: reservations })

    rename('product_booking_configs')
    create('product_booking_configs')
    copy('product_booking_configs')
    stage.exec("INSERT INTO product_booking_configs (organization_id, product_id, unit, default_capacity, scheduling_mode, assigned_member_id, questions,"
      + " check_in_time, check_in_end_time, check_out_time, min_nights, calendar_rules, cancellation_policy, long_term_cancellation_policy, created_at, updated_at, created_by, updated_by)"
      + " SELECT organization_id, product_id, 'nights', max_guests, 'business', assigned_member_id, questions,"
      + " check_in_time, check_in_end_time, check_out_time, min_nights, NULLIF(json_remove(calendar_rules, '$.weekend_price_minor'), '{}'),"
      + " cancellation_policy, long_term_cancellation_policy, created_at, updated_at, created_by, updated_by FROM product_stay_configs")
    drop('old_product_booking_configs')

    const windows = stage.prepare('SELECT s.id, s.check_in_date, s.check_out_date, s.arrival_time, b.check_in_time, b.check_out_time, l.timezone'
      + ' FROM stays s JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id'
      + ' JOIN product_booking_configs b ON b.organization_id = s.organization_id AND b.product_id = s.product_id'
      + ' JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id').all()
    stage.exec('CREATE TEMP TABLE stay_channels (channel TEXT PRIMARY KEY, title TEXT NOT NULL)')
    const saveChannel = stage.prepare('INSERT INTO stay_channels VALUES (?, ?)')
    for (const [channel, title] of Object.entries(STAY_CHANNEL_LABELS)) saveChannel.run(channel, title)
    stage.exec('CREATE TEMP TABLE stay_windows (stay_id TEXT PRIMARY KEY, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL)')
    const saveWindow = stage.prepare('INSERT INTO stay_windows VALUES (?, ?, ?)')
    const boundary = (date, time, timezone) => time === null ? date : localDateTimeToInstant(date, time, timezone, 'earlier').toISOString()
    for (const row of windows) saveWindow.run(row.id,
      boundary(row.check_in_date, row.arrival_time ?? row.check_in_time, row.timezone),
      boundary(row.check_out_date, row.check_out_time, row.timezone))

    rename('bookings', 'stays', 'stay_nights', 'stay_payments', 'requests', 'tasks', 'scheduled_guest_messages', 'team_threads',
      'review_requests', 'reviews', 'google_calendar_event_links', 'payment_checkout_holds')
    run('booked-record-schema')
    run('stays')
    drop('stay_windows', 'stay_channels')
    if (windows.length) manifest.transforms.push({ name: 'stays_to_bookings', changes: windows.length })

    const legacyAttachments = stage.prepare(`SELECT count(*) AS n FROM media_placements mp
      WHERE (mp.owner_type = 'activity_entry' AND NOT EXISTS (
        SELECT 1 FROM activity_entries e JOIN requests r ON r.id = e.request_id
          WHERE e.id = mp.owner_id AND e.kind IN ('submission', 'message', 'operation') AND r.organization_id = mp.organization_id))
      OR (mp.owner_type = 'team_message' AND NOT EXISTS (
        SELECT 1 FROM team_messages m WHERE m.id = mp.owner_id AND m.organization_id = mp.organization_id))`).get().n
    assert(legacyAttachments === 0, 'Invariant violations: media_owner_scope (' + legacyAttachments + ' legacy message attachments)')
    rename('activity_entries', 'bookings', 'channel_threads', 'content_reports', 'guest_thread_deliveries', 'media_placements', 'payment_checkout_holds',
      'scheduled_guest_messages', 'send_later_messages', 'tasks', 'requests', 'team_threads', 'team_messages', 'team_thread_members')
    create('activity_entries', 'bookings', 'channel_threads', 'content_reports', 'guest_thread_deliveries', 'media_placements', 'payment_checkout_holds',
      'scheduled_guest_messages', 'tasks', 'conversations', 'conversation_participants', 'messages')
    run('conversations')
    const conversations = count('conversations')
    if (conversations) manifest.transforms.push({ name: 'unified_conversations', changes: conversations })

    rename('product_stay_configs', 'product_nights', 'prices')
    create('product_stay_configs', 'product_nights', 'prices')
    copy('product_stay_configs')
    copy('prices')
    run('prices')
    drop('old_product_stay_configs', 'old_product_nights', 'old_prices')

    rename('organization_integrations', 'usage_events', 'google_calendar_setup', 'payment_usage_events')
    create('organization_integrations', 'usage_events')
    copy('organization_integrations')
    run('usage-and-calendar')
    drop('old_organization_integrations', 'old_usage_events', 'old_google_calendar_setup', 'old_payment_usage_events')

    rename('reviews', 'review_requests', 'content_documents', 'resource_localizations', 'product_stay_photo_room_memberships',
      'product_stay_room_accessibility_photos', 'product_stay_accessibility_photos')
    create('reviews', 'review_requests', 'content_documents')
    copy('reviews')
    copy('review_requests')
    copy('content_documents')
    run('media-reviews-localizations')
    drop('old_reviews', 'old_review_requests', 'old_content_documents', 'old_resource_localizations', 'old_product_stay_photo_room_memberships',
      'old_product_stay_room_accessibility_photos', 'old_product_stay_accessibility_photos')

    rename('message_templates')
    create('message_templates')
    run('payloads')
    drop('old_message_templates')

    const shared = ['business_locations', 'invitation', 'session', 'product_availability_rules', 'product_sessions']
    rename(...shared)
    const sessions = count('old_product_sessions')
    run('sessions')
    const folded = sessions - count('old_product_sessions')
    if (folded) manifest.transforms.push({ name: 'duplicate_provider_sessions_folded', changes: folded })
    create(...shared)
    for (const table of shared) copy(table)
    drop(...shared.map(table => 'old_' + table))
    drop('team', 'teamMember', 'reservations', 'location_reservation_configs', 'google_calendar_sync')
  })()
}

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
    baseline_sha256: hash(baseSql), source_migrations: [], target_migrations: files, tables: [], transforms: [], invariants: [], hours_session_ids: [], hours_session_source_hashes: {},
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
    for (const directory of [MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20', 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16', 'migrations-history/v15', 'migrations-history/v14', 'migrations-history/v13', 'migrations-history/v12', 'migrations-history/v11', 'migrations-history/v10', 'migrations-history/v9', 'migrations-history/v8', 'migrations-history/v7']) {
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
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20', 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16', 'migrations-history/v15', 'migrations-history/v14', 'migrations-history/v13', 'migrations-history/v12', 'migrations-history/v11'].includes(sourceDirectory)) {
      for (const name of readdirSync('migrations-history/v11').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v11', name), 'utf8'))
      }
    }
    // An older archived chain reaches v12 through v12's forward migrations, which the v13 baseline absorbed.
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20', 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16', 'migrations-history/v15', 'migrations-history/v14', 'migrations-history/v13', 'migrations-history/v12'].includes(sourceDirectory)) {
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
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20', 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16', 'migrations-history/v15', 'migrations-history/v14', 'migrations-history/v13'].includes(sourceDirectory)) {
      for (const name of readdirSync('migrations-history/v13').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v13', name), 'utf8'))
      }
    }
    if (sourceDirectory !== MIGRATIONS_DIRECTORY) {
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
        const definition = v26Baseline().split('--> statement-breakpoint').find(statement => statement.includes(`CREATE TABLE \`${table}\``))
        assert(definition, `Native Better Auth ${table} schema is missing`)
        stage.exec(definition)
      }
    }
    // v15 relaxes the calendar group CHECK only. Older chains still pass
    // through v14's canonical content data migration before the exact copy.
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20', 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16', 'migrations-history/v15', 'migrations-history/v14'].includes(sourceDirectory)) {
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
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20', 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17', 'migrations-history/v16'].includes(sourceDirectory)) {
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
        const [, name, table, list] = statement.match(/CREATE (?:UNIQUE )?INDEX `([^`]+)` ON `([^`]+)` \(([^)]*)\)/u) ?? []
        if (!name || !table) continue
        if (added.has(table)) { stage.exec(statement); continue }
        // A table the stage already had gains the baseline's newer indexes on
        // columns it has: a later composite foreign key names them as its parent key.
        const exists = stage.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name)
        const have = new Set(stage.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map(row => row.name))
        const wanted = [...list.matchAll(/`([^`]+)`/gu)].map(match => match[1])
        if (!exists && tableNames(stage).includes(table) && wanted.length && wanted.every(column => have.has(column))) stage.exec(statement)
      }
    }
    // v18 absorbs v17's deployed forward chain (Channex connections, channel
    // mappings, the sync log, night pushes and stay threads). Older chains pass
    // through it before the exact copy; a v17 source already ran its pending ones above.
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20', 'migrations-history/v19', 'migrations-history/v18', 'migrations-history/v17'].includes(sourceDirectory)) {
      withBaselineTables(readFileSync('migrations-history/v17/0000_baseline.sql', 'utf8'))
      for (const name of readdirSync('migrations-history/v17').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v17', name), 'utf8'))
      }
    }
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20', 'migrations-history/v19'].includes(sourceDirectory)) withBaselineTables(readFileSync('migrations-history/v19/0000_baseline.sql', 'utf8'))
    // v19 adds facts no older row has: no copied stay was received as a new
    // reservation and no home has private instructions yet. A saved category
    // preference predates push, so its push switch is that category's
    // product default, exactly as for a person who never saved one.
    if (sourceDirectory !== MIGRATIONS_DIRECTORY) {
      for (const [table, column, type] of [
        ['stays', 'booking_received_at', 'TEXT'],
        ['product_stay_configs', 'check_in_instructions', 'TEXT'],
      ]) {
        if (!columns(stage, table).includes(column)) stage.exec(`ALTER TABLE ${qi(table)} ADD COLUMN ${qi(column)} ${type}`)
      }
    }
    if (tableNames(stage).includes('user_notification_preferences') && !columns(stage, 'user_notification_preferences').includes('push_enabled')) {
      // This v18 → v19 transformation uses v19's policy, independently of later product categories.
      const pushDefaults = { account_security: 0, reservations_bookings: 1, guest_messages: 1, reviews: 0, review_requests: 0, organization_and_billing: 0, product_news: 0 }
      stage.exec('ALTER TABLE user_notification_preferences ADD COLUMN push_enabled INTEGER')
      const update = stage.prepare('UPDATE user_notification_preferences SET push_enabled = ? WHERE category = ?')
      const changes = Object.entries(pushDefaults).reduce((total, [category, enabled]) => total + update.run(enabled, category).changes, 0)
      const unmapped = stage.prepare('SELECT count(*) AS n FROM user_notification_preferences WHERE push_enabled IS NULL').get().n
      assert(unmapped === 0, `${unmapped} notification preferences name a category with no push default; no rows were copied`)
      if (changes) manifest.transforms.push({ name: 'notification_preferences_push_default', changes })
    }
    // Older epochs reach v19 through its full archived forward chain before
    // receiving tables and forward migrations from the current baseline.
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20', 'migrations-history/v19'].includes(sourceDirectory)) {
      for (const name of readdirSync('migrations-history/v19').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v19', name), 'utf8'))
      }
    }
    // Older epochs reach v20 the same way: its baseline's tables, then its
    // forward chain. Rehoming an archived forward migration does not make it a
    // second operation: the complete v19 chain already ran on this stage.
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20'].includes(sourceDirectory)) {
      withBaselineTables(readFileSync('migrations-history/v20/0000_baseline.sql', 'utf8'))
      const absorbed = new Set(readdirSync('migrations-history/v19').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)
        .map(name => hash(readFileSync(resolve('migrations-history/v19', name), 'utf8'))))
      for (const name of readdirSync('migrations-history/v20').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        const sql = readFileSync(resolve('migrations-history/v20', name), 'utf8')
        if (!absorbed.has(hash(sql))) stage.exec(sql)
      }
    }
    // v21 widens stays_channel_check to admit Booking.com; every v20 row fits it
    // unchanged. Complete its archived forward chain, including the manual-group
    // backfill, before copying into the replacement's relaxed responsibility CHECK.
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21'].includes(sourceDirectory)) {
      withBaselineTables(readFileSync('migrations-history/v21/0000_baseline.sql', 'utf8'))
      for (const name of readdirSync('migrations-history/v21').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v21', name), 'utf8'))
      }
    }
    // v22's pending leaf migrations must run before its tables are copied into
    // the baseline that retires the duplicated nightly rule. No referenced table is dropped remotely.
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22'].includes(sourceDirectory)) {
      withBaselineTables(readFileSync('migrations-history/v22/0000_baseline.sql', 'utf8'))
      for (const name of readdirSync('migrations-history/v22').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v22', name), 'utf8'))
      }
    }
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23'].includes(sourceDirectory)) {
      // Legacy homes have no recorded weekday/weekend rules. Keep that absence
      // as NULL while advancing the private stage to the v23 schema.
      stage.exec('ALTER TABLE product_stay_configs ADD COLUMN calendar_rules TEXT NULL')
      withBaselineTables(readFileSync('migrations-history/v23/0000_baseline.sql', 'utf8'))
      for (const name of readdirSync('migrations-history/v23').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) {
        stage.exec(readFileSync(resolve('migrations-history/v23', name), 'utf8'))
      }
    }
    // v23 to v24: work and opportunities are stored. Every person's feedback
    // becomes the business's opportunity at that evidence revision, an accepted
    // one with its task; the feedback table is then gone. requests'
    // conversation_state and resolved_at are not copied (RETIRED_COLUMNS):
    // an open guest_reply task, derived from the ledger by `yarn db:tasks`,
    // says whether the business owes a reply.
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24'].includes(sourceDirectory)) {
      withBaselineTables(readFileSync('migrations-history/v24/0000_baseline.sql', 'utf8'))
      const references = stage.prepare("SELECT count(*) AS n FROM (SELECT DISTINCT organization_id, operation, subject_id, evidence_revision, coalesce(goal_id, '') FROM recommendation_feedback)").get().n
      const accepted = stage.prepare("SELECT count(*) AS n FROM (SELECT DISTINCT organization_id, operation, subject_id, evidence_revision, coalesce(goal_id, '') FROM recommendation_feedback f WHERE decision = 'accept' AND updated_at = (SELECT max(updated_at) FROM recommendation_feedback g WHERE g.organization_id = f.organization_id AND g.operation = f.operation AND g.subject_id = f.subject_id AND g.evidence_revision = f.evidence_revision AND g.goal_id IS f.goal_id))").get().n
      stage.exec(RECOMMENDATION_FEEDBACK_TO_OPPORTUNITIES)
      const opportunities = stage.prepare('SELECT count(*) AS n FROM opportunities').get().n
      const tasks = stage.prepare("SELECT count(*) AS n FROM tasks WHERE kind = 'opportunity'").get().n
      assert(opportunities === references && tasks === accepted, `Recommendation feedback mapped ${opportunities} of ${references} references and ${tasks} of ${accepted} accepted tasks; no rows were copied`)
      if (references) manifest.transforms.push({ name: 'recommendation_feedback_to_opportunities', changes: opportunities })
      stage.exec('DROP TABLE recommendation_feedback')
      for (const name of readdirSync('migrations-history/v24').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) stage.exec(readFileSync(resolve('migrations-history/v24', name), 'utf8'))
    }
    // Older epochs reach v25 through its baseline's tables and forward chain.
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25'].includes(sourceDirectory)) {
      withBaselineTables(readFileSync('migrations-history/v25/0000_baseline.sql', 'utf8'))
      for (const name of readdirSync('migrations-history/v25').filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) stage.exec(readFileSync(resolve('migrations-history/v25', name), 'utf8'))
    }
    // v25 to v26: a business that publishes its own sessions schedules as
    // 'business'. The value was 'legacy', the column's old default. Stock
    // tables and Hosted Checkout fields that nothing reads or writes are
    // dropped; a row or value in them fails rather than being discarded.
    if (sourceDirectory !== MIGRATIONS_DIRECTORY && sourceDirectory !== V26_DIRECTORY) {
      withBaselineTables(v26Baseline())
      for (const table of ['inventory_levels', 'inventory_items']) {
        if (!tableNames(stage).includes(table)) continue
        assert(stage.prepare(`SELECT count(*) AS n FROM ${qi(table)}`).get().n === 0, `${table} holds rows nothing maps; no rows were copied`)
        stage.exec(`DROP TABLE ${qi(table)}`)
      }
      if (columns(stage, 'payment_attempts').includes('checkout_url')) {
        // A test-mode Hosted Checkout that never reached a PaymentIntent and was
        // left open or expired is dead: its session id and URL go; the attempt,
        // its payment and its status stay. Any other value fails.
        const dead = `stripe_payment_intent_id IS NULL AND status IN ('open', 'expired') AND stripe_checkout_id LIKE 'cs_test_%'
          AND payment_id IN (SELECT id FROM payments WHERE livemode = 0)`
        const hosted = stage.prepare(`SELECT id FROM payment_attempts WHERE (stripe_checkout_id IS NOT NULL OR checkout_url IS NOT NULL) AND NOT (${dead})`).all()
        assert(hosted.length === 0, `Payment attempts hold Hosted Checkout fields nothing maps: ${hosted.slice(0, 8).map(row => row.id).join(', ')}; no rows were copied`)
        const discarded = stage.prepare(`SELECT count(*) AS n FROM payment_attempts WHERE ${dead}`).get().n
        if (discarded) manifest.transforms.push({ name: 'dead_test_hosted_checkout_fields_discarded', changes: discarded })
      }
      if (tableNames(stage).includes('payment_attempts')) {
        // A purchase has one attempt and one claim; both become columns of the payment.
        const repeated = stage.prepare(`SELECT payment_id FROM payment_attempts GROUP BY payment_id HAVING count(*) > 1 UNION SELECT payment_id FROM payment_claims GROUP BY payment_id HAVING count(*) > 1`).all()
        assert(repeated.length === 0, `Payments with more than one attempt or claim: ${repeated.slice(0, 8).map(row => row.payment_id).join(', ')}; no rows were copied`)
        const divergent = stage.prepare(`SELECT a.id FROM payment_attempts a JOIN payments p ON p.id = a.payment_id WHERE a.stripe_payment_intent_id IS NOT NULL AND a.stripe_payment_intent_id IS NOT p.stripe_payment_intent_id`).all()
        assert(divergent.length === 0, `Payment attempts name an intent their payment does not: ${divergent.slice(0, 8).map(row => row.id).join(', ')}; no rows were copied`)
        // An attempt's status is Stripe's intent status or its own expiry, both of which the payment keeps; a status that is neither cannot be folded.
        const unmapped = stage.prepare(`SELECT id, status FROM payment_attempts WHERE status NOT IN ('creating', 'open', 'expired', 'action_required', 'confirmed', 'canceled')`).all()
        assert(unmapped.length === 0, `Payment attempts with a status the payment cannot keep: ${unmapped.slice(0, 8).map(row => `${row.id} (${row.status})`).join(', ')}; no rows were copied`)
        for (const column of ['idempotency_key', 'checkout_expires_at', 'review_json', 'return_token', 'return_token_hash', 'return_expires_at', 'claimed_at', 'claimed_user_id']) stage.exec(`ALTER TABLE payments ADD COLUMN ${column} TEXT`)
        const folded = stage.prepare(`UPDATE payments SET
          idempotency_key = (SELECT idempotency_key FROM payment_attempts a WHERE a.payment_id = payments.id),
          checkout_expires_at = (SELECT expires_at FROM payment_attempts a WHERE a.payment_id = payments.id),
          review_json = (SELECT review_json FROM payment_attempts a WHERE a.payment_id = payments.id),
          return_token = (SELECT return_token FROM payment_attempts a WHERE a.payment_id = payments.id),
          return_token_hash = (SELECT token_hash FROM payment_claims c WHERE c.payment_id = payments.id),
          return_expires_at = (SELECT expires_at FROM payment_claims c WHERE c.payment_id = payments.id),
          claimed_at = (SELECT claimed_at FROM payment_claims c WHERE c.payment_id = payments.id),
          claimed_user_id = (SELECT claimed_user_id FROM payment_claims c WHERE c.payment_id = payments.id)
          WHERE id IN (SELECT payment_id FROM payment_attempts UNION SELECT payment_id FROM payment_claims)`).run().changes
        stage.exec('DROP TABLE payment_claims; DROP TABLE payment_attempts')
        if (folded) manifest.transforms.push({ name: 'payment_attempts_and_claims_folded_into_payments', changes: folded })
      }
      // A superseded opportunity is evidence that went stale before anyone
      // decided about it. Nothing reads it: undecided, with no task, it goes.
      const undecided = `status = 'superseded' AND decided_at IS NULL AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.opportunity_id = opportunities.id)`
      const decided = stage.prepare(`SELECT id FROM opportunities WHERE status = 'superseded' AND NOT (${undecided})`).all()
      assert(decided.length === 0, `Superseded opportunities with a decision or task: ${decided.slice(0, 8).map(row => row.id).join(', ')}; no rows were copied`)
      const superseded = stage.prepare(`DELETE FROM opportunities WHERE ${undecided}`).run().changes
      if (superseded) manifest.transforms.push({ name: 'superseded_opportunities_removed', changes: superseded })
      const renamed = stage.prepare("UPDATE product_booking_configs SET scheduling_mode = 'business' WHERE scheduling_mode = 'legacy'").run().changes
      const unknown = stage.prepare("SELECT product_id, scheduling_mode FROM product_booking_configs WHERE scheduling_mode NOT IN ('business', 'provider')").all()
      assert(unknown.length === 0, `Booking configurations with an unknown scheduling mode: ${JSON.stringify(unknown.slice(0, 8))}; no rows were copied`)
      if (renamed) manifest.transforms.push({ name: 'scheduling_mode_legacy_to_business', changes: renamed })
      // Every guest sleeps where they booked until a host moves them.
      if (!columns(stage, 'stays').includes('booked_product_id')) stage.exec('ALTER TABLE stays ADD COLUMN booked_product_id TEXT')
      if (!columns(stage, 'team_threads').includes('booking_id')) stage.exec('ALTER TABLE team_threads ADD COLUMN booking_id TEXT')
      // Every message so far was written by a person.
      if (!columns(stage, 'team_messages').includes('automatic')) stage.exec('ALTER TABLE team_messages ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0')
      for (const name of readdirSync(V26_DIRECTORY).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort().slice(1)) stage.exec(readFileSync(resolve(V26_DIRECTORY, name), 'utf8'))
    }
    // Airbnb's single minimum was duplicated by the old importer. The owner also
    // approved retiring these exact Saltleaf demo rules; every other host rule
    // still requires explicit reconciliation before its column can be retired.
    if (columns(stage, 'product_nights').includes('min_stay_through')) {
      const unsafe = stage.prepare(`SELECT product_id, date FROM product_nights WHERE min_stay_through IS NOT NULL
        AND NOT (min_stay_arrival IS NOT NULL AND min_stay_through = min_stay_arrival AND (
          source = 'import' OR (source = 'host'
            AND organization_id = '5mbJj0T09tvDCSfhOlUTEt4idxKt82tc'
            AND product_id = '2521e20c-6857-448a-a3a9-7cd389be29e0'
            AND ((date BETWEEN '2026-11-01' AND '2026-11-10' AND min_stay_arrival = 1)
              OR (date = '2026-11-23' AND min_stay_arrival = 3)
              OR (date BETWEEN '2026-12-01' AND '2027-05-01' AND min_stay_arrival = 2)))))`).all()
      assert(unsafe.length === 0, `Through-stay values need explicit reconciliation before retirement: ${JSON.stringify(unsafe.slice(0, 8))}; no rows were copied`)
      const retired = stage.prepare("SELECT count(*) AS n FROM product_nights WHERE min_stay_through IS NOT NULL AND source = 'import'").get().n
      if (retired) manifest.transforms.push({ name: 'airbnb_duplicated_through_minimum_removed', changes: retired })
      // The exact date/value set and unique home/date key bound this authorization.
      // Already removed rules do not invalidate the remaining approved dates.
      const approved = stage.prepare("SELECT count(*) AS n FROM product_nights WHERE min_stay_through IS NOT NULL AND source = 'host'").get().n
      if (approved) manifest.transforms.push({ name: 'owner_approved_saltleaf_through_minimum_removed', changes: approved })
    }
    if (sourceDirectory !== MIGRATIONS_DIRECTORY) {
      await consolidateV26(stage, baseSql, manifest)
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
    if (![MIGRATIONS_DIRECTORY, V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23'].includes(sourceDirectory)) {
      // Seed the existing content-import edit guard only for a default still
      // equal to the original first imported night. The protected source read
      // can then correct that derivation; this transfer never guesses its value.
      const provenDefaultsSql = `SELECT m.product_id, settings.min_nights FROM product_stay_configs c
        JOIN product_booking_configs settings ON settings.organization_id = c.organization_id AND settings.product_id = c.product_id
        JOIN product_channel_mappings m ON m.organization_id = c.organization_id AND m.product_id = c.product_id AND m.provider = 'channex'
        JOIN activity_entries created ON created.organization_id = c.organization_id
          AND created.event_name = 'product.created' AND created.occurred_at = c.created_at
          AND created.dedupe_key = 'create:product:' || c.organization_id || ':airbnb-listing:' || m.listing_id
          AND json_extract(created.payload_json, '$.entityId') = c.product_id
        JOIN activity_entries imported ON imported.organization_id = c.organization_id AND imported.event_name = 'stay.nights_imported'
          AND json_extract(imported.payload_json, '$.entityId') = c.product_id
          AND imported.occurred_at = (SELECT min(first_import.occurred_at) FROM activity_entries first_import
            WHERE first_import.organization_id = c.organization_id AND first_import.event_name = 'stay.nights_imported'
              AND json_extract(first_import.payload_json, '$.entityId') = c.product_id)
        JOIN product_nights n ON n.organization_id = c.organization_id AND n.product_id = c.product_id
          AND n.date = json_extract(imported.payload_json, '$.metadata.from') AND n.source = 'import'
          AND n.updated_at = imported.occurred_at AND n.min_stay_arrival = settings.min_nights
        WHERE json_type(m.import_written, '$.min_nights') IS NULL`
      const seed = target.prepare(`UPDATE product_channel_mappings SET import_written = json_set(COALESCE(import_written, '{}'), '$.min_nights', ?)
        WHERE product_id = ? AND provider = 'channex' AND json_type(import_written, '$.min_nights') IS NULL`)
      let seeded = 0
      for (const home of target.prepare(provenDefaultsSql).all()) seeded += seed.run(hash(JSON.stringify(home.min_nights)), home.product_id).changes
      if (seeded) manifest.transforms.push({ name: 'airbnb_original_minimum_edit_guard_recorded', changes: seeded, sql_sha256: hash(provenDefaultsSql) })
      // Resume the existing sync operation under the original importing member.
      // A newer pending or failed request or a stop is never replaced.
      const candidatesSql = `SELECT m.organization_id, m.product_id, m.listing_id, c.created_by FROM product_channel_mappings m
        JOIN product_stay_configs c ON c.product_id = m.product_id AND c.organization_id = m.organization_id
        JOIN channex_connections connection ON connection.organization_id = m.organization_id
          AND connection.channel_id = m.channel_id AND connection.status = 'connected'
        JOIN member actor ON actor.organizationId = m.organization_id AND actor.userId = c.created_by AND actor.role IN ('owner', 'admin')
        WHERE m.provider = 'channex' AND m.enabled = 1 AND m.import_stage = 'complete'`
      const queueSql = `INSERT INTO airbnb_sync_jobs (id, organization_id, listing_id, product_id, action, details, state, requested_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'sync', NULL, 'pending', ?, ?, ?)
        ON CONFLICT (organization_id, listing_id) DO UPDATE SET product_id = excluded.product_id,
          details = NULL, state = 'pending', requested_by = excluded.requested_by,
          last_error_code = NULL, last_error = NULL, completed_at = NULL, updated_at = excluded.updated_at
        WHERE airbnb_sync_jobs.action = 'sync' AND airbnb_sync_jobs.state = 'done'`
      const queue = target.prepare(queueSql)
      let queued = 0
      const at = new Date().toISOString()
      const earlier = deltaFrom ? comparisonDatabase(deltaFrom) : null
      try {
        const jobs = target.prepare('SELECT * FROM airbnb_sync_jobs WHERE organization_id = ? AND listing_id = ?')
        const previous = earlier?.prepare('SELECT * FROM airbnb_sync_jobs WHERE organization_id = ? AND listing_id = ?')
        const retainTimestamp = target.prepare('UPDATE airbnb_sync_jobs SET created_at = ?, updated_at = ? WHERE id = ?')
        for (const home of target.prepare(candidatesSql).all()) {
          const original = jobs.get(home.organization_id, home.listing_id)
          const changes = queue.run(hash(`airbnb-v23-sync:${home.organization_id}:${home.listing_id}`), home.organization_id, home.listing_id, home.product_id, home.created_by, at, at).changes
          queued += changes
          if (changes && previous) {
            const row = jobs.get(home.organization_id, home.listing_id)
            const initial = previous.get(home.organization_id, home.listing_id)
            assert(row, `Queued Airbnb sync job missing: ${home.organization_id}/${home.listing_id}`)
            // Identical derived facts keep their initial queue time. A source
            // job keeps its own creation time; a new derived job starts now.
            if (initial && Object.keys(row).every(name => name === 'updated_at' || (!original && name === 'created_at') || row[name] === initial[name])) {
              retainTimestamp.run(original ? row.created_at : initial.created_at, initial.updated_at, row.id)
            }
          }
        }
      } finally { earlier?.close() }
      if (queued) manifest.transforms.push({ name: 'airbnb_canonical_sync_queued', changes: queued, sql_sha256: hash(queueSql) })
    }
    const retiredSettings = target.prepare("UPDATE organization SET settings_json = json_remove(settings_json, '$.config.default_timezone') WHERE json_type(settings_json, '$.config.default_timezone') IS NOT NULL").run().changes
    if (retiredSettings) manifest.transforms.push({ name: 'organization_timezone_out_of_settings', changes: retiredSettings })
    if (fromV7) {
      const names = Object.keys(integrations[0] ?? { id: null })
      const insert = target.prepare(`INSERT INTO organization_integrations (${names.map(qi).join(',')}) VALUES (${names.map(() => '?').join(',')})`)
      target.transaction(() => { for (const row of integrations) insert.run(...names.map(name => row[name])) })()
      assert(count(target, 'organization_integrations') === integrations.length, 'organization_integrations differs from the connections it maps')
      manifest.transforms.push({ name: 'integrations_json_to_organization_integrations', changes: integrations.length })
    }
    if (sourceDirectory !== MIGRATIONS_DIRECTORY) {
      const rebuildProviderHours = ![V26_DIRECTORY, 'migrations-history/v25', 'migrations-history/v24', 'migrations-history/v23', 'migrations-history/v22', 'migrations-history/v21', 'migrations-history/v20', 'migrations-history/v19'].includes(sourceDirectory)
      const configs = rebuildProviderHours ? target.prepare('SELECT * FROM product_booking_configs WHERE held_online = 1 ORDER BY product_id').all() : []
      const tables = target.prepare(`SELECT c.*, l.id AS location_id, l.timezone, l.status, l.opening_hours, l.special_hours
        FROM product_booking_configs c
        JOIN product_locations pl ON pl.organization_id = c.organization_id AND pl.product_id = c.product_id
        JOIN business_locations l ON l.organization_id = pl.organization_id AND l.id = pl.location_id
        WHERE c.seating_interval_minutes IS NOT NULL ORDER BY c.product_id`).all()
      // The legacy reservation transfer names a booked table session from its
      // location and start. An old writer may book one before the final delta.
      const tableSessionId = (locationId, start) => 'table-session-' + locationId + '-' + start
      const hoursProducts = new Map([
        ...configs.map(config => [config.product_id, null]),
        ...tables.map(table => [table.product_id, table.location_id]),
      ])
      const previousSourceRows = new Map()
      const retainedHoursIds = new Set()
      if (deltaFrom && hoursProducts.size) {
        // These rows were derived on the replacement, never held by the old
        // source. Seed their canonical occurrences before regeneration so the
        // native unique index retains their identities across a final delta.
        // Real source sessions are not inventoried, so their deletions remain
        // visible in the payload audit rather than being restored here.
        const previous = JSON.parse(readFileSync(`${deltaFrom}.manifest.json`, 'utf8'))
        assert(previous.baseline_sha256 === manifest.baseline_sha256, 'The initial transfer was built from another baseline')
        assert(Array.isArray(previous.hours_session_ids) && previous.hours_session_ids.every(id => typeof id === 'string')
          && new Set(previous.hours_session_ids).size === previous.hours_session_ids.length,
        'The initial transfer has no valid hours session inventory; repeat the initial preflight before deriving a delta')
        assert(previous.hours_session_source_hashes && typeof previous.hours_session_source_hashes === 'object'
          && !Array.isArray(previous.hours_session_source_hashes) && Object.values(previous.hours_session_source_hashes).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)),
        'The initial transfer has no valid hours session source signatures; repeat the initial preflight before deriving a delta')
        const earlier = comparisonDatabase(deltaFrom)
        try {
          assert(sameSchema(earlier, target), 'The initial transfer schema differs from the current target')
          for (const [id, signature] of Object.entries(previous.hours_session_source_hashes)) {
            const row = earlier.prepare('SELECT * FROM product_sessions WHERE id = ?').get(id)
            assert(row, `Initial hours source session is missing: ${id}`)
            previousSourceRows.set(id, { row, signature })
          }
          const sessionColumns = columns(target, 'product_sessions')
          const insert = target.prepare(`INSERT INTO product_sessions (${sessionColumns.map(qi).join(',')}) VALUES (${sessionColumns.map(() => '?').join(',')})`)
          const sourceOccurrence = target.prepare('SELECT id FROM product_sessions WHERE product_id = ? AND starts_at = ? AND location_id IS ? LIMIT 1')
          target.transaction(() => {
            for (const id of previous.hours_session_ids) {
              const row = earlier.prepare('SELECT * FROM product_sessions WHERE id = ?').get(id)
              assert(row && row.source_occurrence_key?.startsWith('hours:')
                && row.source_occurrence_key.endsWith(':' + row.starts_at), `Invalid initial hours session: ${id}`)
              if (hoursProducts.get(row.product_id) !== row.location_id) continue
              const occupied = sourceOccurrence.get(row.product_id, row.starts_at, row.location_id)
              if (row.location_id !== null && occupied?.id === row.id && row.id === tableSessionId(row.location_id, row.starts_at)) continue
              assert(!occupied, `Source session ${occupied?.id} occupies initial derived session ${id}; explicitly reconcile this occurrence before a creations-only delta. No replacement rows were overwritten.`)
              try { insert.run(...sessionColumns.map(name => row[name])) }
              catch (cause) { throw new Error(`Retaining hours session ${id}: ${cause.message}`, { cause }) }
              retainedHoursIds.add(id)
            }
          })()
          manifest.transforms.push({ name: 'hours_session_identities_retained', changes: retainedHoursIds.size })
        } finally { earlier.close() }
      }
      if (hoursProducts.size) {
        const { prepareProviderHoursSessions, tableSeatingQueries } = await import('../server/utils/availability.ts')
        const db = drizzle(target)
        const before = new Map(target.prepare('SELECT * FROM product_sessions').all().map(row => [row.id, row]))
        const now = new Date().toISOString()
        const queries = []
        for (const config of configs) queries.push(...await prepareProviderHoursSessions(db, config, { actorId: 'system', now }))
        for (const table of tables) {
          const { location_id: id, timezone, status, opening_hours, special_hours } = table
          queries.push(...tableSeatingQueries(table, { id, timezone, status, opening_hours, special_hours },
            { actorId: 'system', now, sessionIdForStart: start => tableSessionId(id, start) }))
        }
        const changes = target.transaction(() => queries.reduce((total, { query, params }) => {
          try { return total + target.prepare(query).run(...params).changes }
          catch (cause) { throw new Error(`Generating booking sessions from hours: ${cause.message}`, { cause }) }
        }, 0))()
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
            if (JSON.stringify(row) !== JSON.stringify(original)) manifest.hours_session_source_hashes[row.id] = signature
          }
        })()
        manifest.hours_session_ids = sessions.filter(row => !before.has(row.id) || retainedHoursIds.has(row.id)).map(row => row.id)
        const created = sessions.filter(row => !before.has(row.id)).length
        manifest.transforms.push({ name: 'hours_sessions_created', changes: created }, { name: 'hours_sessions_updated', changes: changes - created })
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
    manifest.invariants = await auditTargetInvariants(target)
    const broken = manifest.invariants.filter(result => result.violations > 0)
    assert(broken.length === 0, `Invariant violations: ${JSON.stringify(broken)}`)
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
