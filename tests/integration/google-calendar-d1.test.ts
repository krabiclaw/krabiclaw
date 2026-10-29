import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../server/db/schema.ts'
import { claimSessionCapacity, setBookingStatus } from '../../server/utils/availability.ts'
import { CalendarSelectionConflict, connectCalendar, calendarSubjects, runCalendarCleanupJobs, disconnectCalendar, readCalendarIntegration, storeCalendarSelection, syncCalendarOrganization } from '../../server/utils/google-calendar.ts'
import { requireIntegrationAccount, type CloudflareEnv } from '../../server/utils/auth.ts'
import { cleanupOrganizationBeforeDelete } from '../../server/utils/tenant-deletion.ts'
import { organizationAdapter } from '../../server/utils/member-access.ts'
import { INTEGRATION_SCOPES } from '../../shared/organization-settings.ts'
import { symmetricEncrypt } from 'better-auth/crypto'
import calendarSyncTask from '../../server/tasks/google-calendar-sync.ts'

test('committed consultation projection is tenant scoped, private, idempotent and fenced during cancellation and cleanup', { timeout: 120_000 }, async (t) => {
  const mf = new Miniflare({ workers: [{ config: { name: 'calendar-proof', compatibilityDate: '2024-11-01', manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } }, env: { DB: { type: 'd1' } } } }] })
  try {
    const db = await mf.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO organization(id,name,slug, default_currency, timezone) VALUES('org','Org','org', 'USD', 'UTC'),('other','Other','other', 'USD', 'UTC')").run()
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('service','p','org','Consultation','consultation','actor','actor'),('experience','class','org','Class','class','actor','actor')").run()
    await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('v','org','p','Consultation','actor','actor')").run()
    // Held online by a provider whose hours cover the sessions.
    await db.prepare("INSERT OR IGNORE INTO user(id,name,email,emailVerified) VALUES('host','Host','host@example.test',1)").run()
    await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,'host','member',1)").bind('host-org', 'org').run()
    await db.prepare(`INSERT INTO member_scheduling(member_id,organization_id,public_name,public_approved,timezone,weekly_json,time_off_json,windows_json,windows_until,calendar_revision,updated_at,updated_by) VALUES(?,?,'Host',1,'UTC','[]','[]','[{"start":"2099-01-01T00:00:00.000Z","end":"2100-01-01T00:00:00.000Z"}]','2100-01-01T00:00:00.000Z','r1','2099-01-01T00:00:00.000Z','host')`).bind('host-org', 'org').run()
    await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,duration_minutes,held_online,scheduling_mode,assigned_member_id,confirmation_mode,created_by,updated_by) VALUES('p','org',30,1,'provider','host-org','review','actor','actor'),('class','org',30,1,'provider','host-org','instant','actor','actor')").run()
    await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,assigned_member_id,timezone,starts_at,ends_at,capacity,created_by,updated_by) VALUES('s','org','p','host-org','America/New_York','2099-11-01T14:00:00.000Z','2099-11-01T14:30:00.000Z',1,'actor','actor')").run()
    await db.prepare(`INSERT INTO requests(id,kind,organization_id,conversation_state,payload_json) VALUES('thread','booking','org','needs_attention','{"guest":{"name":"Jane Doe","email":"private@example.test","phone":null},"notes":"PRIVATE MATTER"}')`).run()
    const { bookingId } = await claimSessionCapacity(db, { organizationId: 'org', productId: 'p', sessionId: 's', productVariantId: 'v', partySize: 1, requestId: 'thread' })
    await storeCalendarSelection(db, 'org', { account_id: 'linked-account', calendar_id: 'chosen', calendar_name: 'Calendar' })
    const integration = (await readCalendarIntegration(db, 'org'))!
    assert.equal((await calendarSubjects(db, 'other', integration)).length, 0)
    await db.prepare("INSERT INTO organization_integrations(id,organization_id,provider,account_id,target_id,target_name,measurement_id,revision)VALUES('analytics','org','google_analytics','linked-account','property','Analytics','G-123','a')").run()
    const env = { DB: db, BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test' } as CloudflareEnv
    await db.prepare("INSERT INTO user(id,name,email) VALUES('owner','Owner','owner@example.test'),('foreign','Foreign','foreign@example.test')").run()
    await db.prepare("INSERT INTO account(id,accountId,providerId,userId,scope) VALUES('linked-account','google-subject','google','owner',?)").bind(INTEGRATION_SCOPES['google-calendar'].join(',')).run()
    await requireIntegrationAccount(env, 'linked-account', { userId: 'owner', currentAccountId: null, providerId: 'google', scopes: INTEGRATION_SCOPES['google-calendar'] })
    await assert.rejects(requireIntegrationAccount(env, 'linked-account', { userId: 'foreign', currentAccountId: null, providerId: 'google', scopes: INTEGRATION_SCOPES['google-calendar'] }))
    assert.ok(!JSON.stringify(integration).includes('token'))
    const provider = { token: async (accountId: string) => { assert.equal(accountId, 'linked-account'); return 'token' } }
    const events = new Map<string, Record<string, unknown>>()
    let timeoutAfterInsert = true; let denyCalendar = false; let cancelDuringPut = false; let disconnectDuringPost = false
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.hostname, 'www.googleapis.com')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer token')
      if (url.pathname.includes('/calendarList/')) return denyCalendar ? new Response(null, { status: 404 }) : Response.json({ accessRole: 'writer' })
      assert.equal(url.searchParams.get('sendUpdates'), 'none')
      const payload = init?.body ? JSON.parse(String(init.body)) : null
      const id = init?.method === 'POST' ? payload.id : url.pathname.split('/').at(-1)!
      if (init?.method === 'DELETE') { events.delete(id); return new Response(null, { status: 204 }) }
      if (init?.method === 'POST') {
        if (events.has(id)) return new Response(null, { status: 409 })
        events.set(id, payload)
        if (disconnectDuringPost) { disconnectDuringPost = false; await disconnectCalendar(db, 'org') }
        if (timeoutAfterInsert) { timeoutAfterInsert = false; throw new Error('timeout after provider committed') }
      } else {
        events.set(id, payload)
        if (cancelDuringPut) { cancelDuringPut = false; await setBookingStatus(db, { organizationId: 'org', bookingId, status: 'cancelled' }) }
      }
      return Response.json({ id })
    })
    assert.equal((await syncCalendarOrganization(env, 'org', 25, provider)).failed, 1)
    assert.equal((await db.prepare('SELECT status FROM bookings WHERE id=?').bind(bookingId).first())?.status, 'pending')
    assert.equal((await readCalendarIntegration(db, 'org'))?.status, 'error')
    await db.prepare('UPDATE google_calendar_event_links SET next_attempt_at=NULL').run()
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 1)
    const link = await db.prepare('SELECT * FROM google_calendar_event_links').first()
    assert.equal(link?.operational_id, bookingId)
    assert.equal(link?.request_id, 'thread')
    const event = events.get(String(link?.event_id))!
    assert.equal(event.summary, 'Pending booking — Jane Doe')
    assert.deepEqual(event.start, { dateTime: '2099-11-01T14:00:00.000Z', timeZone: 'America/New_York' })
    assert.equal(event.attendees, undefined)
    assert.equal(event.description, 'Status: pending\nTeam member: Host\nhttps://krabiclaw.test/dashboard/org/messages/thread')
    assert.ok(!JSON.stringify(event).includes('PRIVATE MATTER'))
    assert.ok(!JSON.stringify(event).includes('private@example.test'))
    await setBookingStatus(db, { organizationId: 'org', bookingId, status: 'confirmed' })
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 1)
    assert.equal(events.get(String(link?.event_id))?.summary, 'Booking — Jane Doe')
    // A booking moved to a team member updates the same event to name them.
    await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('member-owner','org','owner','owner',?)").bind(Date.now()).run()
    await db.prepare("UPDATE bookings SET assigned_member_id='member-owner',updated_at=? WHERE id=?").bind(new Date().toISOString(), bookingId).run()
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 1)
    assert.equal(events.get(String(link?.event_id))?.description, 'Status: confirmed\nTeam member: Owner\nhttps://krabiclaw.test/dashboard/org/messages/thread')
    await db.prepare("UPDATE bookings SET assigned_member_id=NULL,updated_at=? WHERE id=?").bind(new Date().toISOString(), bookingId).run()
    cancelDuringPut = true
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 0, 'late update is compensated after committed cancellation')
    assert.equal((await db.prepare('SELECT state FROM google_calendar_event_links').first())?.state, 'deleted')
    // Failed cleanup is retained even when Google answers 404 for lost access.
    await disconnectCalendar(db, 'org')
    // Cancelled subject was already deleted; create another real committed claim.
    const second = await claimSessionCapacity(db, { organizationId: 'org', productId: 'p', sessionId: 's', productVariantId: 'v', partySize: 1 })
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal((await readCalendarIntegration(db, 'org'))?.status, 'disabled')
    assert.equal((await db.prepare("SELECT measurement_id FROM organization_integrations WHERE organization_id='org' AND provider='google_analytics'").first())?.measurement_id, 'G-123')
    await storeCalendarSelection(db, 'org', { account_id: 'linked-account', calendar_id: 'chosen', calendar_name: 'Calendar' })
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 1)
    // Disable while a create is in flight: the late result is removed, and
    // its original identity remains locally for audit.
    await disconnectCalendar(db, 'org')
    await syncCalendarOrganization(env, 'org', 25, provider)
    await storeCalendarSelection(db, 'org', { account_id: 'linked-account', calendar_id: 'chosen', calendar_name: 'Calendar' })
    disconnectDuringPost = true
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 0, 'late create cannot survive disconnect')
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal((await readCalendarIntegration(db, 'org'))?.status, 'disabled')
    await storeCalendarSelection(db, 'org', { account_id: 'linked-account', calendar_id: 'chosen', calendar_name: 'Calendar' })
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 1)
    await disconnectCalendar(db, 'org')
    denyCalendar = true
    assert.equal((await syncCalendarOrganization(env, 'org', 25, provider)).failed, 1)
    assert.equal(events.size, 1)
    assert.equal((await readCalendarIntegration(db, 'org'))?.status, 'disabled')
    assert.ok((await readCalendarIntegration(db, 'org'))?.last_error)
    await assert.rejects(storeCalendarSelection(db, 'org', { account_id: 'linked-account', calendar_id: 'new', calendar_name: 'New' }), CalendarSelectionConflict)
    denyCalendar = false
    await db.prepare('UPDATE google_calendar_event_links SET next_attempt_at=NULL').run()
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 0)
    assert.equal((await db.prepare('SELECT status FROM bookings WHERE id=?').bind(second.bookingId).first())?.status, 'pending')
    await storeCalendarSelection(db, 'org', { account_id: 'linked-account', calendar_id: 'chosen', calendar_name: 'Calendar' })
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 1)
    await cleanupOrganizationBeforeDelete(env, 'org', 'owner')
    await cleanupOrganizationBeforeDelete(env, 'org', 'owner')
    assert.equal((await runCalendarCleanupJobs(env, 25, provider)).checked, 0, 'staging cannot authorize orphan deletion while tenant still exists')
    assert.equal(events.size, 1)
    assert.equal((await db.prepare('SELECT count(*) n FROM google_calendar_cleanup_jobs').first())?.n, 1)
    await (await organizationAdapter(env)).deleteOrganization('org')
    assert.equal(await db.prepare("SELECT id FROM organization WHERE id='org'").first(), null)
    assert.equal(await db.prepare('SELECT id FROM google_calendar_event_links').first(), null)
    const orphan = await db.prepare('SELECT * FROM google_calendar_cleanup_jobs').first()
    assert.equal(orphan?.organization_id, 'org')
    assert.equal(orphan?.account_id, 'linked-account')
    assert.ok(!JSON.stringify(orphan).includes('PRIVATE MATTER'))
    assert.equal(orphan?.booking_id, undefined)
    denyCalendar = true
    assert.equal((await runCalendarCleanupJobs(env, 25, provider)).failed, 1)
    assert.equal(events.size, 1)
    assert.equal((await db.prepare('SELECT state FROM google_calendar_cleanup_jobs').first())?.state, 'error')
    assert.equal((await syncCalendarOrganization(env, 'org', 25, provider)).checked, 0)
    denyCalendar = false
    await db.prepare('UPDATE google_calendar_cleanup_jobs SET next_attempt_at=NULL').run()
    assert.equal((await runCalendarCleanupJobs(env, 25, provider)).failed, 0)
    assert.equal(events.size, 0)
    assert.ok((await db.prepare('SELECT completed_at FROM google_calendar_cleanup_jobs').first())?.completed_at)
    assert.ok(await db.prepare("SELECT id FROM organization WHERE id='other'").first())

  } finally { await mf.dispose() }
})


