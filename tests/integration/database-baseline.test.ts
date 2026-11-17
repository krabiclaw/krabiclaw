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

test('standalone Channex homes migration preserves calendar delivery and channel conversation rows', () => {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  try {
    const migration = '0017_standalone_channex_homes'
    const journal = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string }> }
    for (const { tag } of journal.entries.slice(0, journal.entries.findIndex(entry => entry.tag === migration))) {
      database.exec(readFileSync(`migrations/${tag}.sql`, 'utf8'))
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
    database.transaction(() => database.exec(readFileSync(`migrations/${migration}.sql`, 'utf8')))()
    assert.deepEqual(['product_channel_mappings', 'channel_night_pushes', 'channel_threads'].map(read), before)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})
