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

test('room migrations preserve authored facts and photo memberships without deriving room facts from listing totals or amenities', () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  try {
    const journal = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')) as { entries: Array<{ idx: number; tag: string }> }
    for (const entry of journal.entries.filter(entry => entry.idx <= 14)) database.exec(readFileSync(`migrations/${entry.tag}.sql`, 'utf8'))
    database.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('org', 'Host', 'host', 'USD', 'America/Denver')").run()
    database.prepare("INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('site', 'org', 'site', 'Cabin', 'America/Denver')").run()
    for (const productId of ['authored-home', 'counts-only-home']) {
      database.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES (?, 'org', 'stay', ?, ?, 'host', 'host')").run(productId, productId, productId)
      database.prepare("INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by) VALUES ('org', ?, 'site', 'host', 'host')").run(productId)
      database.prepare("INSERT INTO product_stay_configs (organization_id, product_id, location_id, check_in_time, check_out_time, max_guests, bedrooms, beds, bathrooms, created_by, updated_by) VALUES ('org', ?, 'site', '16:00', '10:00', 6, 3, 5, 1.5, 'host', 'host')").run(productId)
    }
    database.prepare("INSERT INTO media_assets (id, organization_id, kind, provider, source, public_url, status) VALUES ('photo', 'org', 'image', 'cloudflare_images', 'uploaded', 'https://imagedelivery.net/h/room/public', 'active')").run()
    database.prepare("INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id) VALUES ('cover', 'org', 'product', 'authored-home', 'image', 'photo')").run()
    database.prepare("INSERT INTO product_stay_photo_rooms (id, organization_id, product_id, type, sort_order, created_by) VALUES ('bedroom', 'org', 'authored-home', 'bedroom', 3, 'host'), ('living-room', 'org', 'authored-home', 'living_room', 8, 'host')").run()
    database.prepare("INSERT INTO product_stay_photo_room_memberships (organization_id, product_id, asset_id, room_id) VALUES ('org', 'authored-home', 'photo', 'bedroom')").run()
    const rooms = database.prepare('SELECT * FROM product_stay_photo_rooms ORDER BY sort_order').all()
    const memberships = database.prepare('SELECT * FROM product_stay_photo_room_memberships').all()
    const placements = database.prepare('SELECT * FROM media_placements').all()
    const listings = database.prepare('SELECT * FROM product_stay_configs ORDER BY product_id').all()

    database.exec(readFileSync('migrations/0015_stay_room_details.sql', 'utf8'))

    assert.deepEqual(database.prepare('SELECT id, organization_id, product_id, type, sort_order, created_at, created_by FROM product_stay_photo_rooms ORDER BY sort_order').all(), rooms)
    assert.deepEqual(database.prepare('SELECT id, details_version, sleeping_arrangements, private_attached_bathroom FROM product_stay_photo_rooms ORDER BY sort_order').all(), [
      { id: 'bedroom', details_version: 1, sleeping_arrangements: null, private_attached_bathroom: null },
      { id: 'living-room', details_version: 1, sleeping_arrangements: null, private_attached_bathroom: null },
    ])
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_room_memberships').all(), memberships)
    assert.deepEqual(database.prepare('SELECT * FROM media_placements').all(), placements)
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_configs ORDER BY product_id').all(), listings)
    assert.equal(database.prepare("SELECT count(*) AS count FROM product_stay_photo_rooms WHERE product_id = 'counts-only-home'").get()!.count, 0)

    // The next migration adds membership without assigning a listing-wide
    // amenity to any particular room or disturbing already authored facts.
    database.prepare("UPDATE product_stay_photo_rooms SET sleeping_arrangements = '[{\"type\":\"queen\",\"count\":2}]', private_attached_bathroom = 0, details_version = 4 WHERE id = 'bedroom'").run()
    database.prepare("UPDATE product_stay_configs SET amenities = '[\"tv\",\"wireless_internet\"]' WHERE product_id = 'authored-home'").run()
    const authoredRooms = database.prepare('SELECT * FROM product_stay_photo_rooms ORDER BY sort_order').all()
    const authoredListings = database.prepare('SELECT * FROM product_stay_configs ORDER BY product_id').all()

    database.exec(readFileSync('migrations/0016_stay_room_amenities.sql', 'utf8'))

    assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_rooms ORDER BY sort_order').all(), authoredRooms)
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_configs ORDER BY product_id').all(), authoredListings)
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_room_memberships').all(), memberships)
    assert.deepEqual(database.prepare('SELECT * FROM media_placements').all(), placements)
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_room_amenities').all(), [])
    assert.equal(database.prepare("SELECT count(*) AS count FROM product_stay_photo_rooms WHERE product_id = 'counts-only-home'").get()!.count, 0)
    assert.throws(() => database.prepare("INSERT INTO product_stay_photo_room_amenities (organization_id, product_id, room_id, amenity_code) VALUES ('org', 'authored-home', 'bedroom', 'invented_amenity')").run(), /product_stay_photo_room_amenities_code_check/)
    assert.throws(() => database.prepare("INSERT INTO product_stay_photo_room_amenities (organization_id, product_id, room_id, amenity_code) VALUES ('org', 'counts-only-home', 'bedroom', 'tv')").run(), /FOREIGN KEY constraint failed/)

    database.prepare("INSERT INTO product_stay_photo_room_amenities (organization_id, product_id, room_id, amenity_code) VALUES ('org', 'authored-home', 'bedroom', 'tv')").run()
    const roomAmenities = database.prepare('SELECT * FROM product_stay_photo_room_amenities').all()
    database.exec(readFileSync('migrations/0017_stay_room_accessibility.sql', 'utf8'))

    assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_rooms ORDER BY sort_order').all(), authoredRooms)
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_configs ORDER BY product_id').all(), authoredListings)
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_room_memberships').all(), memberships)
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_room_amenities').all(), roomAmenities)
    assert.deepEqual(database.prepare('SELECT * FROM media_placements').all(), placements)
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_room_accessibility').all(), [])
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_room_accessibility_photos').all(), [])
    assert.throws(() => database.prepare("INSERT INTO product_stay_room_accessibility (organization_id, product_id, room_id, feature_code, available) VALUES ('org', 'authored-home', 'bedroom', 'invented_feature', 0)").run(), /product_stay_room_accessibility_feature_check/)
    assert.throws(() => database.prepare("INSERT INTO product_stay_room_accessibility (organization_id, product_id, room_id, feature_code, available) VALUES ('org', 'authored-home', 'bedroom', 'step_free_access', 2)").run(), /product_stay_room_accessibility_available_check/)
    assert.throws(() => database.prepare("INSERT INTO product_stay_room_accessibility (organization_id, product_id, room_id, feature_code, available) VALUES ('org', 'counts-only-home', 'bedroom', 'step_free_access', 0)").run(), /FOREIGN KEY constraint failed/)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
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
      google_analytics: { revision: 'ga-r', account_id: 'google-account', property_id: '542527926', property_name: 'KrabiClaw', measurement_id: 'G-TEST', status: 'active', created_at: at, updated_at: at },
      google_search_console: { revision: 'gsc-r', account_id: 'google-account', site_url: 'sc-domain:krabiclaw.com', verified: true, status: 'active', created_at: at, updated_at: at },
    })
    const targetPath = join(directory, 'v8.sqlite')
    const manifest = await transferDatabaseExport(sourcePath, targetPath)
    assert.deepEqual(manifest.source_migrations, v7)
    const target = new Database(targetPath, { readonly: true })
    try {
      assert.deepEqual(target.pragma('foreign_key_check'), [])
      assert.deepEqual(target.prepare('SELECT provider, account_id, target_id, target_name, measurement_id, verified, revision FROM organization_integrations ORDER BY provider').all(), [
        { provider: 'facebook', account_id: 'fb-account', target_id: 'page-1', target_name: 'Krabi Claw', measurement_id: null, verified: null, revision: 'fb-r' },
        { provider: 'google_analytics', account_id: 'google-account', target_id: '542527926', target_name: 'KrabiClaw', measurement_id: 'G-TEST', verified: null, revision: 'ga-r' },
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
      await assert.rejects(() => transferDatabaseExport(export7(name, integrations), join(directory, `target-${name}`)), reason)
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
    const manifest = await transferDatabaseExport(export11('v11.sqlite', null), targetPath)
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
    await assert.rejects(() => transferDatabaseExport(export11('override.sqlite', '{"reservations":false}'), join(directory, 'target-override.sqlite')), /organization.feature_overrides holds values nothing maps/)
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
    const manifest = await transferDatabaseExport(export12('v12.sqlite', blawbyTokens), targetPath)
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
    await assert.rejects(() => transferDatabaseExport(export12('custom-tokens.sqlite', { ...blawbyTokens, primary: '#004400' }), join(directory, 'target-tokens.sqlite')), /theme_by_template.blawby holds tokens other than Blawby's defaults/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a v15 export transfers into the v16 baseline: required clocks and currencies, online offerings held by their providers', async t => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const { workingWindows } = await import('../../server/domain/member-scheduling.ts')
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const { prepareProviderHoursSessions } = await import('../../server/utils/availability.ts')
  const now = '2026-10-13T00:00:00.000Z'
  t.mock.timers.enable({ apis: ['Date'], now: new Date(now) })
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-v15-transfer-'))
  const v15 = JSON.parse(readFileSync('migrations-history/v15/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
  const weekly = Array.from({ length: 7 }, (_, weekday) => ({ weekday, start: '09:00', end: '10:00' }))
  const windows = workingWindows('America/New_York', weekly)
  const export15 = (name: string, { timezone = 'America/New_York', currency = 'USD' as string | null, member = 'member-1' as string | null, hours = true, secondProvider = false, team = false } = {}) => {
    const path = join(directory, name)
    const source = new Database(path)
    for (const file of v15) source.exec(readFileSync(`migrations-history/v15/${file}`, 'utf8'))
    source.exec(`CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      ${v15.map(file => `INSERT INTO d1_migrations (name) VALUES ('${file}');`).join('\n')}`)
    source.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, settings_json) VALUES ('org', 'Org', 'org', 'org', ?, ?)").run(currency, JSON.stringify({ config: { default_timezone: timezone } }))
    source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', 'org', 'en', 1, 'published')").run()
    source.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-1', 'Provider', 'p@example.com', 1, 1, 1)").run()
    source.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('member-1', 'org', 'user-1', 'owner', 1)").run()
    if (hours) source.prepare("INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, windows_json, windows_until, calendar_revision, updated_at, updated_by) VALUES ('member-1', 'org', 'America/New_York', ?, '[]', ?, ?, 'revision', ?, 'user-1')").run(JSON.stringify(weekly), JSON.stringify(windows.intervals), windows.until, now)
    if (secondProvider || team) {
      source.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-2', 'Second provider', 'second@example.com', 1, 1, 1)").run()
      source.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('member-2', 'org', 'user-2', 'owner', 1)").run()
      source.prepare("INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, windows_json, windows_until, calendar_revision, updated_at, updated_by) VALUES ('member-2', 'org', 'America/New_York', ?, '[]', ?, ?, 'revision', ?, 'user-2')").run(JSON.stringify(weekly), JSON.stringify(windows.intervals), windows.until, now)
    }
    source.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('consult', 'org', 'service', 'Consult', 'consult', 'user-1', 'user-1')").run()
    source.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('consult-default', 'org', 'consult', 'Consult', 'user-1', 'user-1')").run()
    source.prepare("INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, online_timezone, scheduling_mode, assigned_member_id, created_by, updated_by) VALUES ('consult', 'org', 30, 1, 'America/New_York', ?, ?, 'user-1', 'user-1')").run(member ? 'provider' : 'legacy', member)
    source.prepare("INSERT INTO product_availability_rules (id, organization_id, product_id, location_id, timezone, weekday, start_time, created_by, updated_by) VALUES ('rule', 'org', 'consult', NULL, 'America/New_York', 1, '09:00', 'user-1', 'user-1')").run()
    const session = source.prepare("INSERT INTO product_sessions (id, organization_id, product_id, location_id, availability_rule_id, source_occurrence_key, timezone, starts_at, ends_at, capacity, status, updated_at, created_by, updated_by) VALUES (?, 'org', 'consult', NULL, 'rule', ?, 'America/New_York', ?, ?, 4, 'scheduled', '2026-10-01T00:00:00.000Z', 'user-1', 'user-1')")
    session.run('session', 'rule:2026-11-02:09:00', '2026-11-02T14:00:00.000Z', '2026-11-02T15:00:00.000Z')
    session.run('held-session', 'rule:2026-11-03:09:00', '2026-11-03T14:00:00.000Z', '2026-11-03T15:00:00.000Z')
    session.run('obsolete-session', 'rule:2026-09-02:09:00', '2026-09-02T13:00:00.000Z', '2026-09-02T14:00:00.000Z')
    session.run('outside-horizon', 'rule:2026-11-20:09:00', '2026-11-20T14:00:00.000Z', '2026-11-20T14:30:00.000Z')
    source.prepare("INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size, status) VALUES ('booking-history', 'org', 'consult', 'session', 'consult-default', 1, 'cancelled')").run()
    source.prepare("INSERT INTO payments (id, organization_id, stripe_account_id, livemode, subject_type, currency, amount, price_snapshot_json, created_at, updated_at) VALUES ('payment', 'org', 'acct_test', 0, 'booking', 'USD', 100, '{}', ?, ?)").run(now, now)
    source.prepare("INSERT INTO payment_checkout_holds (id, organization_id, product_id, variant_id, price_id, session_id, payment_id, quantity, amount, currency, starts_at, ends_at, expires_at, created_at) VALUES ('hold', 'org', 'consult', 'consult-default', 'price', 'held-session', 'payment', 1, 100, 'USD', '2026-11-03T14:00:00.000Z', '2026-11-03T15:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'), ?)").run(now)
    if (secondProvider || team) source.prepare("UPDATE product_sessions SET assigned_member_id='member-1'").run()
    if (team) {
      source.prepare("INSERT INTO team (id, name, organizationId, createdAt) VALUES ('providers', 'Providers', 'org', 1)").run()
      source.prepare("INSERT INTO teamMember (id, teamId, userId, createdAt) VALUES ('team-one', 'providers', 'user-1', 1), ('team-two', 'providers', 'user-2', 1)").run()
      source.prepare("UPDATE product_booking_configs SET assigned_member_id=NULL, assigned_team_id='providers'").run()
    }
    source.close()
    return path
  }
  try {
    const targetPath = join(directory, 'v16.sqlite')
    const sourcePath = export15('v15.sqlite')
    const initialPayload = join(directory, 'initial.sql')
    const manifest = await transferDatabaseExport(sourcePath, targetPath, { payloadPath: initialPayload })
    const target = new Database(targetPath)
    try {
      assert.deepEqual(target.pragma('foreign_key_check'), [])
      assert.deepEqual(target.prepare("SELECT default_currency, timezone, settings_json FROM organization WHERE id = 'org'").get(), { default_currency: 'USD', timezone: 'America/New_York', settings_json: '{"config":{}}' })
      assert.deepEqual(target.prepare("SELECT held_online FROM product_booking_configs WHERE product_id = 'consult'").get(), { held_online: 1 })
      // The session and its time survive; its provider and provider-hours identity are explicit.
      assert.deepEqual(target.prepare("SELECT assigned_member_id, availability_rule_id, source_occurrence_key, starts_at FROM product_sessions WHERE id = 'session'").get(),
        { assigned_member_id: 'member-1', availability_rule_id: null, source_occurrence_key: 'hours:member-1:2026-11-02T14:00:00.000Z', starts_at: '2026-11-02T14:00:00.000Z' })
      assert.equal((target.prepare('SELECT count(*) AS n FROM product_availability_rules').get() as { n: number }).n, 0)
      // Availability comes from the existing provider windows, not the retired
      // weekly rule. Existing booking history and active holds keep their facts.
      assert.equal(manifest.provider_hours_session_ids.length, 60, '31 days × two half-hour slots minus two pre-existing source occurrences')
      assert.match(manifest.provider_hours_session_source_hashes['outside-horizon'], /^[a-f0-9]{64}$/)
      assert.deepEqual(target.prepare("SELECT status, updated_by FROM product_sessions WHERE id = 'outside-horizon'").get(), { status: 'cancelled', updated_by: 'system' })
      assert.deepEqual(target.prepare("SELECT id, ends_at, capacity, updated_at, updated_by FROM product_sessions WHERE id IN ('session', 'held-session') ORDER BY id").all(), [
        { id: 'held-session', ends_at: '2026-11-03T15:00:00.000Z', capacity: 4, updated_at: '2026-10-01T00:00:00.000Z', updated_by: 'user-1' },
        { id: 'session', ends_at: '2026-11-02T15:00:00.000Z', capacity: 4, updated_at: '2026-10-01T00:00:00.000Z', updated_by: 'user-1' },
      ])
      const generated = target.prepare("SELECT id, assigned_member_id, timezone, starts_at, ends_at, capacity, status FROM product_sessions WHERE id NOT IN ('session', 'held-session', 'obsolete-session', 'outside-horizon') ORDER BY starts_at").all() as Array<{ id: string; assigned_member_id: string; timezone: string; starts_at: string; ends_at: string; capacity: number; status: string }>
      assert.equal(generated.length, 60)
      assert(generated.every(row => row.assigned_member_id === 'member-1' && row.timezone === 'America/New_York' && row.capacity === 1 && row.status === 'scheduled'
        && Date.parse(row.ends_at) - Date.parse(row.starts_at) === 30 * 60_000
        && windows.intervals.some(window => window.start <= row.starts_at && window.end >= row.ends_at)))
      const before = target.prepare('SELECT * FROM product_sessions ORDER BY id').all()
      const config = target.prepare("SELECT * FROM product_booking_configs WHERE product_id = 'consult'").get()
      const queries = await prepareProviderHoursSessions(drizzle(target) as unknown as Parameters<typeof prepareProviderHoursSessions>[0], config as Parameters<typeof prepareProviderHoursSessions>[1], { actorId: 'another-operator', now: '2026-10-13T00:01:00.000Z' })
      assert.equal(target.transaction(() => queries.reduce((changes, query) => changes + target.prepare(query.query).run(...query.params!).changes, 0))(), 0, 'unchanged provider-hours generation changes no timestamps or rows')
      assert.deepEqual(target.prepare('SELECT * FROM product_sessions ORDER BY id').all(), before)
    } finally {
      target.close()
    }
    const deltaPath = join(directory, 'delta.sqlite')
    const deltaPayload = join(directory, 'delta.sql')
    t.mock.timers.tick(60_000)
    const delta = await transferDatabaseExport(sourcePath, deltaPath, { payloadPath: deltaPayload, deltaFrom: targetPath })
    assert.deepEqual(delta.provider_hours_session_ids, manifest.provider_hours_session_ids)
    assert.equal(Object.values(delta.payload!.delta!).reduce((total, rows) => total + rows, 0), 0, 'unchanged source creates no manufactured derived keys')
    assert.deepEqual(delta.payload!.left_behind, {}, 'unchanged source does not delete or change initial derived slots')
    assert.deepEqual(delta.provider_hours_session_source_hashes, manifest.provider_hours_session_source_hashes)
    const replay = new Database(':memory:')
    try {
      for (const entry of JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')).entries) replay.exec(readFileSync(`migrations/${entry.tag}.sql`, 'utf8'))
      replay.exec(readFileSync(initialPayload, 'utf8'))
      replay.exec(readFileSync(deltaPayload, 'utf8'))
      assert.deepEqual(replay.pragma('foreign_key_check'), [])
      assert.equal((replay.prepare('SELECT count(*) AS n FROM product_sessions').get() as { n: number }).n, 64)
    } finally { replay.close() }
    const source = new Database(sourcePath)
    source.prepare("DELETE FROM product_sessions WHERE id = 'obsolete-session'").run()
    source.close()
    const deletion = await transferDatabaseExport(sourcePath, join(directory, 'deleted.sqlite'), { payloadPath: join(directory, 'deleted.sql'), deltaFrom: targetPath })
    assert.deepEqual(deletion.provider_hours_session_ids, manifest.provider_hours_session_ids)
    assert.deepEqual(deletion.payload!.left_behind!.product_sessions, { changed: [], deleted: ['["obsolete-session"]'] }, 'real source deletion remains visible; derived identities survive')
    const edited = new Database(sourcePath)
    edited.prepare("UPDATE product_sessions SET updated_at = '2026-10-13T00:01:00.000Z' WHERE id = 'outside-horizon'").run()
    edited.close()
    const editDelta = await transferDatabaseExport(sourcePath, join(directory, 'edited.sqlite'), { payloadPath: join(directory, 'edited.sql'), deltaFrom: targetPath })
    assert.deepEqual(editDelta.payload!.left_behind!.product_sessions.changed, ['["outside-horizon"]'], 'a real source edit stays visible even when canonical slot facts are unchanged')
    // A claim arriving on the old source protects its occurrence even when
    // the initial target had derived a cancellation beyond its horizon.
    const claimed = new Database(sourcePath)
    claimed.prepare("INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size) VALUES ('late-source-booking', 'org', 'consult', 'outside-horizon', 'consult-default', 1)").run()
    claimed.close()
    const claimPath = join(directory, 'claimed.sqlite')
    const claimDelta = await transferDatabaseExport(sourcePath, claimPath, { payloadPath: join(directory, 'claimed.sql'), deltaFrom: targetPath })
    assert.equal(claimDelta.payload!.delta!.bookings, 1)
    assert.deepEqual(claimDelta.payload!.left_behind!.product_sessions.changed, ['["outside-horizon"]'], 'a real claim stays visible and does not inherit an earlier derived status')
    const claimTarget = new Database(claimPath, { readonly: true })
    assert.deepEqual(claimTarget.prepare("SELECT status, updated_at, updated_by FROM product_sessions WHERE id = 'outside-horizon'").get(), { status: 'scheduled', updated_at: '2026-10-13T00:01:00.000Z', updated_by: 'user-1' })
    claimTarget.close()
    // A source-created occurrence that collides with a derived replacement
    // identity needs explicit reconciliation; a delta cannot overwrite it.
    const earlier = new Database(targetPath, { readonly: true })
    const occurrence = earlier.prepare('SELECT starts_at, ends_at FROM product_sessions WHERE id = ?').get(manifest.provider_hours_session_ids[0]) as { starts_at: string; ends_at: string }
    earlier.close()
    const changedHours = new Database(sourcePath)
    changedHours.prepare("UPDATE member_scheduling SET time_off_json = ? WHERE member_id = 'member-1'").run(JSON.stringify([{ start: occurrence.starts_at, end: occurrence.ends_at }]))
    changedHours.close()
    const hoursPath = join(directory, 'changed-hours.sqlite')
    const hoursDelta = await transferDatabaseExport(sourcePath, hoursPath, { payloadPath: join(directory, 'changed-hours.sql'), deltaFrom: targetPath })
    assert(hoursDelta.payload!.left_behind!.product_sessions.changed.includes(JSON.stringify([manifest.provider_hours_session_ids[0]])), 'a provider-hours edit changes its derived occurrence and remains visible')
    const hoursTarget = new Database(hoursPath, { readonly: true })
    assert.deepEqual(hoursTarget.prepare('SELECT status, updated_by FROM product_sessions WHERE id = ?').get(manifest.provider_hours_session_ids[0]), { status: 'cancelled', updated_by: 'system' })
    hoursTarget.close()
    const collision = new Database(sourcePath)
    collision.prepare("INSERT INTO product_sessions (id, organization_id, product_id, assigned_member_id, source_occurrence_key, timezone, starts_at, ends_at, created_by, updated_by) VALUES ('source-created', 'org', 'consult', 'member-1', ?, 'America/New_York', ?, ?, 'user-1', 'user-1')").run(`hours:member-1:${occurrence.starts_at}`, occurrence.starts_at, occurrence.ends_at)
    collision.prepare("INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size) VALUES ('source-created-booking', 'org', 'consult', 'source-created', 'consult-default', 1)").run()
    collision.close()
    await assert.rejects(() => transferDatabaseExport(sourcePath, join(directory, 'conflict.sqlite'), { payloadPath: join(directory, 'conflict.sql'), deltaFrom: targetPath }),
      error => error instanceof Error && error.message === `Source session source-created occupies initial derived session ${manifest.provider_hours_session_ids[0]}; explicitly reconcile this occurrence before a creations-only delta. No replacement rows were overwritten.`)
    const freshPath = join(directory, 'fresh-source.sqlite')
    const fresh = await transferDatabaseExport(sourcePath, freshPath, { payloadPath: join(directory, 'fresh-source.sql') })
    assert.equal(fresh.provider_hours_session_ids.length, 59, 'a full preflight retains the source-owned occurrence instead of deriving its identity')
    const freshTarget = new Database(freshPath, { readonly: true })
    try {
      assert.deepEqual(freshTarget.prepare("SELECT id, starts_at, ends_at, assigned_member_id, status FROM product_sessions WHERE id = 'source-created'").get(),
        { id: 'source-created', ...occurrence, assigned_member_id: 'member-1', status: 'scheduled' })
      assert.deepEqual(freshTarget.prepare("SELECT product_session_id, party_size FROM bookings WHERE id = 'source-created-booking'").get(),
        { product_session_id: 'source-created', party_size: 1 })
      assert.deepEqual(freshTarget.pragma('foreign_key_check'), [])
    } finally { freshTarget.close() }
    for (const team of [false, true]) {
      const label = team ? 'team-removal' : 'reassignment'
      const sourcePath = export15(`${label}.sqlite`, { secondProvider: true, team })
      const initialPath = join(directory, `${label}-initial.sqlite`)
      const initial = await transferDatabaseExport(sourcePath, initialPath)
      assert.equal(initial.provider_hours_session_ids.length, team ? 122 : 60)
      const earlier = new Database(initialPath, { readonly: true })
      const removed = (earlier.prepare("SELECT id FROM product_sessions WHERE assigned_member_id='member-1' AND id NOT IN ('session','held-session','obsolete-session','outside-horizon') ORDER BY id").all() as Array<{ id: string }>).map(row => JSON.stringify([row.id]))
      assert.equal(removed.length, 60)
      earlier.close()
      const changed = new Database(sourcePath)
      changed.prepare(team ? "DELETE FROM teamMember WHERE id='team-one'" : "UPDATE product_booking_configs SET assigned_member_id='member-2'").run()
      changed.close()
      const currentPath = join(directory, `${label}-delta.sqlite`)
      const current = await transferDatabaseExport(sourcePath, currentPath, { payloadPath: join(directory, `${label}-delta.sql`), deltaFrom: initialPath })
      assert.deepEqual([...current.payload!.left_behind!.product_sessions.deleted].sort(), removed, 'obsolete derived provider rows are reported rather than restored')
      assert.equal(current.payload!.delta!.product_sessions, team ? 0 : 62)
      const target = new Database(currentPath, { readonly: true })
      assert.equal((target.prepare("SELECT count(*) AS n FROM product_sessions WHERE assigned_member_id='member-1' AND id NOT IN ('session','held-session','obsolete-session','outside-horizon')").get() as { n: number }).n, 0)
      assert.deepEqual(target.prepare("SELECT id, assigned_member_id, ends_at, capacity FROM product_sessions WHERE id IN ('session','held-session') ORDER BY id").all(), [
        { id: 'held-session', assigned_member_id: 'member-1', ends_at: '2026-11-03T15:00:00.000Z', capacity: 4 },
        { id: 'session', assigned_member_id: 'member-1', ends_at: '2026-11-02T15:00:00.000Z', capacity: 4 },
      ])
      target.close()
    }
    // A value nobody chose, a missing one, or an online offering nobody provides stops the transfer.
    await assert.rejects(() => transferDatabaseExport(export15('utc.sqlite', { timezone: 'UTC' }), join(directory, 'target-utc.sqlite')), /without their own currency or timezone/)
    await assert.rejects(() => transferDatabaseExport(export15('no-currency.sqlite', { currency: null }), join(directory, 'target-currency.sqlite')), /without their own currency or timezone/)
    await assert.rejects(() => transferDatabaseExport(export15('unprovided.sqlite', { member: null }), join(directory, 'target-unprovided.sqlite')), /Online offerings with nobody to provide them: consult/)
    await assert.rejects(() => transferDatabaseExport(export15('no-hours.sqlite', { hours: false }), join(directory, 'target-no-hours.sqlite')), /Set working hours for whoever provides this offering/)
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

test('a v16 export transfers into the v17 baseline unchanged, which admits places to stay', async () => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-v16-transfer-'))
  const v16 = JSON.parse(readFileSync('migrations-history/v16/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
  try {
    const sourcePath = join(directory, 'v16.sqlite')
    const source = new Database(sourcePath)
    for (const file of v16) source.exec(readFileSync(`migrations-history/v16/${file}`, 'utf8'))
    source.exec(`CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      ${v16.map(file => `INSERT INTO d1_migrations (name) VALUES ('${file}');`).join('\n')}`)
    source.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org', 'Org', 'org', 'org', 'USD', 'America/Denver')").run()
    source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', 'org', 'en', 1, 'published')").run()
    source.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('dish', 'org', 'dish', 'Noodles', 'noodles', 'user-1', 'user-1')").run()
    source.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('dish-default', 'org', 'dish', 'Noodles', 'user-1', 'user-1')").run()
    source.close()
    const targetPath = join(directory, 'v17.sqlite')
    await transferDatabaseExport(sourcePath, targetPath, { payloadPath: join(directory, 'payload.sql') })
    const target = new Database(targetPath)
    try {
      assert.deepEqual(target.pragma('foreign_key_check'), [])
      assert.deepEqual(target.prepare("SELECT id, kind, name FROM products WHERE organization_id = 'org'").all(), [{ id: 'dish', kind: 'dish', name: 'Noodles' }])
      for (const table of ['product_stay_configs', 'product_nights', 'stays', 'stay_nights', 'stay_payments']) {
        assert.equal((target.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, `${table} starts empty`)
      }
      target.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('home', 'org', 'stay', 'Cabin', 'cabin', 'user-1', 'user-1')").run()
      assert.throws(() => target.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('boat', 'org', 'boat', 'Boat', 'boat', 'user-1', 'user-1')").run(), /products_kind_check/)
    } finally {
      target.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a v17 export transfers into the v18 baseline, which admits a stay conversation held by phone alone', async () => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-v17-transfer-'))
  const v17 = JSON.parse(readFileSync('migrations-history/v17/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
  try {
    const sourcePath = join(directory, 'v17.sqlite')
    const source = new Database(sourcePath)
    for (const file of v17) source.exec(readFileSync(`migrations-history/v17/${file}`, 'utf8'))
    source.exec(`CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      ${v17.map(file => `INSERT INTO d1_migrations (name) VALUES ('${file}');`).join('\n')}`)
    source.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org', 'Org', 'org', 'org', 'USD', 'America/Denver')").run()
    source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', 'org', 'en', 1, 'published')").run()
    source.prepare("INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('site', 'org', 'site', 'Cabin', 'America/Denver')").run()
    source.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('home', 'org', 'stay', 'Cabin', 'cabin', 'user-1', 'user-1')").run()
    source.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('home-default', 'org', 'home', 'Cabin', 'user-1', 'user-1')").run()
    source.prepare("INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by) VALUES ('org', 'home', 'site', 'user-1', 'user-1')").run()
    source.prepare("INSERT INTO product_stay_configs (organization_id, product_id, location_id, check_in_time, check_out_time, max_guests, created_by, updated_by) VALUES ('org', 'home', 'site', '16:00', '10:00', 4, 'user-1', 'user-1')").run()
    source.prepare(`INSERT INTO requests (id, kind, organization_id, location_id, conversation_state, payload_json)
      VALUES ('thread', 'stay', 'org', 'site', 'waiting_on_guest', '{"guest":{"name":"Ana Silva","email":"ana@example.test","phone":null}}')`).run()
    source.prepare(`INSERT INTO stays (id, organization_id, product_id, channel, owner, status, check_in_date, check_out_date, adults, guest_name, guest_email, total_minor, currency, request_id)
      VALUES ('stay', 'org', 'home', 'direct', 'app', 'confirmed', '2027-01-10', '2027-01-12', 2, 'Ana', 'ana@example.test', 30000, 'USD', 'thread')`).run()
    // v17 holds a conversation only with an address to write to.
    assert.throws(() => source.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json) VALUES ('phone-only', 'stay', 'org', 'needs_attention', '{\"guest\":{\"name\":\"Kai\",\"email\":null,\"phone\":\"+15550000000\"}}')").run(), /requests_guest_payload_check/)
    source.close()
    const targetPath = join(directory, 'v18.sqlite')
    await transferDatabaseExport(sourcePath, targetPath, { payloadPath: join(directory, 'payload.sql') })
    const target = new Database(targetPath)
    try {
      assert.deepEqual(target.pragma('foreign_key_check'), [])
      assert.deepEqual(target.prepare("SELECT id, request_id, guest_email FROM stays").all(), [{ id: 'stay', request_id: 'thread', guest_email: 'ana@example.test' }])
      assert.deepEqual(target.prepare("SELECT id, kind, json_extract(payload_json, '$.guest.email') AS email FROM requests").all(), [{ id: 'thread', kind: 'stay', email: 'ana@example.test' }])
      // v18 holds one by phone alone, and still refuses a guest with neither.
      target.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json) VALUES ('phone-only', 'stay', 'org', 'needs_attention', '{\"guest\":{\"name\":\"Kai\",\"email\":null,\"phone\":\"+15550000000\"}}')").run()
      assert.deepEqual(JSON.parse((target.prepare("SELECT payload_json FROM requests WHERE id = 'phone-only'").get() as { payload_json: string }).payload_json).guest, { name: 'Kai', email: null, phone: '+15550000000' })
      // Other inbox kinds still require email at the persistence boundary.
      for (const kind of ['contact', 'reservation', 'booking']) {
        assert.throws(() => target.prepare('INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json) VALUES (?, ?, ?, ?, ?)')
          .run(`phone-only-${kind}`, kind, 'org', 'needs_attention', JSON.stringify({ guest: { name: 'Kai', email: null, phone: '+15550000000' }, message: 'Hello' })), /requests_guest_payload_check/)
      }
      // A payload that leaves the email key out is refused, not read as no email.
      assert.throws(() => target.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json) VALUES ('no-key', 'stay', 'org', 'needs_attention', '{\"guest\":{\"name\":\"Lu\",\"phone\":\"+15550000001\"}}')").run(), /requests_guest_payload_check/)
      assert.throws(() => target.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json) VALUES ('nobody', 'stay', 'org', 'needs_attention', '{\"guest\":{\"name\":\"Bo\",\"email\":null,\"phone\":null}}')").run(), /requests_guest_payload_check/)
    } finally {
      target.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a v18 export preserves its conversations and receipts unchanged in the channel-participant baseline', async () => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-v18-transfer-'))
  try {
    const sourcePath = join(directory, 'v18.sqlite')
    const source = new Database(sourcePath)
    const files = JSON.parse(readFileSync('migrations-history/v18/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
    for (const file of files) source.exec(readFileSync(`migrations-history/v18/${file}`, 'utf8'))
    source.exec(`CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      ${files.map(file => `INSERT INTO d1_migrations (name) VALUES ('${file}');`).join('\n')}`)
    source.prepare("INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone) VALUES ('org', 'Org', 'org', 'org', 'USD', 'America/Denver')").run()
    source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('org-en', 'org', 'en', 1, 'published')").run()
    source.prepare(`INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json)
      VALUES ('history', 'stay', 'org', 'needs_attention', '{"guest":{"name":"Recorded guest","email":null,"phone":"+15550000000"}}')`).run()
    source.prepare(`INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, channel, body, dedupe_key, sequence, occurred_at)
      VALUES ('message', 'history', 'message', 'request', 'guest', 'whatsapp', 'Recorded message', 'message-id', 1, '2026-10-16T00:00:00.000Z')`).run()
    source.prepare(`INSERT INTO guest_thread_deliveries (id, entry_id, channel, provider, purpose, status, provider_message_id)
      VALUES ('receipt', 'message', 'email', 'resend', 'owner_alert', 'accepted', 'actual-provider-id')`).run()
    const channel = JSON.stringify({ participant: { kind: 'channel', title: 'Provider conversation title' }, guest: { name: null, email: null, phone: null } })
    assert.throws(() => source.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json) VALUES ('channel', 'stay', 'org', 'needs_attention', ?)").run(channel), /requests_guest_payload_check/)
    source.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('person', 'Person', 'person@example.test', 1, 0, 0)").run()
    source.prepare("INSERT INTO user_notification_preferences (user_id, category, email_enabled, whatsapp_enabled) VALUES ('person', 'guest_messages', 0, 1), ('person', 'reviews', 1, 0)").run()
    const before = ['requests', 'activity_entries', 'guest_thread_deliveries'].map(table => source.prepare(`SELECT * FROM ${table}`).all())
    source.close()
    const targetPath = join(directory, 'v19.sqlite')
    const manifest = await transferDatabaseExport(sourcePath, targetPath, { payloadPath: join(directory, 'payload.sql') })
    // Only the push switch, which no v18 preference had, is derived: each category's product default.
    assert.deepEqual(manifest.transforms, [{ name: 'notification_preferences_push_default', changes: 2 }])
    const target = new Database(targetPath)
    try {
      assert.deepEqual(target.pragma('foreign_key_check'), [])
      assert.deepEqual(['requests', 'activity_entries', 'guest_thread_deliveries'].map(table => target.prepare(`SELECT * FROM ${table}`).all()), before)
      assert.equal(target.prepare('SELECT count(*) AS n FROM channel_threads').get()!.n, 0)
      assert.deepEqual(target.prepare('SELECT category, email_enabled, whatsapp_enabled, push_enabled FROM user_notification_preferences ORDER BY category').all(),
        [{ category: 'guest_messages', email_enabled: 0, whatsapp_enabled: 1, push_enabled: 1 }, { category: 'reviews', email_enabled: 1, whatsapp_enabled: 0, push_enabled: 0 }])
      target.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json) VALUES ('channel', 'stay', 'org', 'needs_attention', ?)").run(channel)
      for (const guest of [undefined, {}, { name: null, email: null }, { name: null, phone: null }, { email: null, phone: null }]) {
        assert.throws(() => target.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json) VALUES ('missing-guest', 'stay', 'org', 'needs_attention', ?)")
          .run(JSON.stringify({ participant: { kind: 'channel', title: 'Actual title' }, ...(guest === undefined ? {} : { guest }) })), /requests_guest_payload_check/)
      }
      assert.throws(() => target.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json) VALUES ('invalid', 'stay', 'org', 'needs_attention', ?)")
        .run(JSON.stringify({ participant: { kind: 'channel', title: '' }, guest: { name: null, email: null, phone: null } })), /requests_guest_payload_check/)
      assert.throws(() => target.prepare("INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json) VALUES ('contact', 'contact', 'org', 'needs_attention', ?)").run(channel), /requests_guest_payload_check/)
    } finally { target.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
