import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Miniflare } from 'miniflare'

const NOW = '2026-09-27T00:00:00.000Z'

/** One tenant's guest graph: a booked session, a booked table, and the threads, review request, review and product page that hang off them. */
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
    `INSERT INTO product_booking_configs (product_id,organization_id,unit,duration_minutes,default_capacity,scheduling_mode,created_by,updated_by) VALUES ('${product}','${org}','slot',60,4,'business','t','t')`,
    `INSERT INTO product_availability_rules (id,organization_id,product_id,location_id,timezone,weekday,start_time,created_by,updated_by) VALUES ('${rule}','${org}','${product}','${location}','Asia/Bangkok',1,'10:00','t','t')`,
    `INSERT INTO product_sessions (id,organization_id,product_id,location_id,availability_rule_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by)
      VALUES ('${session}','${org}','${product}','${location}','${rule}','Asia/Bangkok','2099-01-05T03:00:00.000Z','2099-01-05T04:00:00.000Z',4,'scheduled','t','t')`,
    `INSERT INTO products (kind, id,organization_id,name,slug,created_by,updated_by) VALUES ('table', '${org}-tables','${org}','Tables','tables','t','t')`,
    `INSERT INTO product_variants (id,organization_id,product_id,name,created_by,updated_by) VALUES ('${org}-table','${org}','${org}-tables','Table','t','t')`,
    `INSERT INTO product_locations (organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES ('${org}','${org}-tables','${location}',1,1,'t','t')`,
    `INSERT INTO product_booking_configs (product_id,organization_id,unit,duration_minutes,default_capacity,scheduling_mode,payment_basis,assigned_member_id,created_by,updated_by) VALUES ('${org}-tables','${org}','slot',120,2,'business','per_booking','${org}-member','t','t')`,
    `INSERT INTO product_sessions (id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,status,created_by,updated_by)
      VALUES ('${org}-seating','${org}','${org}-tables','${location}','Asia/Bangkok','2099-01-06T09:00:00.000Z','2099-01-06T11:00:00.000Z',2,'scheduled','t','t')`,
    `INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,location_id,starts_at,ends_at,timezone,user_id,party_size,policy_json,status) VALUES ('${org}-booking','${org}','${product}','${session}','${variant}','${location}','2099-01-05T03:00:00.000Z','2099-01-05T04:00:00.000Z','Asia/Bangkok','${guest}',1,'{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}','confirmed')`,
    `INSERT INTO bookings (id,organization_id,product_id,product_session_id,product_variant_id,location_id,starts_at,ends_at,timezone,user_id,party_size,policy_json,status) VALUES ('${org}-reservation','${org}','${org}-tables','${org}-seating','${org}-table','${location}','2099-01-06T09:00:00.000Z','2099-01-06T11:00:00.000Z','Asia/Bangkok','${guest}',2,'{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}','confirmed')`,
    `INSERT INTO review_requests (id,organization_id,location_id,user_id,booking_id,token_hash,expires_at) VALUES ('${org}-review-request','${org}','${location}','${guest}','${org}-booking','${org}-token','2099-02-01T00:00:00.000Z')`,
    `INSERT INTO reviews (id,organization_id,location_id,user_id,booking_id,product_id,rating,status) VALUES ('${org}-review','${org}','${location}','${guest}','${org}-booking','${product}',5,'published')`,
    `INSERT INTO conversations (id,kind,organization_id,location_id,booking_id,user_id,payload_json,last_message_at,created_at) VALUES ('${bookingThread}','booking','${org}','${location}','${org}-booking','${guest}',${payload},'${NOW}','${NOW}')`,
    `INSERT INTO conversations (id,kind,organization_id,location_id,booking_id,user_id,payload_json,last_message_at,created_at) VALUES ('${reservationThread}','booking','${org}','${location}','${org}-reservation','${guest}',${payload},'${NOW}','${NOW}')`,
    `INSERT INTO messages (id,organization_id,conversation_id,sequence,author_kind,author_user_id,channel,body,dedupe_key,occurred_at,created_at) VALUES ('${org}-guest-message','${org}','${bookingThread}',1,'guest','${guest}','web','Hello','${org}-guest-message','${NOW}','${NOW}')`,
    `INSERT INTO conversation_participants (conversation_id,organization_id,user_id,role,last_read_message_id,created_at) VALUES ('${bookingThread}','${org}','${guest}','guest','${org}-guest-message','${NOW}')`,
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
    `INSERT INTO product_stay_configs (product_id,organization_id,location_id,created_by,updated_by) VALUES ('${home}','${org}','${location}','t','t')`,
    `INSERT INTO product_booking_configs (product_id,organization_id,unit,scheduling_mode,online_payment_required,check_in_time,check_out_time,default_capacity,min_nights,assigned_member_id,created_by,updated_by) VALUES ('${home}','${org}','nights','business',1,'15:00','11:00',4,1,'${member}','t','t')`,
    `INSERT INTO product_variants (id,organization_id,product_id,name,created_by,updated_by) VALUES ('${home}-night','${org}','${home}','Night','t','t')`,
    `INSERT INTO bookings (id,organization_id,user_id,product_id,product_variant_id,location_id,starts_at,ends_at,timezone,party_size,adults,children,infants,channel,owner,status,policy_json,total_minor,currency)
      VALUES ('${stay}','${org}','${org}-guest','${home}','${home}-night','${location}','2099-01-05T08:00:00.000Z','2099-01-07T04:00:00.000Z','Asia/Bangkok',2,2,0,0,'direct','app','confirmed','{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}',30000,'USD')`,
    `INSERT INTO conversations (id,kind,organization_id,location_id,booking_id,user_id,payload_json,last_message_at,created_at) VALUES ('${stay}-thread','booking','${org}','${location}','${stay}','${org}-guest','{"guest":{"name":"Ana","email":null,"phone":null},"ip_hash":null,"cancellation":{"token_hash":null,"expires_at":null,"used_at":null}}','${NOW}','${NOW}')`,
    `INSERT INTO stay_nights (organization_id,product_id,date,booking_id) VALUES ('${org}','${home}','2099-01-05','${stay}'),('${org}','${home}','2099-01-06','${stay}')`,
    `INSERT INTO channex_connections (organization_id,status,group_id) VALUES ('${org}','not_connected','${org}-group')`,
    `INSERT INTO product_channel_mappings (organization_id,product_id,provider,listing_id,channel_id,import_stage) VALUES ('${org}','${home}','channex','${org}-listing','${org}-channel','property')`,
    `INSERT INTO message_templates (id,organization_id,title,body,version,created_at,updated_at) VALUES ('${org}-template','${org}','Welcome','Hello',1,'${NOW}','${NOW}')`,
    `INSERT INTO scheduled_guest_messages (id,organization_id,product_id,booking_id,template_id,template_title,template_version,body,due_at,timezone,status,created_at,updated_at)
      VALUES ('${org}-scheduled','${org}','${home}','${stay}','${org}-template','Welcome',1,'Hello','2099-01-05T08:00:00.000Z','Asia/Bangkok','pending','${NOW}','${NOW}')`,
    `INSERT INTO conversations (id,kind,organization_id,booking_id,participants_key,last_message_at,created_at) VALUES ('${thread}','team','${org}','${stay}','${member}','${NOW}','${NOW}')`,
    `INSERT INTO conversation_participants (conversation_id,organization_id,user_id,role,created_at) VALUES ('${thread}','${org}','${org}-guest','member','${NOW}')`,
    `INSERT INTO messages (id,organization_id,conversation_id,sequence,author_kind,author_user_id,body,dedupe_key,occurred_at,created_at) VALUES ('${org}-team-message','${org}','${thread}',1,'member','${org}-guest','Cleaned','team:${thread}:k','${NOW}','${NOW}')`,
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
 * A booking — a class seat or a table — pins the session and variant it holds, a conversation pins its booking, a
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
      ['booked class seat', "DELETE FROM bookings WHERE id = 'doomed-booking'"],
      ['table booking', "DELETE FROM bookings WHERE id = 'doomed-reservation'"],
      ['table seating', "DELETE FROM product_sessions WHERE id = 'doomed-seating'"],
      // The same pins hold for what a product page, a product review and a
      // generated session name.
      ['product', "DELETE FROM products WHERE id = 'doomed-product'"],
      ['availability rule', "DELETE FROM product_availability_rules WHERE id = 'doomed-rule'"],
      // A stay pins its home: the booking names the home's one variant. Its guest and team conversations name it and go with the organization.
      ['stay home', "DELETE FROM products WHERE id = 'doomed-home'"],
      ['stay', "DELETE FROM bookings WHERE id = 'doomed-stay'"],
    ] as const) {
      await assert.rejects(db.prepare(statement).run(), /FOREIGN KEY constraint failed/, `deleting the ${parent} alone must be refused`)
    }
    assert.equal(await db.prepare("SELECT count(*) AS n FROM bookings WHERE id = 'doomed-booking'").first('n'), 1)
    assert.equal(await db.prepare("SELECT count(*) AS n FROM bookings WHERE id = 'doomed-reservation'").first('n'), 1)

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