test('bounded Calendar backfill resumes and cancelled historical Sessions are cleaned', { timeout: 120_000 }, async (t) => {
  const mf = new Miniflare({ workers: [{ config: { name: 'calendar-budget-proof', compatibilityDate: '2024-11-01', manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } }, env: { DB: { type: 'd1' } } } }] })
  try {
    const db = await mf.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare("INSERT INTO organization(id,name,slug, default_currency, timezone) VALUES('org','Org','org', 'USD', 'UTC')").run()
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('service','p','org','Consultation','consultation','actor','actor')").run()
    // Held online by a provider whose hours cover the sessions.
    await db.prepare("INSERT OR IGNORE INTO user(id,name,email,emailVerified) VALUES('host','Host','host@example.test',1)").run()
    await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,'host','member',1)").bind('host-org', 'org').run()
    await db.prepare(`INSERT INTO member_scheduling(member_id,organization_id,public_name,public_approved,timezone,weekly_json,time_off_json,windows_json,windows_until,calendar_revision,updated_at,updated_by) VALUES(?,?,'Host',1,'UTC','[]','[]','[{"start":"2099-01-01T00:00:00.000Z","end":"2100-01-01T00:00:00.000Z"}]','2100-01-01T00:00:00.000Z','r1','2099-01-01T00:00:00.000Z','host')`).bind('host-org', 'org').run()
    await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,duration_minutes,held_online,scheduling_mode,assigned_member_id,confirmation_mode,created_by,updated_by) VALUES('p','org',30,1,'provider','host-org','review','actor','actor')").run()
    await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('v','org','p','Consultation','actor','actor')").run()
    const bookings: string[] = []
    for (let i = 0; i < 55; i++) {
      const start = Date.parse('2099-11-01T00:00:00.000Z') + i * 3600_000
      await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,assigned_member_id,timezone,starts_at,ends_at,capacity,created_by,updated_by) VALUES(?,'org','p','host-org','UTC',?,?,1,'actor','actor')").bind(`s${i.toString().padStart(2, '0')}`, new Date(start).toISOString(), new Date(start + 1800_000).toISOString()).run()
      bookings.push((await claimSessionCapacity(db, { organizationId: 'org', productId: 'p', sessionId: `s${i.toString().padStart(2, '0')}`, productVariantId: 'v', partySize: 1 })).bookingId)
    }
    const env = { DB: db, NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test' } as CloudflareEnv
    await storeCalendarSelection(db, 'org', { account_id: 'linked-account', calendar_id: 'chosen', calendar_name: 'Calendar' })
    const provider = { token: async () => 'token' }
    for (const expected of [25, 50, 55]) {
      await syncCalendarOrganization(env, 'org', 0, provider)
      assert.equal((await db.prepare('SELECT count(*) n FROM google_calendar_event_links').first())?.n, expected)
    }
    const oldest = await db.prepare('SELECT operational_id FROM google_calendar_event_links ORDER BY updated_at, operational_id LIMIT 1').first<{ operational_id: string }>()
    await db.prepare("UPDATE bookings SET updated_at='2099-01-01T00:00:00.000Z' WHERE id=?").bind(oldest!.operational_id).run()
    const previous = await db.prepare('SELECT booking_revision FROM google_calendar_event_links WHERE operational_id=?').bind(oldest!.operational_id).first()
    await syncCalendarOrganization(env, 'org', 0, provider)
    assert.notEqual((await db.prepare('SELECT booking_revision FROM google_calendar_event_links WHERE operational_id=?').bind(oldest!.operational_id).first())?.booking_revision, previous?.booking_revision, 'changed existing subjects are reconciled without rotating unchanged rows')
    const events = new Map<string, unknown>()
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/calendarList/')) return Response.json({ accessRole: 'writer' })
      const payload = init?.body ? JSON.parse(String(init.body)) : null
      const id = init?.method === 'POST' ? payload.id : url.pathname.split('/').at(-1)!
      if (init?.method === 'DELETE') { events.delete(id); return new Response(null, { status: 204 }) }
      events.set(id, payload)
      return Response.json(payload)
    })
    // Drain the bounded queue through the provider boundary.
    for (let i = 0; i < 3; i++) await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 55)
    for(const event of events.values())assert.equal((event as {description:string}).description,'Status: pending\nTeam member: Host','a booking without a guest thread has no fabricated dashboard link')
    await setBookingStatus(db, { organizationId: 'org', bookingId: bookings[0]!, status: 'confirmed' })
    for (let i = 0; i < 3; i++) await syncCalendarOrganization(env, 'org', 25, provider)
    // Imported historical state, independently of the live change workflow.
    await db.prepare("UPDATE product_sessions SET starts_at='2020-01-01T10:00:00.000Z',ends_at='2020-01-01T10:30:00.000Z' WHERE id='s00'").run()
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 55, 'confirmed ended scheduled consultation retains its event')
    // Legacy/imported state: a confirmed booking can reference a cancelled Session.
    await db.prepare("UPDATE product_sessions SET status='cancelled' WHERE id='s00'").run()
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 54, 'cancelled historical Session does not retain the event')
    assert.equal((await db.prepare('SELECT state FROM google_calendar_event_links WHERE operational_id=?').bind(bookings[0]).first())?.state, 'deleted')
  } finally { await mf.dispose() }
})

