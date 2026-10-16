import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Miniflare } from 'miniflare'

const NOW = '2026-09-27T00:00:00.000Z'

/** One tenant's guest graph: a booked session, a reserved table, and the threads, review request, review and product page that hang off them. */
function tenantGraph(org: string): string[] {
  const location = `${org}-location`
  const product = `${org}-product`
  const variant = `${org}-variant`
  const rule = `${org}-rule`
  const session = `${org}-session`
  const bookingThread = `${org}-booking-thread`
  const reservationThread = `${org}-reservation-thread`
  const guest = `${org}-guest`
  const payload = `'{"guest":{"name":"Guest","email":"guest@example.test","phone":null}}'`
  return [
    `INSERT INTO organization (id,name,slug, default_currency, timezone) VALUES ('${org}','${org}','${org}', 'USD', 'UTC')`,
    `INSERT INTO organization_locales (id,organization_id,locale,label,is_source,status) VALUES ('${org}-en','${org}','en','English',1,'published')`,
    `INSERT INTO user (id,name,email,isAnonymous) VALUES ('${guest}','Guest','${guest}@example.test',1)`,
    `INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('${org}-member','${org}','${guest}','owner',0)`,
    `INSERT INTO business_locations (id,organization_id,slug,title,timezone) VALUES ('${location}','${org}','main','Main','Asia/Bangkok')`,
    `INSERT INTO products (kind, id,organization_id,name,slug,created_by,updated_by) VALUES ('experience', '${product}','${org}','Class','class','t','t')`,
    `INSERT INTO product_variants (id,organization_id,product_id,name,created_by,updated_by) VALUES ('${variant}','${org}','${product}','Standard','t','t')`,
    `INSERT INTO product_locations (organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES ('${org}','${product}','${location}',1,1,'t','t')`,
    `INSERT INTO product_booking_configs (product_id,organization_id,duration_minutes,default_capacity,created_by,updated_by) VALUES ('${product}','${org}',60,4,'t','t')`,
    `INSERT INTO product_availability_rules (id,organization_id,product_id,location_id,timezone,weekday,start_time,created_by,updated_by) VALUES ('${rule}','${org}','${product}','${location}','Asia/Bangkok',1,'10:00','t','t')`,
    `INSERT INTO product_sessions (id,organization_id,product_id,location_id,availability_rule_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by)
      VALUES ('${session}','${org}','${product}','${location}','${rule}','Asia/Bangkok','2099-01-05T03:00:00.000Z','2099-01-05T04:00:00.000Z',4,'scheduled','t','t')`,
    `INSERT INTO location_reservation_configs (location_id,organization_id,slot_capacity,created_by,updated_by) VALUES ('${location}','${org}',2,'t','t')`,
    `INSERT INTO requests (id,kind,organization_id,location_id,user_id,conversation_state,payload_json,created_at,updated_at) VALUES ('${bookingThread}','booking','${org}','${location}','${guest}','needs_attention',${payload},'${NOW}','${NOW}')`,
    `INSERT INTO requests (id,kind,organization_id,location_id,user_id,conversation_state,payload_json,created_at,updated_at) VALUES ('${reservationThread}','reservation','${org}','${location}','${guest}','needs_attention',${payload},'${NOW}','${NOW}')`,
    `INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,user_id,request_id,party_size,status) VALUES ('${org}-booking','${org}','${product}','${session}','${variant}','${guest}','${bookingThread}',1,'confirmed')`,
    `INSERT INTO reservations (id,organization_id,location_id,user_id,request_id,timezone,starts_at,ends_at,party_size,status) VALUES ('${org}-reservation','${org}','${location}','${guest}','${reservationThread}','Asia/Bangkok','2099-01-06T09:00:00.000Z','2099-01-06T11:00:00.000Z',2,'confirmed')`,
    `INSERT INTO review_requests (id,organization_id,location_id,user_id,booking_type,booking_id,token_hash,expires_at) VALUES ('${org}-review-request','${org}','${location}','${guest}','booking','${bookingThread}','${org}-token','2099-02-01T00:00:00.000Z')`,
    `INSERT INTO reviews (id,organization_id,location_id,user_id,review_request_id,booking_id,booking_type,product_id,rating,status) VALUES ('${org}-review','${org}','${location}','${guest}','${org}-review-request','${bookingThread}','booking','${product}',5,'published')`,
    `UPDATE requests SET review_id = '${org}-review' WHERE id = '${bookingThread}'`,
    `INSERT INTO content_documents (id,organization_id,kind,row_role,locale,product_id,title,path,metadata_json) VALUES ('${org}-product-page','${org}','page','root','en','${product}','Class','/class','{"page_type":"custom"}')`,
  ]
}

