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
  } finally {
    database.close()
  }
})

test('moving free sites preserves existing links and custom primary domains', () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  try {
    const { entries } = JSON.parse(readFileSync('migrations-history/v27/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string }> }
    const migration = '0021_move_free_sites_to_blawby'
    for (const { tag } of entries.slice(0, entries.findIndex(({ tag }) => tag === migration))) {
      database.exec(readFileSync(`migrations-history/v27/${tag}.sql`, 'utf8'))
    }
    database.exec(`
      INSERT INTO organization (id, name, slug, subdomain, default_currency, timezone)
        VALUES ('free', 'Free Site', 'free', 'free', 'USD', 'UTC'),
               ('custom', 'Custom Site', 'custom', 'custom', 'USD', 'UTC');
      INSERT INTO organization_domains (id, organization_id, domain, type, role, status, dns_target)
        VALUES ('free-site', 'free', 'free.krabiclaw.com', 'subdomain', 'canonical', 'active', 'krabiclaw.com'),
               ('custom-site', 'custom', 'custom.krabiclaw.com', 'subdomain', 'secondary', 'active', 'krabiclaw.com'),
               ('www', 'custom', 'www.example.com', 'custom', 'canonical', 'active', 'customers.krabiclaw.com');
    `)
    database.transaction(() => database.exec(readFileSync(`migrations-history/v27/${migration}.sql`, 'utf8')))()
    assert.deepEqual(database.prepare(`SELECT id, domain, role, dns_target FROM organization_domains
      WHERE status = 'active' ORDER BY id`).all(), [
      { id: 'custom-site', domain: 'custom.blawby.com', role: 'secondary', dns_target: 'blawby.com' },
      { id: 'free-site', domain: 'free.blawby.com', role: 'canonical', dns_target: 'blawby.com' },
      { id: 'www', domain: 'www.example.com', role: 'canonical', dns_target: 'customers.krabiclaw.com' },
    ])
    assert.deepEqual(database.prepare(`SELECT domain, successor_domain, former_organization_id FROM organization_domains
      WHERE status = 'retired' ORDER BY domain`).all(), [
      { domain: 'custom.krabiclaw.com', successor_domain: 'custom.blawby.com', former_organization_id: 'custom' },
      { domain: 'free.krabiclaw.com', successor_domain: 'free.blawby.com', former_organization_id: 'free' },
    ])
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})

test('snapshot payload preserves destination signing keys for refreshes and carries source keys for replacements', async () => {
  const { writePayload } = await import('../../scripts/transfer-database-export.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'blawby-signing-transfer-'))
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

test('Channex home migrations preserve accounts, listings, calendar delivery and conversations', () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  try {
    const migration = '0017_standalone_channex_homes'
    const journal = JSON.parse(readFileSync('migrations-history/v27/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string }> }
    for (const { tag } of journal.entries.slice(0, journal.entries.findIndex(entry => entry.tag === migration))) {
      database.exec(readFileSync(`migrations-history/v27/${tag}.sql`, 'utf8'))
    }
    database.exec(`
      INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('tenant', 'Tenant', 'tenant', 'USD', 'America/Denver');
      INSERT INTO business_locations (id, organization_id, slug, title, timezone)
        VALUES ('cabin-site', 'tenant', 'cabin', 'Cabin', 'America/Denver');
      INSERT INTO products (id, organization_id, kind, slug, name, created_by, updated_by)
        VALUES ('cabin', 'tenant', 'stay', 'cabin', 'Cabin', 'host', 'host');
      INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by)
        VALUES ('tenant', 'cabin', 'cabin-site', 'host', 'host');
      INSERT INTO product_stay_configs (organization_id, product_id, location_id, internal_name, created_by, updated_by)
        VALUES ('tenant', 'cabin', 'cabin-site', 'Cabin', 'host', 'host');
      INSERT INTO channex_connections (organization_id, status, group_id, channel_id, connected_at)
        VALUES ('tenant', 'connected', 'group', 'channel', '2026-11-17T00:00:00.000Z');
      INSERT INTO product_channel_mappings (rowid, organization_id, product_id, provider, listing_id, channel_id, property_id, room_type_id, rate_plan_id, import_stage, enabled)
        VALUES (13, 'tenant', 'cabin', 'channex', 'listing', 'channel', 'property', 'room', 'rate', 'complete', 1);
      INSERT INTO conversations (id, kind, organization_id, payload_json, last_message_at)
        VALUES ('thread', 'contact', 'tenant', '{"guest":{"name":"Guest","email":"guest@example.test","phone":null}}', '2026-11-17T00:00:00.000Z');
      INSERT INTO channel_threads (rowid, provider, external_thread_id, organization_id, product_id, conversation_id, provider_updated_at)
        VALUES (34, 'channex', 'external-thread', 'tenant', 'cabin', 'thread', '2026-11-17T00:00:00.000Z');
      INSERT INTO channel_night_pushes (rowid, organization_id, product_id, provider, date, state, sent_json)
        VALUES (23, 'tenant', 'cabin', 'channex', '2026-11-25', 'pushed', '{"availability":0}');
    `)
    const read = (table: string) => database.prepare(`SELECT rowid, * FROM ${table}`).all()
    const before = ['product_channel_mappings', 'channel_night_pushes', 'channel_threads'].map(read)
    database.transaction(() => database.exec(readFileSync(`migrations-history/v27/${migration}.sql`, 'utf8')))()
    assert.deepEqual(['product_channel_mappings', 'channel_night_pushes', 'channel_threads'].map(read), before)
    for (const { tag } of journal.entries.slice(journal.entries.findIndex(entry => entry.tag === migration) + 1)) {
      database.transaction(() => database.exec(readFileSync(`migrations-history/v27/${tag}.sql`, 'utf8')))()
    }
    database.transaction(() => database.exec(readFileSync('migrations-history/v28/0001_airbnb_shared_homes.sql', 'utf8')))()
    assert.deepEqual(['channel_night_pushes', 'channel_threads'].map(read), before.slice(1))
    assert.deepEqual(database.prepare('SELECT organization_id, group_id FROM channex_groups').all(), [{ organization_id: 'tenant', group_id: 'group' }])
    assert.deepEqual(database.prepare('SELECT organization_id, status, channel_id FROM channex_connections').all(), [{ organization_id: 'tenant', status: 'connected', channel_id: 'channel' }])
    assert.deepEqual(database.prepare('SELECT product_id, listing_id, channel_id, enabled FROM product_airbnb_listings').all(),
      [{ product_id: 'cabin', listing_id: 'listing', channel_id: 'channel', enabled: 1 }])
    assert.deepEqual(database.prepare('SELECT product_id, property_id, room_type_id, rate_plan_id FROM product_channel_mappings').all(),
      [{ product_id: 'cabin', property_id: 'property', room_type_id: 'room', rate_plan_id: 'rate' }])
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})

test('the stay-night migration and database transfer preserve both bookings when a channel sells an occupied night', async () => {
  const { writePayload } = await import('../../scripts/transfer-database-export.mjs')
  const migration = '0020_record_every_confirmed_stay_night'
  const { entries } = JSON.parse(readFileSync('migrations-history/v27/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string }> }
  const schema = entries.map(({ tag }) => readFileSync(`migrations-history/v27/${tag}.sql`, 'utf8'))
  const database = new Database(':memory:')
  const directory = mkdtempSync(join(tmpdir(), 'blawby-stay-nights-transfer-'))
  try {
    const index = entries.findIndex(({ tag }) => tag === migration)
    database.exec(schema.slice(0, index).join('\n'))
    database.pragma('foreign_keys = ON')
    database.exec(`
      INSERT INTO organization (id, name, slug, default_currency, timezone) VALUES ('org', 'Tenant', 'tenant', 'USD', 'America/Denver');
      INSERT INTO products (id, organization_id, kind, slug, name, created_by, updated_by)
        VALUES ('cabin', 'org', 'stay', 'cabin', 'Cabin', 'host', 'host');
      INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by)
        VALUES ('variant', 'org', 'cabin', 'Cabin', 'host', 'host');
      INSERT INTO bookings (id, organization_id, product_id, product_variant_id, starts_at, ends_at, timezone, party_size, policy_json, total_minor, currency, owner, channel, provider, external_booking_id) VALUES
        ('host', 'org', 'cabin', 'variant', '2027-02-01', '2027-02-02', 'America/Denver', 1, '{}', 100, 'USD', 'app', 'direct', NULL, NULL),
        ('channel', 'org', 'cabin', 'variant', '2027-02-02', '2027-02-03', 'America/Denver', 1, '{}', 100, 'USD', 'channel', 'airbnb', 'channex', 'external'),
        ('another', 'org', 'cabin', 'variant', '2027-02-01', '2027-02-02', 'America/Denver', 1, '{}', 100, 'USD', 'app', 'direct', NULL, NULL);
      INSERT INTO stay_nights (organization_id, product_id, date, booking_id) VALUES
        ('org', 'cabin', '2027-02-01', 'host'), ('org', 'cabin', '2027-02-02', 'channel');
    `)
    database.transaction(() => database.exec(schema[index]!))()
    const hold = database.prepare("INSERT INTO stay_nights (organization_id, product_id, date, booking_id) VALUES ('org', 'cabin', '2027-02-01', ?)")
    assert.throws(() => hold.run('another'), /STAY_NIGHT_OCCUPIED/)
    database.prepare("UPDATE bookings SET starts_at = '2027-02-01', overbooked = 1 WHERE id = 'channel'").run()
    hold.run('channel')
    database.prepare("UPDATE stay_nights SET rowid = -1 WHERE booking_id = 'channel' AND date = '2027-02-01'").run()
    const snapshot = join(directory, 'snapshot.sql')
    writePayload(database, snapshot, schema.join('\n'))
    const destination = new Database(':memory:')
    try {
      destination.exec(schema.join('\n'))
      destination.exec(readFileSync(snapshot, 'utf8'))
      const occupants = destination.prepare("SELECT booking_id FROM occupied_stay_nights WHERE date = '2027-02-01' ORDER BY booking_id")
      assert.deepEqual(occupants.all(), [{ booking_id: 'channel' }, { booking_id: 'host' }])
      destination.prepare("DELETE FROM stay_nights WHERE booking_id = 'host'").run()
      assert.deepEqual(occupants.all(), [{ booking_id: 'channel' }])
      assert.throws(() => destination.prepare(hold.source).run('another'), /STAY_NIGHT_OCCUPIED/)
      assert.deepEqual(destination.pragma('foreign_key_check'), [])
    } finally {
      destination.close()
    }
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
