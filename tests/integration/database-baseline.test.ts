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