test('scheduled Calendar sync reports thrown and event failures while projecting healthy organizations', { timeout: 120_000 }, async t => {
  const mf = new Miniflare({ workers: [{ config: { name: 'calendar-task-proof', compatibilityDate: '2024-11-01', manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } }, env: { DB: { type: 'd1' } } } }] })
  try {
    const db = await mf.getD1Database('DB')
    await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).map(sql => db.prepare(sql)))
    const env = { DB: db, STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test', GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret' } as CloudflareEnv
    await db.prepare("INSERT INTO user(id,name,email,emailVerified) VALUES('actor','Actor','actor@example.test',1)").run()
    const accessToken = await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET!, data: 'calendar-task-token' })
    await db.prepare("INSERT INTO account(id,accountId,providerId,userId,scope,accessToken) VALUES('linked','google-subject','google','actor',?,?)").bind(INTEGRATION_SCOPES['google-calendar'].join(','), accessToken).run()
    for (const org of ['a-broken', 'b-failed', 'c-healthy']) {
      await db.prepare(`INSERT INTO organization(id,name,slug, default_currency, timezone) VALUES(?,?,?, 'USD', 'UTC')`).bind(org, org, org).run()
      // Google Calendar sync is Business; the task reads only entitled organizations.
      await db.prepare("INSERT INTO subscription(id,plan,referenceId,status,periodEnd) VALUES(?,'business',?,'active',4070908800)").bind(`sub-${org}`, org).run()
      await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('service',?,?,?,'consultation','actor','actor')").bind(org, org, org).run()
    // Held online by a provider whose hours cover the sessions.
      await db.prepare("INSERT OR IGNORE INTO user(id,name,email,emailVerified) VALUES('host','Host','host@example.test',1)").run()
      await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,'host','member',1)").bind(`host-${org}`, org).run()
      await db.prepare(`INSERT INTO member_scheduling(member_id,organization_id,public_name,public_approved,timezone,weekly_json,time_off_json,windows_json,windows_until,calendar_revision,updated_at,updated_by) VALUES(?,?,'Host',1,'UTC','[]','[]','[{"start":"2099-01-01T00:00:00.000Z","end":"2100-01-01T00:00:00.000Z"}]','2100-01-01T00:00:00.000Z','r1','2099-01-01T00:00:00.000Z','host')`).bind(`host-${org}`, org).run()
      await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,duration_minutes,held_online,scheduling_mode,assigned_member_id,created_by,updated_by) VALUES(?,?,30,1,'provider',?,'actor','actor')").bind(org, org, `host-${org}`).run()
      await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES(?,?,?,'Consultation','actor','actor')").bind(org, org, org).run()
      await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,assigned_member_id,timezone,starts_at,ends_at,capacity,created_by,updated_by) VALUES(?,?,?,?,'UTC','2099-11-01T10:00:00.000Z','2099-11-01T10:30:00.000Z',1,'actor','actor')").bind(org, org, org, `host-${org}`).run()
      await claimSessionCapacity(db, { organizationId: org, productId: org, sessionId: org, productVariantId: org, partySize: 1 })
      await storeCalendarSelection(db, org, { account_id: 'linked', calendar_id: org, calendar_name: org })
    }
    await db.prepare("CREATE TRIGGER reject_broken_projection BEFORE INSERT ON google_calendar_event_links WHEN NEW.organization_id='a-broken' BEGIN SELECT RAISE(ABORT,'projection write rejected'); END").run()
    const events = new Map<string, unknown>()
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input))
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer calendar-task-token')
      if (url.pathname.includes('b-failed')) return Response.json({ error: { message: 'Calendar access refused' } }, { status: 403 })
      if (url.pathname.includes('/calendarList/')) return Response.json({ accessRole: 'writer' })
      // The inbound side: the channel opens and the change list is empty.
      if (url.pathname.endsWith('/events/watch')) return Response.json({ resourceId: 'resource', expiration: String(Date.now() + 86_400_000 * 7) })
      if (!init?.method || init.method === 'GET') return Response.json({ items: [], nextSyncToken: 'position' })
      const payload = JSON.parse(String(init?.body))
      events.set(url.pathname, payload)
      return Response.json(payload)
    })
    await assert.rejects(calendarSyncTask.run({ name: 'google-calendar-sync', payload: {}, context: { cloudflare: { env } } }), error => {
      assert.match(String(error), /a-broken:.*projection write rejected/s)
      assert.match(String(error), /b-failed: 1 Google Calendar event\(s\) failed/)
      assert.match(String(error), /b-failed: calendar changes could not be read/)
      return true
    })
    assert.equal(await db.prepare("SELECT sync_token FROM google_calendar_sync WHERE organization_id='c-healthy'").first('sync_token'), 'position', 'the healthy organization took its change-list position')
    assert.equal((await readCalendarIntegration(db, 'b-failed'))?.status, 'error')
    assert.equal((await readCalendarIntegration(db, 'b-failed'))!.last_error, 'Google Calendar returned 403. Check the account grant and calendar writer access.')
    assert.equal(await db.prepare("SELECT state FROM google_calendar_event_links WHERE organization_id='c-healthy'").first('state'), 'synced')
    assert.equal(events.size, 2, 'the healthy organization created and updated its event despite other failures')
    assert([...events.keys()].every(path => path.includes('/calendars/c-healthy/events')))
    for (const event of events.values()) {
      assert.equal((event as { summary: string }).summary, 'Booking')
      assert.deepEqual((event as { start: unknown }).start, { dateTime: '2099-11-01T10:00:00.000Z', timeZone: 'UTC' })
    }
  } finally { await mf.dispose() }
})


