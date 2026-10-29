import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('channel retry proof preserves every historical receipt as unknown and leaves old writers unable to assert non-delivery', () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  try {
    const journal = JSON.parse(readFileSync('migrations-history/v20/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string }> }
    const migration = journal.entries.findIndex(entry => entry.tag === '0005_channel_reply_retry_proof')
    assert.notEqual(migration, -1)
    for (const entry of journal.entries.slice(0, migration)) database.exec(readFileSync(`migrations-history/v20/${entry.tag}.sql`, 'utf8'))
    database.prepare("INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('host', 'Host', 'host', 'USD', 'America/Denver')").run()
    database.prepare(`INSERT INTO requests (id, kind, organization_id, conversation_state, payload_json)
      VALUES ('conversation', 'contact', 'host', 'waiting_on_guest', '{"guest":{"name":"Guest","email":"guest@example.test","phone":null},"message":"Hello"}')`).run()
    database.prepare(`INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, channel, body, dedupe_key, sequence, occurred_at)
      VALUES ('reply', 'conversation', 'message', 'request', 'system', 'airbnb', 'Recorded reply', 'reply', 1, '2026-10-24T00:00:00.000Z')`).run()
    for (const status of ['pending', 'failed', 'uncertain', 'accepted']) {
      database.prepare(`INSERT INTO guest_thread_deliveries (id, entry_id, channel, provider, purpose, status, provider_message_id, error)
        VALUES (?, 'reply', 'airbnb', 'channex', 'member_reply', ?, ?, ?)`)
        .run(status, status, status === 'accepted' ? 'actual-provider-id' : null, status === 'failed' ? 'A historical failure does not establish refusal' : null)
    }
    const receipts = database.prepare('SELECT * FROM guest_thread_deliveries ORDER BY id').all()
    const entries = database.prepare('SELECT * FROM activity_entries').all()

    database.exec(readFileSync(`migrations-history/v20/${journal.entries[migration]!.tag}.sql`, 'utf8'))

    assert.deepEqual(database.prepare('SELECT * FROM guest_thread_deliveries ORDER BY id').all(), receipts.map(receipt => ({ ...receipt as Record<string, unknown>, non_delivery_confirmed: null })))
    assert.deepEqual(database.prepare('SELECT * FROM activity_entries').all(), entries)
    const proof = (database.pragma('table_info(guest_thread_deliveries)') as Array<{ name: string; notnull: number; dflt_value: unknown }>).find(column => column.name === 'non_delivery_confirmed')
    assert.deepEqual([proof?.notnull, proof?.dflt_value], [0, null])
    database.prepare(`INSERT INTO guest_thread_deliveries (id, entry_id, channel, provider, purpose, status, error)
      VALUES ('old-writer', 'reply', 'airbnb', 'channex', 'member_reply', 'failed', 'Channex refused the reply')`).run()
    assert.deepEqual(database.prepare("SELECT status, non_delivery_confirmed FROM guest_thread_deliveries WHERE id = 'old-writer'").get(), { status: 'failed', non_delivery_confirmed: null })
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally { database.close() }
})

test('the profile Hours migration preserves every authored member field and admits only unknown or complete Hours', () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  try {
    const journal = JSON.parse(readFileSync('migrations-history/v20/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string }> }
    const migration = journal.entries.findIndex(entry => entry.tag === '0003_member_profile_hours')
    assert.notEqual(migration, -1)
    for (const entry of journal.entries.slice(0, migration)) database.exec(readFileSync(`migrations-history/v20/${entry.tag}.sql`, 'utf8'))
    for (const id of ['practice', 'other']) database.prepare('INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES (?, ?, ?, ?, ?)').run(id, id, id, 'USD', 'America/New_York')
    for (const id of ['attorney', 'closed', 'profile']) {
      database.prepare('INSERT INTO user (id, name, email) VALUES (?, ?, ?)').run(id, id, `${id}@proof.example`)
      database.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES (?, 'practice', ?, 'member')").run(`member-${id}`, id)
    }
    database.prepare("INSERT INTO account (id, accountId, providerId, userId, scope) VALUES ('linked-calendar', 'google-subject', 'google', 'attorney', 'calendar.events.freebusy')").run()
    database.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, windows_json, windows_until,
      public_name, public_photo_url, public_bio, public_approved, calendar_account_id, calendar_ids_json, calendar_revision,
      busy_json, busy_from, busy_until, busy_checked_at, busy_error, updated_at, updated_by)
      VALUES ('member-attorney', 'practice', 'America/New_York', ?, ?, ?, '2028-01-01T00:00:00.000Z',
        'Attorney Rivera', 'https://example.test/attorney.jpg', 'Authored attorney biography', 1, 'linked-calendar', ?, 'calendar-revision',
        ?, '2027-01-01T00:00:00.000Z', '2027-04-01T00:00:00.000Z', '2027-01-01T12:00:00.000Z', 'Visible calendar failure', '2027-01-01T12:01:00.001Z', 'attorney')`)
      .run('[ { "weekday": 1, "start": "09:00", "end": "17:00" } ]',
        '[{"start":"2027-02-01T14:00:00.000Z","end":"2027-02-01T15:00:00.000Z"}]',
        '[{"start":"2027-02-01T14:00:00.000Z","end":"2027-02-01T22:00:00.000Z"}]',
        '["primary","shared@example.test"]', '[{"start":"2027-02-01T18:00:00.000Z","end":"2027-02-01T19:00:00.000Z"}]')
    database.prepare(`INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, windows_json, windows_until,
      public_name, public_photo_url, public_bio, public_approved, calendar_account_id, calendar_ids_json, calendar_revision, busy_json, updated_at, updated_by)
      VALUES ('member-closed', 'practice', 'UTC', '[]', '[]', '[]', '2028-01-01T00:00:00.000Z', NULL, NULL, '', 0, NULL, '[]', 'disconnected-revision', '[]', '2027-01-01T12:00:00.000Z', 'closed')`).run()
    const schedules = database.prepare('SELECT * FROM member_scheduling ORDER BY member_id').all()
    const members = database.prepare('SELECT * FROM member ORDER BY id').all()
    const accounts = database.prepare('SELECT * FROM account ORDER BY id').all()

    database.exec(readFileSync(`migrations-history/v20/${journal.entries[migration]!.tag}.sql`, 'utf8'))

    assert.deepEqual(database.prepare('SELECT * FROM member_scheduling ORDER BY member_id').all(), schedules, 'the leaf rebuild retains profile, Hours, approval, calendar, busy and revision bytes')
    assert.deepEqual(database.prepare('SELECT * FROM member ORDER BY id').all(), members)
    assert.deepEqual(database.prepare('SELECT * FROM account ORDER BY id').all(), accounts)
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1)
    assert(database.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='member_scheduling_org_idx'").get())
    database.prepare(`INSERT INTO member_scheduling (member_id, organization_id, public_name, public_approved, calendar_revision, updated_at, updated_by)
      VALUES ('member-profile', 'practice', 'Profile without Hours', 0, 'profile-calendar-revision', '2027-01-01T13:00:00.000Z', 'profile')`).run()
    const hours = ['timezone', 'weekly_json', 'time_off_json', 'windows_json', 'windows_until']
    const unknown = database.prepare("SELECT * FROM member_scheduling WHERE member_id='member-profile'").get() as Record<string, unknown>
    assert.deepEqual(hours.map(field => unknown[field]), [null, null, null, null, null])
    assert.equal(unknown.public_approved, 0)
    assert.equal(unknown.calendar_ids_json, '[]')
    const authored = database.prepare("SELECT * FROM member_scheduling WHERE member_id='member-attorney'").get() as Record<string, string>
    const updateHours = database.prepare(`UPDATE member_scheduling SET ${hours.map(field => `${field}=?`).join(',')} WHERE member_id='member-profile'`)
    for (let mask = 1; mask < 31; mask++) {
      assert.throws(() => updateHours.run(...hours.map((field, bit) => mask & (1 << bit) ? authored[field] : null)), /member_scheduling_hours_check/, `partial Hours mask ${mask} must fail rather than pass SQL NULL`)
    }
    assert.deepEqual(database.prepare("SELECT * FROM member_scheduling WHERE member_id='member-profile'").get(), unknown)
    updateHours.run(...hours.map(field => authored[field]))
    assert.deepEqual(database.prepare("SELECT * FROM member_scheduling WHERE member_id='member-profile'").get(), { ...unknown, ...Object.fromEntries(hours.map(field => [field, authored[field]])) })
    assert.throws(() => database.prepare("UPDATE member_scheduling SET organization_id='other' WHERE member_id='member-profile'").run(), /FOREIGN KEY constraint failed/)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
    database.prepare("DELETE FROM member WHERE id='member-profile'").run()
    assert.equal(database.prepare("SELECT * FROM member_scheduling WHERE member_id='member-profile'").get(), undefined)
    assert.deepEqual(database.prepare('SELECT * FROM member_scheduling ORDER BY member_id').all(), schedules)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally { database.close() }
})

test('room migrations preserve authored facts and photo memberships without deriving room facts from listing totals or amenities', () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  try {
    const journal = JSON.parse(readFileSync('migrations-history/v19/meta/_journal.json', 'utf8')) as { entries: Array<{ idx: number; tag: string }> }
    const roomMigration = journal.entries.findIndex(entry => entry.tag === '0014_stay_photo_rooms')
    assert.notEqual(roomMigration, -1)
    for (const entry of journal.entries.slice(0, roomMigration + 1)) database.exec(readFileSync(`migrations-history/v19/${entry.tag}.sql`, 'utf8'))
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

    database.exec(readFileSync('migrations-history/v19/0015_stay_room_details.sql', 'utf8'))

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

    database.exec(readFileSync('migrations-history/v19/0016_stay_room_amenities.sql', 'utf8'))

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
    database.exec(readFileSync('migrations-history/v19/0017_stay_room_accessibility.sql', 'utf8'))

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
    database.prepare("UPDATE product_stay_configs SET amenities = '[\"tv\",\"wireless_internet\",\"smoke_detector\"]' WHERE product_id = 'authored-home'").run()
    database.prepare("INSERT INTO product_stay_photo_room_amenities (organization_id, product_id, room_id, amenity_code) VALUES ('org', 'authored-home', 'bedroom', 'smoke_detector')").run()
    const priorRoomAmenities = database.prepare('SELECT * FROM product_stay_photo_room_amenities ORDER BY amenity_code').all()
    const amenityMigration = readFileSync('migrations-history/v19/0018_stay_amenity_answers.sql', 'utf8')
    // A bad later home must abort the whole conversion, including the valid
    // earlier home, without removing unknown facts or altering authored rooms.
    for (const invalid of [[1], [null], ['invented_amenity'], ['tv', 'tv'], ['tv', {}]]) {
      database.prepare("UPDATE product_stay_configs SET amenities = ? WHERE product_id = 'counts-only-home'").run(JSON.stringify(invalid))
      const beforeRefusedMigration = database.prepare('SELECT * FROM product_stay_configs ORDER BY product_id').all()
      assert.throws(() => database.exec(amenityMigration), /NOT NULL constraint failed: product_stay_configs.amenities/)
      assert.deepEqual(database.prepare('SELECT * FROM product_stay_configs ORDER BY product_id').all(), beforeRefusedMigration)
      assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_room_amenities ORDER BY amenity_code').all(), priorRoomAmenities)
      assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_rooms ORDER BY sort_order').all(), authoredRooms)
    }
    database.prepare("UPDATE product_stay_configs SET amenities = '[]' WHERE product_id = 'counts-only-home'").run()
    database.exec(amenityMigration)
    assert.deepEqual(JSON.parse(database.prepare("SELECT amenities FROM product_stay_configs WHERE product_id = 'authored-home'").get()!.amenities as string), [
      { code: 'tv', available: true }, { code: 'wireless_internet', available: true }, { code: 'smoke_detector', available: true },
    ])
    assert.equal(database.prepare("SELECT amenities FROM product_stay_configs WHERE product_id = 'counts-only-home'").get()!.amenities, '[]')
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_room_amenities ORDER BY amenity_code').all(), priorRoomAmenities)
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_rooms ORDER BY sort_order').all(), authoredRooms)
    assert.deepEqual(database.prepare('SELECT * FROM product_stay_photo_room_memberships').all(), memberships)
    assert.deepEqual(database.prepare('SELECT * FROM media_placements').all(), placements)
    database.prepare("INSERT INTO product_stay_photo_room_amenities (organization_id, product_id, room_id, amenity_code) VALUES ('org', 'authored-home', 'bedroom', 'mountain_view')").run()
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})

test('interleaved branch migration ledgers preserve location privacy and authored rooms while completing missing legal-site data migrations and refusing unknown files or schema', async () => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-interleaved-transfer-'))
  const journal = JSON.parse(readFileSync('migrations-history/v19/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string }> }
  const commonEnd = journal.entries.findIndex(entry => entry.tag === '0012_metronome_removed')
  assert.notEqual(commonEnd, -1)
  const common = journal.entries.slice(0, commonEnd + 1).map(entry => `${entry.tag}.sql`)
  const legalMigrations = ['0013_tenant_theme_id.sql', '0014_heading_level_column.sql']
  const lodgingMigrations = ['0013_location_stay_map_sharing.sql', '0014_stay_photo_rooms.sql', '0015_stay_room_details.sql', '0016_stay_room_amenities.sql', '0017_stay_room_accessibility.sql']
  try {
    for (const history of ['staging-first', 'lodging-first', 'staging-pending', 'v19-complete', 'v19-check-in-pending', 'v19-draft-pending'] as const) {
      const sourcePath = join(directory, `${history}.sqlite`)
      const source = new Database(sourcePath)
      source.pragma('foreign_keys = ON')
      source.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)')
      const recordMigration = source.prepare('INSERT INTO d1_migrations (name) VALUES (?)')
      for (const file of common) {
        source.exec(readFileSync(`migrations-history/v19/${file}`, 'utf8'))
        recordMigration.run(file)
      }
      source.prepare("INSERT INTO organization (id, name, slug, vertical, theme_id, default_currency, timezone) VALUES ('legal', 'Recorded Legal Practice', 'legal', 'service', 'blawby-theme-v1', 'USD', 'America/New_York'), ('host', 'Recorded Cabin', 'host', 'lodging', 'saya-theme-v1', 'THB', 'Asia/Bangkok')").run()
      source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('legal-en', 'legal', 'en', 1, 'published'), ('host-en', 'host', 'en', 1, 'published')").run()
      source.prepare("INSERT INTO content_documents (id, organization_id, kind, row_role, locale, title, path) VALUES ('legal-page', 'legal', 'page', 'root', 'en', 'Legal help', '/legal-help')").run()
      source.prepare("INSERT INTO content_blocks (id, document_id, type, data_json) VALUES ('legal-heading', 'legal-page', 'heading', '{\"text\":\"Recorded legal heading\",\"level\":3}')").run()
      const branchFiles = history === 'staging-first' || history.startsWith('v19-') ? [...legalMigrations, ...lodgingMigrations]
        : history === 'lodging-first' ? [...lodgingMigrations, ...legalMigrations] : lodgingMigrations
      for (const file of branchFiles) {
        source.exec(readFileSync(`migrations-history/v19/${file}`, 'utf8'))
        recordMigration.run(file)
      }
      source.prepare("INSERT INTO business_locations (id, organization_id, slug, title, timezone, stay_map_sharing) VALUES ('cabin', 'host', 'cabin', 'Recorded Cabin', 'Asia/Bangkok', 'specific')").run()
      source.prepare("INSERT INTO products (id, organization_id, kind, name, slug, unit_label, created_by, updated_by) VALUES ('home', 'host', 'stay', 'Recorded Cabin', 'recorded-cabin', 'night', 'owner', 'owner')").run()
      source.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('night', 'host', 'home', 'Night', 'owner', 'owner')").run()
      source.prepare("INSERT INTO product_publications (organization_id, product_id, created_by, updated_by) VALUES ('host', 'home', 'owner', 'owner')").run()
      source.prepare("INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by) VALUES ('host', 'home', 'cabin', 'owner', 'owner')").run()
      source.prepare("INSERT INTO product_stay_configs (organization_id, product_id, location_id, check_in_time, check_out_time, max_guests, beds, amenities, created_by, updated_by) VALUES ('host', 'home', 'cabin', '15:00', '11:00', 4, 2, '[\"smoke_detector\"]', 'owner', 'owner')").run()
      source.prepare("INSERT INTO media_assets (id, organization_id, kind, provider, source, public_url, status) VALUES ('photo', 'host', 'image', 'cloudflare_images', 'uploaded', 'https://imagedelivery.net/h/room/public', 'active')").run()
      source.prepare("INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id) VALUES ('cover', 'host', 'product', 'home', 'image', 'photo')").run()
      source.prepare("INSERT INTO product_stay_photo_rooms (id, organization_id, product_id, type, sort_order, created_by, details_version, sleeping_arrangements, private_attached_bathroom) VALUES ('bedroom', 'host', 'home', 'bedroom', 2, 'owner', 4, '[{\"type\":\"queen\",\"count\":1}]', 0)").run()
      source.prepare("INSERT INTO product_stay_photo_room_memberships (organization_id, product_id, asset_id, room_id) VALUES ('host', 'home', 'photo', 'bedroom')").run()
      source.prepare("INSERT INTO product_stay_photo_room_amenities (organization_id, product_id, room_id, amenity_code) VALUES ('host', 'home', 'bedroom', 'smoke_detector')").run()
      source.prepare("INSERT INTO product_stay_room_accessibility (organization_id, product_id, room_id, feature_code, available) VALUES ('host', 'home', 'bedroom', 'step_free_access', 1)").run()
      source.prepare("INSERT INTO product_stay_room_accessibility_photos (organization_id, product_id, room_id, feature_code, asset_id) VALUES ('host', 'home', 'bedroom', 'step_free_access', 'photo')").run()
      if (history.startsWith('v19-')) {
        for (const entry of journal.entries) {
          const file = `${entry.tag}.sql`
          if (common.includes(file) || branchFiles.includes(file)
            || history === 'v19-check-in-pending' && file === '0023_stay_check_in_end_time.sql'
            || history === 'v19-draft-pending' && ['0024_airbnb_import_draft.sql', '0025_airbnb_sync_jobs.sql'].includes(file)) continue
          source.exec(readFileSync(`migrations-history/v19/${file}`, 'utf8'))
          recordMigration.run(file)
        }
        if (history === 'v19-complete') source.prepare("UPDATE product_stay_configs SET check_in_end_time = '19:00' WHERE product_id = 'home'").run()
        source.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('attorney', 'Attorney', 'attorney@example.test', 1, 1, 1)").run()
        source.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('attorney-member', 'legal', 'attorney', 'owner', 1)").run()
        source.prepare("INSERT INTO member_scheduling (member_id, organization_id, timezone, weekly_json, time_off_json, windows_json, windows_until, calendar_revision, updated_at, updated_by) VALUES ('attorney-member', 'legal', 'America/New_York', '[]', '[]', '[]', '2099-01-01T00:00:00.000Z', 'authored', '2026-10-01T00:00:00.000Z', 'attorney')").run()
        source.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('consultation', 'legal', 'service', 'Family law consultation', 'family-law-consultation', 'attorney', 'attorney')").run()
        source.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('consultation-default', 'legal', 'consultation', 'Family law consultation', 'attorney', 'attorney')").run()
        source.prepare("INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, held_online, scheduling_mode, assigned_member_id, created_by, updated_by) VALUES ('consultation', 'legal', 30, 1, 1, 'provider', 'attorney-member', 'attorney', 'attorney')").run()
        source.prepare("INSERT INTO product_sessions (id, organization_id, product_id, assigned_member_id, source_occurrence_key, timezone, starts_at, ends_at, capacity, status, created_at, updated_at, created_by, updated_by) VALUES ('recorded-consultation', 'legal', 'consultation', 'attorney-member', 'hours:attorney-member:2026-10-01T14:00:00.000Z', 'America/New_York', '2026-10-01T14:00:00.000Z', '2026-10-01T14:30:00.000Z', 1, 'scheduled', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'attorney', 'attorney')").run()
        source.prepare("INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size, status) VALUES ('recorded-booking', 'legal', 'consultation', 'recorded-consultation', 'consultation-default', 1, 'cancelled')").run()
      }
      if (history === 'v19-draft-pending') {
        source.prepare("INSERT INTO products (id, organization_id, kind, name, slug, unit_label, created_by, updated_by) VALUES ('later-home', 'host', 'stay', 'Recorded Later Cabin', 'recorded-later-cabin', 'night', 'owner', 'owner')").run()
        source.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('later-night', 'host', 'later-home', 'Night', 'owner', 'owner')").run()
        source.prepare("INSERT INTO product_publications (organization_id, product_id, created_by, updated_by) VALUES ('host', 'later-home', 'owner', 'owner')").run()
        source.prepare("INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by) VALUES ('host', 'later-home', 'cabin', 'owner', 'owner')").run()
        source.prepare("INSERT INTO product_stay_configs (organization_id, product_id, location_id, check_in_time, check_out_time, max_guests, beds, amenities, created_by, updated_by) VALUES ('host', 'later-home', 'cabin', '15:00', '11:00', 2, 1, '[]', 'owner', 'owner')").run()
        source.prepare("INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled) VALUES ('host', 'home', 'channex', 'listing', 'channel', 'property', 'room', 'rate', 'complete', 1)").run()
        source.prepare("INSERT INTO channel_night_pushes (organization_id, product_id, provider, date, state, detail, updated_at) VALUES ('host', 'home', 'channex', '2026-10-23', 'needs_review', 'Recorded restriction requires review', '2026-10-23T00:00:00.000Z')").run()
        source.prepare(`INSERT INTO requests (id, kind, organization_id, location_id, conversation_state, payload_json)
          VALUES ('guest-thread', 'stay', 'host', 'cabin', 'needs_attention', '{"guest":{"name":"Recorded guest","email":"guest@example.test","phone":null}}')`).run()
        source.prepare("INSERT INTO channel_threads (provider, external_thread_id, organization_id, product_id, request_id, external_booking_id, provider_updated_at) VALUES ('channex', 'recorded-thread', 'host', 'home', 'guest-thread', 'recorded-external-booking', '2026-10-23T00:00:00.000Z')").run()
      }
      const recorded = (source.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as Array<{ name: string }>).map(row => row.name)
      const unchangedTables = history.startsWith('v19-') ? ['products', 'product_variants', 'product_publications', 'product_locations', 'product_stay_configs', 'user', 'member', 'member_scheduling', 'product_booking_configs', 'product_sessions', 'bookings'] : []
      const unchanged = unchangedTables.map(table => {
        const columns = (source.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
        return { table, columns, rows: source.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() }
      })
      const preservedTables = ['product_stay_photo_rooms', 'product_stay_photo_room_memberships', 'product_stay_photo_room_amenities', 'product_stay_room_accessibility', 'product_stay_room_accessibility_photos', 'media_placements', 'product_channel_mappings', 'channel_night_pushes', 'channel_threads']
      const authored = preservedTables.map(table => ({
        table,
        columns: (source.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name),
        rows: source.prepare(`SELECT * FROM ${table}`).all(),
      }))
      source.close()

      const targetPath = join(directory, `${history}-transferred.sqlite`)
      const payloadPath = join(directory, `${history}-payload.sql`)
      const manifest = await transferDatabaseExport(sourcePath, targetPath, history === 'v19-draft-pending' ? { payloadPath } : {})
      assert.deepEqual(manifest.source_migrations, recorded)
      assert.deepEqual(manifest.invariants.filter(invariant => invariant.violations > 0), [])
      const target = new Database(targetPath, { readonly: true })
      try {
        for (const { table, columns, rows } of authored) assert.deepEqual(target.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all(), rows)
        for (const { table, columns, rows } of unchanged) assert.deepEqual(target.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all(), rows)
        assert.equal(target.prepare("SELECT check_in_end_time FROM product_stay_configs WHERE product_id = 'home'").get()!.check_in_end_time, history === 'v19-complete' ? '19:00' : null)
        assert.deepEqual(manifest.provider_hours_session_ids, [])
        assert.deepEqual(target.prepare("SELECT organization_id, product_id, beds, amenities FROM product_stay_configs WHERE product_id = 'home'").get(), { organization_id: 'host', product_id: 'home', beds: 2, amenities: '[{"code":"smoke_detector","available":true}]' })
        assert.deepEqual(target.prepare("SELECT organization_id, stay_map_sharing FROM business_locations WHERE id = 'cabin'").get(), { organization_id: 'host', stay_map_sharing: 'specific' })
        assert.deepEqual(target.prepare("SELECT theme_id, json_extract(settings_json, '$.config.font_preset') AS font, json_extract(settings_json, '$.config.button_casing') AS casing FROM organization WHERE id = 'legal'").get(), { theme_id: 'tenant-theme-v1', font: 'marcellus', casing: 'uppercase' })
        assert.deepEqual(target.prepare("SELECT level, data_json FROM content_blocks WHERE id = 'legal-heading'").get(), { level: 3, data_json: '{"text":"Recorded legal heading"}' })
        assert.deepEqual(target.prepare('SELECT * FROM product_stay_accessibility').all(), [])
        assert.deepEqual(target.pragma('foreign_key_check'), [])
      } finally { target.close() }
      if (history === 'v19-draft-pending') {
        // A v19 source reaches the current chain through the archived forward migrations.
        const currentJournal = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string }> }
        assert.deepEqual(manifest.target_migrations, currentJournal.entries.map(entry => `${entry.tag}.sql`))
      }
    }
    for (const invalid of ['unknown-migration', 'room-schema-mismatch', 'location-schema-mismatch', 'unsupported-offering'] as const) {
      const sourcePath = join(directory, `${invalid}.sqlite`)
      copyFileSync(join(directory, 'staging-pending.sqlite'), sourcePath)
      const source = new Database(sourcePath)
      if (invalid === 'unknown-migration') source.prepare("INSERT INTO d1_migrations (name) VALUES ('9999_unrecorded_migration.sql')").run()
      else if (invalid === 'unsupported-offering') source.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('physical', 'host', 'item', 'Authored physical offering', 'physical', 'owner', 'owner')").run()
      else source.exec(`ALTER TABLE ${invalid === 'room-schema-mismatch' ? 'product_stay_photo_rooms' : 'business_locations'} ADD COLUMN unrecorded_fact TEXT`)
      source.close()
      const targetPath = join(directory, `${invalid}-refused.sqlite`)
      await assert.rejects(() => transferDatabaseExport(sourcePath, targetPath), invalid === 'unsupported-offering' ? /Unsupported offerings: host\/physical \(item\); no rows were copied/ : /Source schema differs from every recorded migration chain; no rows were copied/)
      const target = new Database(targetPath, { readonly: true })
      try { assert.deepEqual(target.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(), []) }
      finally { target.close() }
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
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

    const unclassifiedPath = export7('unclassified.sqlite', {})
    const unclassified = new Database(unclassifiedPath)
    unclassified.prepare("UPDATE organization SET vertical = 'experience' WHERE id = 'org'").run()
    unclassified.prepare("INSERT INTO products (id, organization_id, name, slug, created_by, updated_by) VALUES ('unclassified', 'org', 'Authored offering', 'unclassified', 'owner', 'owner')").run()
    unclassified.close()
    const refusedPath = join(directory, 'unclassified-refused.sqlite')
    await assert.rejects(() => transferDatabaseExport(unclassifiedPath, refusedPath), /Product unclassified has no recognized offering kind; no rows were copied/)
    const refused = new Database(refusedPath, { readonly: true })
    try { assert.deepEqual(refused.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(), []) }
    finally { refused.close() }

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
  const { DEFAULT_SITE_PALETTE } = await import('../../shared/site-palette.ts')
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
      assert.deepEqual(saya.config.palette.light, { ...DEFAULT_SITE_PALETTE.light, action: '#96826A' })
      assert.equal(saya.config.palette.dark.ground, DEFAULT_SITE_PALETTE.dark.ground)
      assert.notEqual(saya.config.palette.dark.action, '#96826A')
      // Blawby's stored tokens were its defaults. Once one look serves every site
      // (migration 0012), the legal site keeps those defaults as its own settings.
      const blawby = settings('blawby')
      assert.equal(blawby.theme_by_template, undefined)
      assert.deepEqual(blawby.config.palette.light, { ground: '#FBFAF7', surface: '#FFFFFF', text: '#162033', muted: '#565D6A', action: '#25356C', accent: '#C19855' })
      assert.equal(blawby.config.font_preset, 'marcellus')
      assert.equal(blawby.config.button_color, 'accent')
      assert.equal((target.prepare("SELECT theme_id FROM organization WHERE id = 'blawby'").get() as { theme_id: string }).theme_id, 'tenant-theme-v1')
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
      assert.deepEqual(['requests', 'activity_entries', 'guest_thread_deliveries'].map(table => target.prepare(`SELECT * FROM ${table}`).all()),
        [before[0]!.map(request => ({ ...request as Record<string, unknown>, blocked_at: null })), before[1], before[2]!.map(receipt => ({ ...receipt as Record<string, unknown>, non_delivery_confirmed: null, email_json: null, email_message_id: null }))])
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

test('a v20 export transfers into the current baseline unchanged, which admits Booking.com stays, and a final delta carries later stays', async () => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-v20-transfer-'))
  const v20 = JSON.parse(readFileSync('migrations-history/v20/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
  // The source has not yet applied v20's last forward migration; the transfer completes it.
  const applied = v20.slice(0, -1)
  const stayRow = (id: string, channel: string, checkIn: string, checkOut: string) => source => source.prepare(`INSERT INTO stays (id, organization_id, product_id, channel, owner, status, check_in_date, check_out_date, adults, total_minor, currency, provider, external_booking_id, created_at, updated_at)
    VALUES (?, 'host', 'home', ?, 'channel', 'confirmed', ?, ?, 2, 30000, 'USD', 'channex', ?, '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`).run(id, channel, checkIn, checkOut, `booking-${id}`)
  try {
    const sourcePath = join(directory, 'v20.sqlite')
    const source = new Database(sourcePath)
    source.pragma('foreign_keys = ON')
    for (const file of applied) source.exec(readFileSync(`migrations-history/v20/${file}`, 'utf8'))
    source.exec(`CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
      ${applied.map(file => `INSERT INTO d1_migrations (name) VALUES ('${file}');`).join('\n')}`)
    source.prepare("INSERT INTO organization (id, name, slug, subdomain, vertical, default_currency, timezone) VALUES ('host', 'Host', 'host', 'host', 'lodging', 'USD', 'America/Denver')").run()
    source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('host-en', 'host', 'en', 1, 'published')").run()
    source.prepare("INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('cabin', 'host', 'cabin', 'Cabin', 'America/Denver')").run()
    source.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('home', 'host', 'stay', 'Cabin', 'cabin', 'owner', 'owner')").run()
    source.prepare("INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by) VALUES ('host', 'home', 'cabin', 'owner', 'owner')").run()
    source.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('home-default', 'host', 'home', 'Cabin', 'owner', 'owner')").run()
    source.prepare("INSERT INTO product_stay_configs (organization_id, product_id, location_id, check_in_time, check_out_time, max_guests, created_by, updated_by) VALUES ('host', 'home', 'cabin', '16:00', '10:00', 4, 'owner', 'owner')").run()
    source.prepare("INSERT INTO product_channel_mappings (organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled) VALUES ('host', 'home', 'channex', 'listing', 'channel', 'property', 'room', 'rate', 'complete', 1)").run()
    stayRow('airbnb-stay', 'airbnb', '2026-11-01', '2026-11-03')(source)
    source.prepare("INSERT INTO stay_nights (organization_id, product_id, date, stay_id) VALUES ('host', 'home', '2026-11-01', 'airbnb-stay'), ('host', 'home', '2026-11-02', 'airbnb-stay')").run()
    source.prepare("INSERT INTO channel_night_pushes (organization_id, product_id, provider, date, state, detail, updated_at) VALUES ('host', 'home', 'channex', '2026-11-01', 'needs_review', 'Recorded refusal', '2026-10-20T00:00:00.000Z')").run()
    const recorded = Object.fromEntries(['stays', 'stay_nights'].map(table => [table, source.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()]))
    source.close()

    const targetPath = join(directory, 'current.sqlite')
    const manifest = await transferDatabaseExport(sourcePath, targetPath, { payloadPath: join(directory, 'payload.sql') })
    // The target takes the current whole chain: its baseline and every forward migration since.
    const current = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
    assert.equal(current[0], '0000_baseline.sql')
    assert.deepEqual(manifest.target_migrations, current)
    const target = new Database(targetPath)
    try {
      target.pragma('foreign_keys = ON')
      assert.deepEqual(target.pragma('foreign_key_check'), [])
      // Columns a later forward migration added (stays.no_show_at) are new; every recorded value is unchanged.
      for (const [table, rows] of Object.entries(recorded)) {
        const columns = Object.keys(rows[0] as Record<string, unknown>).map(column => `"${column}"`).join(', ')
        assert.deepEqual(target.prepare(`SELECT ${columns} FROM ${table} ORDER BY 1, 2`).all(), rows, `${table} is unchanged`)
      }
      // v20's pending outbox migration ran: the refusal keeps its reason and has never been confirmed.
      assert.deepEqual(target.prepare('SELECT date, state, detail, sent_json, attempts, retry_at FROM channel_night_pushes').all(),
        [{ date: '2026-11-01', state: 'needs_review', detail: 'Recorded refusal', sent_json: null, attempts: 0, retry_at: null }])
      stayRow('booking-com-stay', 'booking_com', '2026-12-01', '2026-12-03')(target)
      assert.throws(() => stayRow('expedia-stay', 'expedia', '2026-12-05', '2026-12-06')(target), /stays_channel_check/)
    } finally { target.close() }

    // The final delta brings what the source took after the initial transfer, and nothing it already held.
    const initialPath = join(directory, 'current-initial.sqlite')
    copyFileSync(targetPath, initialPath)
    writeFileSync(`${initialPath}.manifest.json`, JSON.stringify({ baseline_sha256: manifest.baseline_sha256, target_migrations: manifest.target_migrations }))
    const initial = new Database(initialPath)
    initial.prepare("DELETE FROM stays WHERE id = 'booking-com-stay'").run()
    initial.close()
    const later = new Database(sourcePath)
    stayRow('later-stay', 'vrbo', '2026-11-10', '2026-11-12')(later)
    later.close()
    const delta = await transferDatabaseExport(sourcePath, join(directory, 'current-final.sqlite'), { payloadPath: join(directory, 'delta.sql'), deltaFrom: initialPath })
    assert.deepEqual(Object.fromEntries(Object.entries(delta.payload!.delta!).filter(([, rows]) => rows)), { stays: 1 })
    assert.deepEqual(delta.payload!.left_behind, {})
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a v21 replacement preserves booked descendants and auth, completes manual group metadata, and carries later conversation and booking rows without overwriting replacement edits', async () => {
  const { transferDatabaseExport } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'krabiclaw-v21-transfer-'))
  const v21 = JSON.parse(readFileSync('migrations-history/v21/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
  const current = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')).entries.map((entry: { tag: string }) => `${entry.tag}.sql`) as string[]
  const groupMigration = v21.indexOf('0008_team_group_management.sql')
  assert.notEqual(groupMigration, -1)
  const applied = v21.slice(0, groupMigration)
  const sourcePath = join(directory, 'v21.sqlite')
  const unchangedTables = ['account', 'session', 'jwks', 'member', 'product_booking_configs', 'product_availability_rules', 'product_sessions', 'bookings', 'team_thread_members', 'team_messages']
  const recorded: Record<string, unknown[]> = {}
  try {
    const source = new Database(sourcePath)
    try {
      source.pragma('foreign_keys = ON')
      for (const file of applied) source.exec(readFileSync(`migrations-history/v21/${file}`, 'utf8'))
      source.exec(`CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
        ${applied.map(file => `INSERT INTO d1_migrations (name) VALUES ('${file}');`).join('\n')}`)
      source.prepare("INSERT INTO organization (id, name, slug, subdomain, vertical, default_currency, timezone) VALUES ('practice', 'Recorded Legal Practice', 'practice', 'practice', 'service', 'USD', 'America/New_York')").run()
      source.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('practice-en', 'practice', 'en', 1, 'published')").run()
      for (const [id, name, role] of [['attorney', 'Attorney Rivera', 'owner'], ['colleague', 'Bea Chen', 'member'], ['assistant', 'Lee Patel', 'member']]) {
        source.prepare('INSERT INTO user (id, name, email, emailVerified) VALUES (?, ?, ?, 1)').run(id, name, `${id}@proof.example`)
        source.prepare("INSERT INTO member (id, organizationId, userId, role) VALUES (?, 'practice', ?, ?)").run(`member-${id}`, id, role)
      }
      source.prepare("INSERT INTO account (id, accountId, providerId, userId, password) VALUES ('credential', 'attorney', 'credential', 'attorney', 'recorded-fixture-hash')").run()
      source.prepare("INSERT INTO session (id, expiresAt, token, activeOrganizationId, userId) VALUES ('retained-session', 9999999999, 'recorded-fixture-session', 'practice', 'attorney')").run()
      source.prepare("INSERT INTO jwks (id, publicKey, privateKey, createdAt) VALUES ('retained-key', 'recorded-fixture-public-key', 'recorded-fixture-private-key', 1)").run()
      source.prepare("INSERT INTO business_locations (id, organization_id, slug, title, timezone) VALUES ('office', 'practice', 'office', 'Recorded office', 'America/New_York')").run()
      source.prepare("INSERT INTO products (id, organization_id, kind, name, slug, created_by, updated_by) VALUES ('consultation', 'practice', 'service', 'Initial Legal Consultation', 'initial-legal-consultation', 'attorney', 'attorney')").run()
      source.prepare("INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('consultation-default', 'practice', 'consultation', 'Initial Legal Consultation', 'attorney', 'attorney')").run()
      source.prepare("INSERT INTO product_booking_configs (product_id, organization_id, duration_minutes, default_capacity, held_online, scheduling_mode, assigned_member_id, created_by, updated_by) VALUES ('consultation', 'practice', 30, 1, 1, 'provider', 'member-attorney', 'attorney', 'attorney')").run()
      source.prepare("INSERT INTO product_availability_rules (id, organization_id, product_id, location_id, timezone, weekday, start_time, created_by, updated_by) VALUES ('recorded-office-rule', 'practice', 'consultation', 'office', 'America/New_York', 1, '09:00', 'attorney', 'attorney')").run()
      source.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, assigned_member_id, source_occurrence_key, timezone, starts_at, ends_at, capacity, created_at, updated_at, created_by, updated_by)
        VALUES ('recorded-appointment', 'practice', 'consultation', 'member-attorney', 'hours:member-attorney:2027-01-04T14:00:00.000Z', 'America/New_York', '2027-01-04T14:00:00.000Z', '2027-01-04T14:30:00.000Z', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'attorney', 'attorney')`).run()
      source.prepare("INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, assigned_member_id, party_size, status) VALUES ('recorded-booking', 'practice', 'consultation', 'recorded-appointment', 'consultation-default', 'member-attorney', 1, 'confirmed')").run()
      for (const [id, location] of [['manual', null], ['location', 'office']]) {
        source.prepare(`INSERT INTO team_threads (id, organization_id, location_id, created_by_user_id, participants_key, last_message_at, created_at)
          VALUES (?, 'practice', ?, 'attorney', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run(id, location, `recorded-${id}`)
        for (const member of ['attorney', 'colleague', 'assistant']) source.prepare("INSERT INTO team_thread_members (thread_id, organization_id, member_id, last_read_at) VALUES (?, 'practice', ?, '2026-10-01T00:00:00.000Z')").run(id, `member-${member}`)
        source.prepare(`INSERT INTO team_messages (id, organization_id, thread_id, sender_user_id, body, idempotency_key, request_hash, created_at)
          VALUES (?, 'practice', ?, 'attorney', 'Recorded conversation', ?, 'recorded-hash', '2026-10-01T00:00:00.000Z')`).run(`message-${id}`, id, `message-${id}`)
      }
      for (const table of unchangedTables) recorded[table] = source.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
      assert.throws(() => source.prepare("UPDATE product_booking_configs SET assigned_member_id = NULL WHERE product_id = 'consultation'").run(), /product_booking_configs_held_online_check/)
      assert.deepEqual(source.pragma('foreign_key_check'), [])
    } finally { source.close() }

    const initialPath = join(directory, 'v22-initial.sqlite')
    const initial = await transferDatabaseExport(sourcePath, initialPath, { payloadPath: join(directory, 'initial.sql') })
    assert.deepEqual(initial.source_migrations, applied)
    assert.deepEqual(initial.transforms, [])
    assert.deepEqual(initial.provider_hours_session_ids, [])
    assert.deepEqual(initial.target_migrations, current)
    const target = new Database(initialPath, { readonly: true })
    try {
      // A later forward migration may add a column (bookings.no_show_at); every value the v21 row held is still the same.
      for (const table of unchangedTables) {
        const columns = Object.keys(recorded[table]![0] as Record<string, unknown>).map(column => `"${column}"`).join(', ')
        assert.deepEqual(target.prepare(`SELECT ${columns} FROM ${table} ORDER BY 1`).all(), recorded[table], `${table} preserves every recorded value`)
      }
      assert.deepEqual(target.prepare('SELECT id, name, is_group FROM team_threads ORDER BY id').all(), [
        { id: 'location', name: null, is_group: 0 }, { id: 'manual', name: null, is_group: 1 },
      ])
      assert.deepEqual(target.pragma('foreign_key_check'), [])
    } finally { target.close() }

    const livePath = join(directory, 'v22-live.sqlite')
    copyFileSync(initialPath, livePath)
    const live = new Database(livePath)
    try {
      live.pragma('foreign_keys = ON')
      live.prepare("UPDATE product_booking_configs SET assigned_member_id = NULL WHERE product_id = 'consultation'").run()
      live.prepare("UPDATE team_threads SET name = 'Authored on replacement' WHERE id = 'manual'").run()
      assert.deepEqual(live.prepare("SELECT held_online, scheduling_mode, assigned_member_id FROM product_booking_configs WHERE product_id = 'consultation'").get(), { held_online: 1, scheduling_mode: 'provider', assigned_member_id: null })
      assert.throws(() => live.prepare("UPDATE product_booking_configs SET scheduling_mode = 'legacy' WHERE product_id = 'consultation'").run(), /product_booking_configs_held_online_check/)

      const later = new Database(sourcePath)
      try {
        later.pragma('foreign_keys = ON')
        later.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, assigned_member_id, source_occurrence_key, timezone, starts_at, ends_at, capacity, created_by, updated_by)
          VALUES ('later-appointment', 'practice', 'consultation', 'member-attorney', 'hours:member-attorney:2027-01-05T14:00:00.000Z', 'America/New_York', '2027-01-05T14:00:00.000Z', '2027-01-05T14:30:00.000Z', 1, 'attorney', 'attorney')`).run()
        later.prepare("INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, assigned_member_id, party_size, status) VALUES ('later-booking', 'practice', 'consultation', 'later-appointment', 'consultation-default', 'member-attorney', 1, 'confirmed')").run()
        later.prepare(`INSERT INTO team_messages (id, organization_id, thread_id, sender_user_id, body, idempotency_key, request_hash, created_at)
          VALUES ('later-message', 'practice', 'manual', 'colleague', 'Later conversation', 'later-message', 'later-hash', '2026-10-02T00:00:00.000Z')`).run()
        later.prepare("UPDATE team_threads SET last_message_at = '2026-10-02T00:00:00.000Z' WHERE id = 'manual'").run()
      } finally { later.close() }
      const payloadPath = join(directory, 'delta.sql')
      const delta = await transferDatabaseExport(sourcePath, join(directory, 'v22-final.sqlite'), { payloadPath, deltaFrom: initialPath })
      assert.deepEqual(Object.fromEntries(Object.entries(delta.payload!.delta!).filter(([, count]) => count)), { bookings: 1, product_sessions: 1, team_messages: 1 })
      assert.deepEqual(delta.payload!.left_behind, { team_threads: { changed: ['["manual"]'], deleted: [] } })
      live.exec(readFileSync(payloadPath, 'utf8'))
      assert.deepEqual(live.prepare("SELECT held_online, scheduling_mode, assigned_member_id FROM product_booking_configs WHERE product_id = 'consultation'").get(), { held_online: 1, scheduling_mode: 'provider', assigned_member_id: null })
      assert.equal(live.prepare("SELECT name FROM team_threads WHERE id = 'manual'").get()!.name, 'Authored on replacement')
      assert.deepEqual(live.prepare('SELECT id, assigned_member_id FROM bookings ORDER BY id').all(), [
        { id: 'later-booking', assigned_member_id: 'member-attorney' }, { id: 'recorded-booking', assigned_member_id: 'member-attorney' },
      ])
      assert.deepEqual(live.prepare('SELECT id, body FROM team_messages ORDER BY id').all(), [
        { id: 'later-message', body: 'Later conversation' }, { id: 'message-location', body: 'Recorded conversation' }, { id: 'message-manual', body: 'Recorded conversation' },
      ])
      for (const table of ['account', 'session', 'jwks']) assert.deepEqual(live.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), recorded[table])
      assert.deepEqual(live.pragma('foreign_key_check'), [])
    } finally { live.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