/** One lodging tenant: a home with its stay, Airbnb mapping and connection, a saved and a scheduled message, and a team conversation about the stay. */
function lodgingGraph(org: string): string[] {
  const location = `${org}-location`
  const home = `${org}-home`
  const stay = `${org}-stay`
  const member = `${org}-member`
  const thread = `${org}-team-thread`
  return [
    `INSERT INTO products (kind, id,organization_id,name,slug,created_by,updated_by) VALUES ('stay', '${home}','${org}','Cabin','cabin','t','t')`,
    `INSERT INTO product_locations (organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES ('${org}','${home}','${location}',1,1,'t','t')`,
    `INSERT INTO product_stay_configs (product_id,organization_id,location_id,check_in_time,check_out_time,max_guests,assigned_member_id,created_by,updated_by) VALUES ('${home}','${org}','${location}','15:00','11:00',4,'${member}','t','t')`,
    `INSERT INTO stays (id,organization_id,product_id,channel,owner,status,check_in_date,check_out_date,adults,guest_name,total_minor,currency) VALUES ('${stay}','${org}','${home}','direct','app','confirmed','2099-01-05','2099-01-07',2,'Ana',30000,'USD')`,
    `INSERT INTO channex_connections (organization_id,status,group_id) VALUES ('${org}','not_connected','${org}-group')`,
    `INSERT INTO product_channel_mappings (organization_id,product_id,provider,listing_id,channel_id,import_stage) VALUES ('${org}','${home}','channex','${org}-listing','${org}-channel','property')`,
    `INSERT INTO message_templates (id,organization_id,title,body,version,created_at,updated_at) VALUES ('${org}-template','${org}','Welcome','Hello',1,'${NOW}','${NOW}')`,
    `INSERT INTO scheduled_guest_messages (id,organization_id,product_id,stay_id,template_id,template_title,template_version,stay_version,body,due_at,timezone,status,created_at,updated_at)
      VALUES ('${org}-scheduled','${org}','${home}','${stay}','${org}-template','Welcome',1,1,'Hello','2099-01-05T08:00:00.000Z','Asia/Bangkok','pending','${NOW}','${NOW}')`,
    `INSERT INTO team_threads (id,organization_id,stay_id,participants_key,last_message_at) VALUES ('${thread}','${org}','${stay}','${member}','${NOW}')`,
    `INSERT INTO team_thread_members (thread_id,organization_id,member_id) VALUES ('${thread}','${org}','${member}')`,
    `INSERT INTO team_messages (id,organization_id,thread_id,sender_user_id,body,idempotency_key,request_hash) VALUES ('${org}-team-message','${org}','${thread}','${org}-guest','Cleaned','k','h')`,
  ]
}

/** Every table that scopes a row to an organization, and how many rows it holds for this one. */
async function rowsOwnedBy(db: D1Database, org: string): Promise<Record<string, number>> {
  const tables = await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").all<{ name: string }>()
  const counts: Record<string, number> = {}
  for (const { name } of tables.results) {
    const columns = (await db.prepare(`PRAGMA table_info("${name}")`).all<{ name: string }>()).results.map(column => column.name)
    const column = columns.find(candidate => candidate === 'organization_id' || candidate === 'organizationId')
    if (!column) continue
    const count = await db.prepare(`SELECT count(*) AS n FROM "${name}" WHERE "${column}" = ?`).bind(org).first<number>('n')
    if (count) counts[name] = count
  }
  counts.organization = (await db.prepare('SELECT count(*) AS n FROM organization WHERE id = ?').bind(org).first<number>('n'))!
  return counts
}

/**
 * A booking or reservation pins the session, variant and thread it holds, a
 * product page and a product review pin their product, and a session pins the
 * rule that generated it, so deleting any of those parents alone is refused.
 * Deleting the organization removes both sides in one statement and must
 * succeed through the schema's own cascades, with no guest-record pre-delete —
 * which SQLite only allows when those pins are NO ACTION (checked at statement
 * end), not RESTRICT (checked at the parent row).
 */
test('guest records refuse an ordinary parent delete and cascade away with their organization', { timeout: 60_000 }, async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'organization-cascade-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    // The baseline and every forward migration after it, in the journal's order.
    const journal = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string }> }
    for (const { tag } of journal.entries) {
      const statements = readFileSync(`migrations/${tag}.sql`, 'utf8').split('--> statement-breakpoint').map(statement => statement.trim()).filter(Boolean)
      await db.batch(statements.map(statement => db.prepare(statement)))
    }
    await db.batch(['doomed', 'bystander'].flatMap(org => [...tenantGraph(org), ...lodgingGraph(org)]).map(statement => db.prepare(statement)))
    const bystanderBefore = await rowsOwnedBy(db, 'bystander')

    for (const [parent, statement] of [
      ['product session', "DELETE FROM product_sessions WHERE id = 'doomed-session'"],
      ['product variant', "DELETE FROM product_variants WHERE id = 'doomed-variant'"],
      ['booking thread', "DELETE FROM requests WHERE id = 'doomed-booking-thread'"],
      ['reservation thread', "DELETE FROM requests WHERE id = 'doomed-reservation-thread'"],
      // The same pins hold for what a product page, a product review and a
      // generated session name.
      ['product', "DELETE FROM products WHERE id = 'doomed-product'"],
      ['availability rule', "DELETE FROM product_availability_rules WHERE id = 'doomed-rule'"],
      // A stay pins its home, and a team conversation and a scheduled message pin their stay.
      ['stay home', "DELETE FROM product_stay_configs WHERE product_id = 'doomed-home'"],
      ['stay', "DELETE FROM stays WHERE id = 'doomed-stay'"],
    ] as const) {
      await assert.rejects(db.prepare(statement).run(), /FOREIGN KEY constraint failed/, `deleting the ${parent} alone must be refused`)
    }
    assert.equal(await db.prepare("SELECT count(*) AS n FROM bookings WHERE id = 'doomed-booking'").first('n'), 1)
    assert.equal(await db.prepare("SELECT count(*) AS n FROM reservations WHERE id = 'doomed-reservation'").first('n'), 1)

    await db.prepare("DELETE FROM organization WHERE id = 'doomed'").run()

    assert.deepEqual(await rowsOwnedBy(db, 'doomed'), { organization: 0 })
    assert.deepEqual(await rowsOwnedBy(db, 'bystander'), bystanderBefore)
    // The guest's own account is not the tenant's to delete.
    assert.equal(await db.prepare("SELECT count(*) AS n FROM user WHERE id = 'doomed-guest'").first('n'), 1)
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, [])
  } finally {
    await runtime.dispose()
  }
})