test('automatic Calendar connection recovers a hidden calendar after ambiguous creation and reuses it on reconnect', {timeout:120000}, async t => {
 const runtime=new Miniflare({workers:[{config:{name:'calendar-setup-proof',compatibilityDate:'2024-11-01',manifest:{mainModule:'index.mjs',modules:{'index.mjs':{type:'esm',contents:'export default {fetch(){return new Response("ok")}}'}}},env:{DB:{type:'d1'}}}}]})
 try {
  const db=await runtime.getD1Database('DB')
  await db.batch((await generateSQLiteMigration(await generateSQLiteDrizzleJson({}),await generateSQLiteDrizzleJson(schema))).map(sql=>db.prepare(sql)))
  await db.prepare("INSERT INTO organization(id,name,slug, default_currency, timezone)VALUES('org','Org','org', 'USD', 'UTC')").run()
  const calendars:{id:string;summary:string;description:string;accessRole:string;hidden:boolean}[]=[]
  let inserts=0, visible=false
  t.mock.method(globalThis,'fetch',async(input,init)=>{
   const url=new URL(String(input))
   assert.equal(url.hostname,'www.googleapis.com')
   assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer token')
   if(init?.method==='POST') {
    assert.equal(url.pathname,'/calendar/v3/calendars')
    const payload=JSON.parse(String(init.body))
    assert.deepEqual(payload,{summary:'KrabiClaw',description:'Krabiclaw bookings for organization org'})
    inserts++
    calendars.push({...payload,id:'created-calendar',accessRole:'owner',hidden:true})
    throw new Error('Timeout after Google committed the calendar')
   }
   if(url.pathname.endsWith('/calendarList'))return Response.json({items:visible?calendars.filter(calendar=>!calendar.hidden || url.searchParams.get('showHidden')==='true'):[]})
   assert.equal(url.pathname,'/calendar/v3/users/me/calendarList/created-calendar')
   return Response.json(calendars[0])
  })
  await assert.rejects(connectCalendar(db,'org','linked','token'),/Timeout/)
  await assert.rejects(connectCalendar(db,'org','linked','token'),CalendarSelectionConflict)
  assert.equal(inserts,1,'an unseen provider outcome must not create a duplicate calendar')
  visible=true
  await connectCalendar(db,'org','linked','token')
  const connection=await readCalendarIntegration(db,'org')
  assert.equal(connection?.calendar_id,'created-calendar')
  assert.equal(connection?.calendar_name,'KrabiClaw')
  assert.equal(await db.prepare('SELECT * FROM google_calendar_setup').first(),null)
  await disconnectCalendar(db,'org')
  await connectCalendar(db,'org','linked','token')
  assert.equal((await readCalendarIntegration(db,'org'))?.status,'active')
  assert.equal((await readCalendarIntegration(db,'org'))?.calendar_id,'created-calendar')
  assert.equal(inserts,1,'disconnect and reconnect use the same calendar')
 } finally {await runtime.dispose()}
})
