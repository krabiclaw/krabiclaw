import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

test('the migration chain applies from zero and builds every table the schema declares', () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  try {
    const journal = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')) as { entries: Array<{ idx: number; tag: string }> }
    for (const entry of journal.entries) database.exec(readFileSync(`migrations/${entry.tag}.sql`, 'utf8'))
    const last = journal.entries.at(-1)!
    const snapshot = JSON.parse(readFileSync(`migrations/meta/${String(last.idx).padStart(4, '0')}_snapshot.json`, 'utf8')) as { tables: Record<string, { name: string }> }
    const declared = Object.values(snapshot.tables).map(table => table.name).sort()
    const built = (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
      .map(row => row.name)
    assert.deepEqual(built, declared)
    const consultation = { mode: 'native', cta_label: 'Book', schedule_path: '/schedule', confirmation_path: '/confirmed', tracking_enabled: true, metadata_json: {} }
    database.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone, consultation_settings_json) VALUES (?, ?, ?, 'USD', 'America/New_York', ?)").run('tenant-a', 'A', 'tenant-a', JSON.stringify(consultation))
    database.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('tenant-b', 'B', 'tenant-b', 'THB', 'Asia/Bangkok')").run()
    // A business cannot be stored without the currency it sells in and the clock it reports in.
    assert.throws(() => database.prepare("INSERT INTO organization (id, name, slug, timezone) VALUES ('no-currency', 'C', 'no-currency', 'Asia/Bangkok')").run(), /NOT NULL constraint failed: organization.default_currency/)
    assert.throws(() => database.prepare("INSERT INTO organization (id, name, slug, default_currency) VALUES ('no-clock', 'C', 'no-clock', 'USD')").run(), /NOT NULL constraint failed: organization.timezone/)
    for (const invalid of [{ ...consultation, mode: 'unknown' }, { ...consultation, tracking_enabled: 'true' }, { ...consultation, metadata_json: [] }, { ...consultation, schedule_path: 'schedule' }, { mode: 'native' }]) {
      assert.throws(() => database.prepare("UPDATE organization SET consultation_settings_json = ? WHERE id = 'tenant-a'").run(JSON.stringify(invalid)), /organization_consultation_settings_check/)
    }
    assert.deepEqual(JSON.parse((database.prepare("SELECT consultation_settings_json FROM organization WHERE id = 'tenant-a'").get() as { consultation_settings_json: string }).consultation_settings_json), consultation)
    for (const organizationId of ['tenant-a', 'tenant-b']) {
      database.prepare('INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, ?, 0, ?)').run(`${organizationId}-th`, organizationId, 'th', 'published')
      database.prepare("INSERT INTO resource_localizations (id, organization_id, resource_type, resource_id, locale, route_path, values_json, created_by_user_id, updated_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'test', 'test')").run(`${organizationId}-route`, organizationId, 'product', `${organizationId}-product`, 'th', '/th/products/shared', '{}')
    }
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM resource_localizations WHERE route_path = '/th/products/shared'").get() as { count: number }).count, 2)
    assert.throws(() => database.prepare("INSERT INTO resource_localizations (id, organization_id, resource_type, resource_id, locale, route_path, values_json, created_by_user_id, updated_by_user_id) VALUES ('duplicate-route', 'tenant-a', 'product', 'another-product', 'th', '/th/products/shared', '{}', 'test', 'test')").run(), /UNIQUE constraint failed/)
    assert.equal(database.pragma('foreign_key_check').length, 0)
  } finally {
    database.close()
  }
})

test('a v7 export transfers into the current baseline, its connections into organization_integrations', async () => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-v7-transfer-'))
  const v7 = ['0000_baseline.sql', '0001_drop_typed_social_profiles.sql', '0002_products_overview.sql']
  const export7 = (name: string, integrations: Record<string, unknown>) => {
    const path = join(directory, name)
    const source = new Database(path)
    for (const file of v7) source.exec(readFileSync(`migrations-history/v7/${file}`, 'utf8'))
    source.exec(`CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      ${v7.map(file => `INSERT INTO d1_migrations (name) VALUES ('${file}');`).join('\n')}`)
    source.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, settings_json, integrations_json) VALUES ('org', 'Org', 'org', 'org', 'USD', '{\"config\":{\"default_timezone\":\"America/New_York\"}}', ?)").run(JSON.stringify(integrations))
    source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', 'org', 'en', 1, 'published')").run()
    source.close()
    return path
  }
  const at = '2026-09-28T00:00:00.000Z'
  try {
    const sourcePath = export7('v7.sqlite', {
      facebook: { revision: 'fb-r', account_id: 'fb-account', page_id: 'page-1', page_name: 'Krabi Claw', status: 'active', created_at: at, updated_at: at },
      google_analytics: { revision: 'ga-r', account_id: 'google-account', property_id: '542527926', property_name: 'Krabiclaw', measurement_id: 'G-TEST', status: 'active', created_at: at, updated_at: at },
      google_search_console: { revision: 'gsc-r', account_id: 'google-account', site_url: 'sc-domain:krabiclaw.com', verified: true, status: 'active', created_at: at, updated_at: at },
    })
    const targetPath = join(directory, 'v8.sqlite')
    const manifest = transferDatabaseExport(sourcePath, targetPath)
    assert.deepEqual(manifest.source_migrations, v7)
    const target = new Database(targetPath, { readonly: true })
    try {
      assert.deepEqual(target.pragma('foreign_key_check'), [])
      assert.deepEqual(target.prepare('SELECT provider, account_id, target_id, target_name, measurement_id, verified, revision FROM organization_integrations ORDER BY provider').all(), [
        { provider: 'facebook', account_id: 'fb-account', target_id: 'page-1', target_name: 'Krabi Claw', measurement_id: null, verified: null, revision: 'fb-r' },
        { provider: 'google_analytics', account_id: 'google-account', target_id: '542527926', target_name: 'Krabiclaw', measurement_id: 'G-TEST', verified: null, revision: 'ga-r' },
        { provider: 'google_search_console', account_id: 'google-account', target_id: 'sc-domain:krabiclaw.com', target_name: 'sc-domain:krabiclaw.com', measurement_id: null, verified: 1, revision: 'gsc-r' },
      ])
      const organizationColumns = (target.prepare('PRAGMA table_info(organization)').all() as Array<{ name: string }>).map(column => column.name)
      assert.equal(organizationColumns.includes('integrations_json'), false)
    } finally {
      target.close()
    }

    // A connection that cannot be mapped stops the transfer.
    for (const [name, integrations, reason] of [
      ['unknown.sqlite', { google_business: { status: 'active' } }, /unmapped integration google_business/],
      ['errored.sqlite', { instagram: { revision: 'r', account_id: 'a', instagram_user_id: '1', username: 'u', status: 'error', created_at: at, updated_at: at } }, /instagram is error/],
      ['incomplete.sqlite', { google_analytics: { revision: 'r', measurement_id: 'G-X', status: 'active', created_at: at, updated_at: at } }, /google_analytics.account_id is missing/],
    ] as const) {
      assert.throws(() => transferDatabaseExport(export7(name, integrations), join(directory, `target-${name}`)), reason)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a v11 export transfers into the v12 baseline, which has no capability overrides', async () => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-v11-transfer-'))
  const v11 = JSON.parse(readFileSync('migrations-history/v11/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
  const export11 = (name: string, overrides: string | null) => {
    const path = join(directory, name)
    const source = new Database(path)
    for (const file of v11) source.exec(readFileSync(`migrations-history/v11/${file}`, 'utf8'))
    source.exec(`CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      ${v11.map(file => `INSERT INTO d1_migrations (name) VALUES ('${file}');`).join('\n')}`)
    source.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, settings_json, feature_overrides) VALUES ('org', 'Org', 'org', 'org', 'USD', '{\"config\":{\"default_timezone\":\"America/New_York\"}}', ?)").run(overrides)
    source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', 'org', 'en', 1, 'published')").run()
    source.close()
    return path
  }
  try {
    const targetPath = join(directory, 'v12.sqlite')
    const manifest = transferDatabaseExport(export11('v11.sqlite', null), targetPath)
    assert.deepEqual(manifest.source_migrations, v11)
    const target = new Database(targetPath, { readonly: true })
    try {
      assert.deepEqual(target.pragma('foreign_key_check'), [])
      assert.equal((target.prepare("SELECT slug FROM organization WHERE id = 'org'").get() as { slug: string }).slug, 'org')
      for (const table of ['organization', 'business_locations']) {
        assert.equal((target.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(column => column.name === 'feature_overrides'), false)
      }
    } finally {
      target.close()
    }
    // An override nothing maps stops the transfer rather than disappearing.
    assert.throws(() => transferDatabaseExport(export11('override.sqlite', '{"reservations":false}'), join(directory, 'target-override.sqlite')), /organization.feature_overrides holds values nothing maps/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a v12 export transfers into the v13 baseline with one site palette and logo presentations', async () => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const { TEMPLATE_PALETTES } = await import('../../shared/site-palette.ts')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-v12-transfer-'))
  const v12 = JSON.parse(readFileSync('migrations-history/v12/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
  const blawbyTokens = { bg: '#fbfaf7', surface: '#ffffff', primary: '#25356c', primaryDark: '#161f3b', primary100: '#f2f5ff', primary200: '#b4c5e5', primary800: '#1d294f', accent: '#c19855', accent100: '#faf5ea', accent200: '#f8f0e1', accentButton: '#b58c4f', accentStrong: '#a37732', border: '#e5e7eb', ink: '#162033' }
  const export12 = (name: string, tokens: Record<string, string>) => {
    const path = join(directory, name)
    const source = new Database(path)
    for (const file of v12) source.exec(readFileSync(`migrations-history/v12/${file}`, 'utf8'))
    source.exec(`CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      ${v12.map(file => `INSERT INTO d1_migrations (name) VALUES ('${file}');`).join('\n')}`)
    const organization = source.prepare("INSERT INTO organization (id, name, slug, subdomain, theme_id, default_currency, settings_json) VALUES (?, ?, ?, ?, ?, 'USD', ?)")
    organization.run('saya', 'Saya', 'saya', 'saya', 'saya-theme-v1', JSON.stringify({ config: { default_timezone: 'Asia/Bangkok', brand_color: '#96826a' } }))
    organization.run('blawby', 'Blawby', 'blawby', 'blawby', 'blawby-theme-v1', JSON.stringify({ config: { default_timezone: 'America/New_York' }, theme_by_template: { blawby: { tokens, status: 'active', created_at: '2026-07-14 02:32:27', updated_at: '2026-07-14 02:32:27', updated_by: null } } }))
    for (const id of ['saya', 'blawby']) {
      source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES (?, ?, 'en', 1, 'published')").run(`${id}-en`, id)
      source.prepare("INSERT INTO media_assets (id, organization_id, kind, provider, source, public_url, status) VALUES (?, ?, 'image', 'cloudflare_images', 'uploaded', 'https://imagedelivery.net/h/logo/public', 'active')").run(`${id}-logo`, id)
      source.prepare("INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id) VALUES (?, ?, 'organization', ?, 'logo', ?)").run(`${id}-logo-placement`, id, id, `${id}-logo`)
    }
    source.close()
    return path
  }
  try {
    const targetPath = join(directory, 'v13.sqlite')
    const manifest = transferDatabaseExport(export12('v12.sqlite', blawbyTokens), targetPath)
    assert.deepEqual(manifest.source_migrations, v12)
    const target = new Database(targetPath, { readonly: true })
    try {
      assert.deepEqual(target.pragma('foreign_key_check'), [])
      const settings = (id: string) => JSON.parse((target.prepare('SELECT settings_json FROM organization WHERE id = ?').get(id) as { settings_json: string }).settings_json)
      // The Saya brand color is its palette's action color; everything else is Saya's own.
      const saya = settings('saya')
      assert.equal(saya.config.brand_color, undefined)
      assert.deepEqual(saya.config.palette.light, { ...TEMPLATE_PALETTES.saya.light, action: '#96826A' })
      assert.equal(saya.config.palette.dark.ground, TEMPLATE_PALETTES.saya.dark.ground)
      assert.notEqual(saya.config.palette.dark.action, '#96826A')
      // Blawby's stored tokens were its defaults: it wears its template's palette.
      const blawby = settings('blawby')
      assert.equal(blawby.theme_by_template, undefined)
      assert.equal(blawby.config.palette, undefined)
      const presentation = (id: string) => (target.prepare("SELECT presentation_json FROM media_placements WHERE organization_id = ? AND slot = 'logo'").get(id) as { presentation_json: string | null }).presentation_json
      assert.deepEqual(JSON.parse(presentation('saya')!), { shape: 'circle', focus: { x: 0.5, y: 0.5 } })
      assert.equal(presentation('blawby'), null)
    } finally {
      target.close()
    }
    // Tokens that are not Blawby's defaults have no palette to become; the transfer stops.
    assert.throws(() => transferDatabaseExport(export12('custom-tokens.sqlite', { ...blawbyTokens, primary: '#004400' }), join(directory, 'target-tokens.sqlite')), /theme_by_template.blawby holds tokens other than Blawby's defaults/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a v15 export transfers into the v16 baseline: required clocks and currencies, online offerings held by their providers', async () => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-v15-transfer-'))
  const v15 = JSON.parse(readFileSync('migrations-history/v15/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
  const export15 = (name: string, { timezone = 'America/New_York', currency = 'USD' as string | null, member = 'member-1' as string | null } = {}) => {
    const path = join(directory, name)
    const source = new Database(path)
    for (const file of v15) source.exec(readFileSync(`migrations-history/v15/${file}`, 'utf8'))
    source.exec(`CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      ${v15.map(file => `INSERT INTO d1_migrations (name) VALUES ('${file}');`).join('\n')}`)
    source.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, settings_json) VALUES ('org', 'Org', 'org', 'org', ?, ?)").run(currency, JSON.stringify({ config: { default_timezone: timezone } }))
    source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', 'org', 'en', 1, 'published')").run()
    source.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-1', 'Provider', 'p@example.com', 1, 1, 1)").run()
    source.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('member-1', 'org', 'user-1', 'owner', 1)").run()
    source.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('consult', 'org', 'service', 'Consult', 'consult', 'user-1', 'user-1')").run()
    source.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('consult-default', 'org', 'consult', 'Consult', 'user-1', 'user-1')").run()
    source.prepare("INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, online_timezone, scheduling_mode, assigned_member_id, created_by, updated_by) VALUES ('consult', 'org', 30, 'America/New_York', ?, ?, 'user-1', 'user-1')").run(member ? 'provider' : 'legacy', member)
    source.prepare("INSERT INTO product_availability_rules (id, organization_id, product_id, location_id, timezone, weekday, start_time, created_by, updated_by) VALUES ('rule', 'org', 'consult', NULL, 'America/New_York', 1, '09:00', 'user-1', 'user-1')").run()
    source.prepare("INSERT INTO product_sessions (id, organization_id, product_id, location_id, availability_rule_id, source_occurrence_key, timezone, starts_at, ends_at, status, created_by, updated_by) VALUES ('session', 'org', 'consult', NULL, 'rule', 'rule:2026-11-02:09:00', 'America/New_York', '2026-11-02T14:00:00.000Z', '2026-11-02T14:30:00.000Z', 'scheduled', 'user-1', 'user-1')").run()
    source.close()
    return path
  }
  try {
    const targetPath = join(directory, 'v16.sqlite')
    transferDatabaseExport(export15('v15.sqlite'), targetPath)
    const target = new Database(targetPath, { readonly: true })
    try {
      assert.deepEqual(target.pragma('foreign_key_check'), [])
      assert.deepEqual(target.prepare("SELECT default_currency, timezone, settings_json FROM organization WHERE id = 'org'").get(), { default_currency: 'USD', timezone: 'America/New_York', settings_json: '{"config":{}}' })
      assert.deepEqual(target.prepare("SELECT held_online FROM product_booking_configs WHERE product_id = 'consult'").get(), { held_online: 1 })
      // The session and its time survive; its provider and provider-hours identity are explicit.
      assert.deepEqual(target.prepare("SELECT assigned_member_id, availability_rule_id, source_occurrence_key, starts_at FROM product_sessions WHERE id = 'session'").get(),
        { assigned_member_id: 'member-1', availability_rule_id: null, source_occurrence_key: 'hours:member-1:2026-11-02T14:00:00.000Z', starts_at: '2026-11-02T14:00:00.000Z' })
      assert.equal((target.prepare('SELECT count(*) AS n FROM product_availability_rules').get() as { n: number }).n, 0)
    } finally {
      target.close()
    }
    // A value nobody chose, a missing one, or an online offering nobody provides stops the transfer.
    assert.throws(() => transferDatabaseExport(export15('utc.sqlite', { timezone: 'UTC' }), join(directory, 'target-utc.sqlite')), /without their own currency or timezone/)
    assert.throws(() => transferDatabaseExport(export15('no-currency.sqlite', { currency: null }), join(directory, 'target-currency.sqlite')), /without their own currency or timezone/)
    assert.throws(() => transferDatabaseExport(export15('unprovided.sqlite', { member: null }), join(directory, 'target-unprovided.sqlite')), /Online offerings with nobody to provide them: consult/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('consultation settings move preserves every value with one canonical source and referenced organization', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  try {
    db.exec(readFileSync('migrations-history/v8/0000_baseline.sql', 'utf8'))
    db.exec(readFileSync('migrations-history/v8/0001_message_attachments.sql', 'utf8'))
    const settings = { consultation: { mode: 'external_url', cta_label: 'Schedule', external_url: 'https://example.com/book', schedule_path: '/schedule', confirmation_path: '/confirmed', tracking_enabled: false, metadata_json: { custom: 'preserved' } }, config: { default_timezone: 'America/New_York' } }
    db.prepare('INSERT INTO organization (id,name,slug,createdAt,settings_json) VALUES (?,?,?,?,?)').run('consultation-migration', 'Example', 'consultation-migration', 1, JSON.stringify(settings))
    db.exec(readFileSync('migrations-history/v8/0002_native_consultation_foundation.sql', 'utf8'))
    const row = db.prepare('SELECT settings_json,consultation_settings_json FROM organization WHERE id = ?').get('consultation-migration') as { settings_json: string; consultation_settings_json: string }
    assert.deepEqual(JSON.parse(row.settings_json), { config: settings.config })
    assert.deepEqual(JSON.parse(row.consultation_settings_json), settings.consultation)
    db.prepare('UPDATE organization SET consultation_settings_json = json_set(consultation_settings_json, \'$.mode\', \'native\') WHERE id = ?').run('consultation-migration')
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  } finally { db.close() }
})

test('snapshot payload preserves destination signing keys for refreshes and carries source keys for replacements', async () => {
  const { writePayload } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-signing-transfer-'))
  const journal = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string }> }
  const schema = journal.entries.map(entry => readFileSync(`migrations/${entry.tag}.sql`, 'utf8')).join('\n')
  const source = new Database(':memory:')
  source.exec(schema)
  source.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org', 'Refreshed content', 'org', 'org', 'USD', 'America/New_York')").run()
  source.prepare('INSERT INTO jwks (id, publicKey, privateKey, createdAt) VALUES (?, ?, ?, ?)').run('source', 'fixture-public-source', 'fixture-private-source', 1)
  try {
    for (const withoutJwks of [true, false]) {
      const destination = new Database(':memory:')
      try {
        destination.exec(schema)
        destination.prepare('INSERT INTO jwks (id, publicKey, privateKey, createdAt) VALUES (?, ?, ?, ?)').run('destination', 'fixture-public-destination', 'fixture-private-destination', 2)
        const payload = join(directory, `payload-${withoutJwks}.sql`)
        writePayload(source, payload, schema, { withoutJwks })
        destination.exec(readFileSync(payload, 'utf8'))
        assert.deepEqual(destination.prepare('SELECT id, publicKey, privateKey, createdAt FROM jwks').all(), [{
          id: withoutJwks ? 'destination' : 'source',
          publicKey: withoutJwks ? 'fixture-public-destination' : 'fixture-public-source',
          privateKey: withoutJwks ? 'fixture-private-destination' : 'fixture-private-source',
          createdAt: withoutJwks ? 2 : 1,
        }])
        assert.equal(destination.prepare("SELECT name FROM organization WHERE id = 'org'").get().name, 'Refreshed content')
        assert.deepEqual(destination.pragma('foreign_key_check'), [])
      } finally {
        destination.close()
      }
    }
  } finally {
    source.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
