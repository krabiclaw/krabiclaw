import assert from 'node:assert/strict'
import { OPEN_TERMS_JSON } from './support/booking-terms.ts'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { claimSessionCapacity } from '../../server/utils/availability.ts'
import { nameConversationBooking, setBookingStatus } from './support/booking-state.ts'
import { CalendarSelectionConflict, calendarSubjects, runCalendarCleanupJobs, disconnectCalendar, readCalendarIntegration, storeCalendarSelection, syncCalendarOrganization } from '../../server/utils/google-calendar.ts'
import { requireIntegrationAccount, type CloudflareEnv } from '../../server/utils/auth.ts'
import { cleanupOrganizationBeforeDelete } from '../../server/utils/tenant-deletion.ts'
import { organizationAdapter } from '../../server/utils/member-access.ts'
import { INTEGRATION_SCOPES } from '../../shared/organization-settings.ts'
import { applySchema } from './support/schema.ts'

test('committed consultation projection is tenant scoped, private, idempotent and removed on cancellation and cleanup', { timeout: 120_000 }, async (t) => {
  const mf = new Miniflare({ workers: [{ config: { name: 'calendar-proof', compatibilityDate: '2024-11-01', manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } }, env: { DB: { type: 'd1' } } } }] })
  try {
    const db = await mf.getD1Database('DB')
    await applySchema(db)
    await db.prepare("INSERT INTO organization(id,name,slug, default_currency, timezone) VALUES('org','Org','org', 'USD', 'UTC'),('other','Other','other', 'USD', 'UTC')").run()
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('service','p','org','Consultation','consultation','actor','actor'),('experience','class','org','Class','class','actor','actor')").run()
    await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('v','org','p','Consultation','actor','actor')").run()
    // Held online by a provider whose hours cover the sessions.
    await db.prepare("INSERT OR IGNORE INTO user(id,name,email,emailVerified) VALUES('host','Host','host@example.test',1)").run()
    await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,'host','member',1)").bind('host-org', 'org').run()
    await db.prepare(`INSERT INTO member_scheduling(member_id, organization_id, public_name, public_approved, timezone, weekly_json, time_off_json, updated_at, updated_by) VALUES(?,?,'Host',1,'UTC','[{"weekday":0,"start":"00:00","end":"23:59"},{"weekday":1,"start":"00:00","end":"23:59"},{"weekday":2,"start":"00:00","end":"23:59"},{"weekday":3,"start":"00:00","end":"23:59"},{"weekday":4,"start":"00:00","end":"23:59"},{"weekday":5,"start":"00:00","end":"23:59"},{"weekday":6,"start":"00:00","end":"23:59"}]','[]','2099-01-01T00:00:00.000Z','host')`).bind('host-org', 'org').run()
    await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,duration_minutes,held_online,scheduling_mode,assigned_member_id,confirmation_mode,created_by,updated_by) VALUES('p','org','slot',30,1,'provider','host-org','review','actor','actor'),('class','org','slot',30,1,'provider','host-org','instant','actor','actor')").run()
    await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,timezone,starts_at,ends_at,capacity,created_by,updated_by) VALUES('s','org','p','America/New_York','2099-11-01T14:00:00.000Z','2099-11-01T14:30:00.000Z',1,'actor','actor')").run()
    await db.prepare(`INSERT INTO conversations(id,kind,organization_id,payload_json,last_message_at) VALUES('thread','booking','org','{"guest":{"name":"Jane Doe","email":"private@example.test","phone":null},"notes":"PRIVATE MATTER"}','2099-01-01T00:00:00.000Z')`).run()
    const env = { DB: db, BETTER_AUTH_URL: 'https://proof.example', BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests', NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.test' } as CloudflareEnv
    const { bookingId } = await claimSessionCapacity(db, { websiteSource: null, policyJson: OPEN_TERMS_JSON, env, organizationId: 'org', productId: 'p', sessionId: 's', productVariantId: 'v', partySize: 1 })
    await nameConversationBooking(db, 'thread', bookingId)
    await storeCalendarSelection(db, 'org', { account_id: 'linked-account', calendar_id: 'chosen', calendar_name: 'Calendar' })
    const integration = (await readCalendarIntegration(db, 'org'))!
    assert.equal((await calendarSubjects(db, 'other', integration)).length, 0)
    await db.prepare("INSERT INTO organization_integrations(id,organization_id,provider,account_id,target_id,target_name,measurement_id,revision)VALUES('analytics','org','google_analytics','linked-account','property','Analytics','G-123','a')").run()
    await db.prepare("INSERT INTO user(id,name,email,emailVerified) VALUES('owner','Owner','owner@example.test',1),('foreign','Foreign','foreign@example.test',1)").run()
    await db.prepare("INSERT INTO account(id,accountId,providerId,userId,scope) VALUES('linked-account','google-subject','google','owner',?)").bind(INTEGRATION_SCOPES['google-calendar'].join(',')).run()
    await requireIntegrationAccount(env, 'linked-account', { userId: 'owner', currentAccountId: null, providerId: 'google', scopes: INTEGRATION_SCOPES['google-calendar'] })
    await assert.rejects(requireIntegrationAccount(env, 'linked-account', { userId: 'foreign', currentAccountId: null, providerId: 'google', scopes: INTEGRATION_SCOPES['google-calendar'] }))
    assert.ok(!JSON.stringify(integration).includes('token'))
    const provider = { token: async (accountId: string) => { assert.equal(accountId, 'linked-account'); return 'token' } }
    const events = new Map<string, Record<string, unknown>>()
    let denyCalendar = false
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.hostname, 'www.googleapis.com')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer token')
      if (url.pathname.includes('/calendarList/')) return denyCalendar ? new Response(null, { status: 404 }) : Response.json({ accessRole: 'writer' })
      const payload = init?.body ? JSON.parse(String(init.body)) : null
      const id = init?.method === 'POST' ? payload.id : url.pathname.split('/').at(-1)!
      if (!init?.method || init.method === 'GET') return events.has(id) ? Response.json({ id, etag: `"${id}"`, ...events.get(id) }) : new Response(null, { status: 404 })
      assert.equal(url.searchParams.get('sendUpdates'), 'all')
      if (init?.method === 'DELETE') { events.delete(id); return new Response(null, { status: 204 }) }
      if (init?.method === 'POST') {
        if (events.has(id)) return new Response(null, { status: 409 })
        events.set(id, payload)
      } else {
        events.set(id, payload)
      }
      return Response.json({ id })
    })
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 1)
    const link = await db.prepare('SELECT * FROM google_calendar_event_links').first()
    assert.equal(link?.booking_id, bookingId)
    assert.equal(link?.request_id, 'thread')
    const event = events.get(String(link?.event_id))!
    assert.equal(event.summary, 'Pending consultation')
    assert.deepEqual(event.start, { dateTime: '2099-11-01T14:00:00.000Z', timeZone: 'America/New_York' })
    assert.deepEqual(event.attendees, [{ email: 'private@example.test', responseStatus: 'needsAction' }, { email: 'host@example.test', responseStatus: 'needsAction' }])
    assert.equal(event.description, 'Status: pending\nAttorney: Host')
    assert.ok(!JSON.stringify(event).includes('PRIVATE MATTER'))
    assert.equal(event.guestsCanModify, false)
    assert.equal(event.guestsCanInviteOthers, false)
    assert.equal(event.guestsCanSeeOtherGuests, false)
    assert.ok(!JSON.stringify(event).includes('Jane Doe'))
    await setBookingStatus(db, { organizationId: 'org', bookingId, status: 'confirmed' })
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 1)
    assert.equal(events.get(String(link?.event_id))?.summary, 'Consultation')
    // A consultation given to another team member updates the same event to name them.
    await db.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('member-owner','org','owner','owner',?)").bind(Date.now()).run()
    await db.prepare("UPDATE product_booking_configs SET assigned_member_id='member-owner' WHERE product_id='p'").run()
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 1)
    assert.equal(events.get(String(link?.event_id))?.description, 'Status: confirmed\nAttorney: Owner')
    await db.prepare("UPDATE product_booking_configs SET assigned_member_id=NULL WHERE product_id='p'").run()
    assert.equal((await syncCalendarOrganization(env, 'org', 25, provider)).failed, 1, 'missing attorney identity is a visible failure, never a fabricated invitation')
    await db.prepare("UPDATE product_booking_configs SET assigned_member_id='host-org' WHERE product_id='p'").run()
    await setBookingStatus(db, { organizationId: 'org', bookingId, status: 'cancelled' })
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal(events.size, 0, 'a cancelled consultation leaves no event')
    assert.equal((await db.prepare('SELECT state FROM google_calendar_event_links').first())?.state, 'deleted')
    // Failed cleanup is retained even when Google answers 404 for lost access.
    await disconnectCalendar(db, 'org')
    // Cancelled subject was already deleted; create another real committed claim.
    const second = await claimSessionCapacity(db, { websiteSource: null, policyJson: OPEN_TERMS_JSON, env, organizationId: 'org', productId: 'p', sessionId: 's', productVariantId: 'v', partySize: 1 })
    await syncCalendarOrganization(env, 'org', 25, provider)
    assert.equal((await readCalendarIntegration(db, 'org'))?.status, 'disabled')
    assert.equal((await db.prepare("SELECT measurement_id FROM organization_integrations WHERE organization_id='org' AND provider='google_analytics'").first())?.measurement_id, 'G-123')
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
    assert.equal((await runCalendarCleanupJobs(env, 25, provider)).failed, 0)
    assert.equal(events.size, 0)
    assert.ok((await db.prepare('SELECT completed_at FROM google_calendar_cleanup_jobs').first())?.completed_at)
    assert.ok(await db.prepare("SELECT id FROM organization WHERE id='other'").first())

  } finally { await mf.dispose() }
})



test('experience and dining Calendar management links follow canonical buyer ownership without sharing guest capabilities', { timeout: 120_000 }, async t => {
  const runtime = new Miniflare({ workers: [{ config: { name:'calendar-management-proof', compatibilityDate:'2024-11-01', manifest:{mainModule:'index.mjs',modules:{'index.mjs':{type:'esm',contents:'export default {fetch(){return new Response("ok")}}'}}}, env:{DB:{type:'d1'}} } }] })
  try {
    const db=await runtime.getD1Database('DB')
    await applySchema(db)
    await db.prepare("INSERT INTO organization(id,name,slug,default_currency,timezone) VALUES('org','Org','org','USD','UTC')").run()
    await db.prepare("INSERT INTO user(id,name,email,emailVerified) VALUES('buyer','Buyer','buyer@example.test',1),('other-buyer','Other','other@example.test',1)").run()
    await db.prepare("INSERT INTO business_locations(id,organization_id,slug,title,timezone,status,opening_hours) VALUES('dining','org','dining','Dining','UTC','active','{\"periods\":[{\"open\":{\"day\":0,\"hour\":0,\"minute\":0}}]}')").run()
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('experience','experience','org','Pottery class','pottery','actor','actor')").run()
    await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,duration_minutes,held_online,scheduling_mode,confirmation_mode,created_by,updated_by) VALUES('experience','org','slot',30,0,'business','instant','actor','actor')").run()
    await db.prepare("INSERT INTO product_locations(organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES('org','experience','dining',1,1,'actor','actor')").run()
    await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('variant','org','experience','Seat','actor','actor')").run()
    await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,created_by,updated_by) VALUES('session','org','experience','dining','UTC','2099-11-01T14:00:00.000Z','2099-11-01T14:30:00.000Z',8,'actor','actor')").run()
    // The dining room's tables are a product of their own, booked the same way.
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('table','tables','org','Dining tables','tables','actor','actor')").run()
    await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,duration_minutes,held_online,scheduling_mode,confirmation_mode,created_by,updated_by) VALUES('tables','org','slot',60,0,'business','instant','actor','actor')").run()
    await db.prepare("INSERT INTO product_locations(organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES('org','tables','dining',1,1,'actor','actor')").run()
    await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('table-variant','org','tables','Table','actor','actor')").run()
    await db.prepare("INSERT INTO product_sessions(id,organization_id,product_id,location_id,timezone,starts_at,ends_at,capacity,created_by,updated_by) VALUES('seating','org','tables','dining','UTC','2099-11-02T14:00:00.000Z','2099-11-02T15:00:00.000Z',10,'actor','actor')").run()
    for (const id of ['experience-thread','dining-thread','stay-thread']) await db.prepare(`INSERT INTO conversations(id,kind,organization_id,user_id,payload_json,last_message_at) VALUES(?,'booking','org','buyer','{"guest":{"name":"Buyer","email":"buyer@example.test","phone":null},"notes":"PRIVATE NOTES","cancellation":{"token_hash":"PRIVATE_CAPABILITY","expires_at":null,"used_at":null}}','2099-01-01T00:00:00.000Z')`).bind(id).run()
    // A home booked by the night is a booking too: its check-in at the home's time, its checkout a day alone where the home has no checkout time.
    await db.prepare("INSERT INTO products(kind,id,organization_id,name,slug,created_by,updated_by) VALUES('stay','home','org','Garden house','garden-house','actor','actor')").run()
    await db.prepare("INSERT INTO product_locations(organization_id,product_id,location_id,active,published,created_by,updated_by) VALUES('org','home','dining',1,1,'actor','actor')").run()
    await db.prepare("INSERT INTO product_stay_configs(product_id,organization_id,location_id,internal_name,created_by,updated_by) VALUES('home','org','dining','Garden house','actor','actor')").run()
    await db.prepare("INSERT INTO product_booking_configs(product_id,organization_id,unit,default_capacity,min_nights,check_in_time,held_online,scheduling_mode,confirmation_mode,created_by,updated_by) VALUES('home','org','nights',4,1,'15:00',0,'business','instant','actor','actor')").run()
    await db.prepare("INSERT INTO product_variants(id,organization_id,product_id,name,created_by,updated_by) VALUES('home-variant','org','home','Night','actor','actor')").run()
    await db.prepare(`INSERT INTO bookings(id,organization_id,user_id,product_id,product_variant_id,location_id,starts_at,ends_at,timezone,party_size,adults,children,infants,status,policy_json,total_minor,currency)
      VALUES('stay','org','buyer','home','home-variant','dining','2099-11-05T15:00:00.000Z','2099-11-08','UTC',2,2,0,0,'confirmed',?,90000,'USD')`).bind(OPEN_TERMS_JSON).run()
    const env={DB:db,NUXT_PUBLIC_PLATFORM_DOMAIN:'http://localhost:3113'} as CloudflareEnv
    await nameConversationBooking(db, 'stay-thread', 'stay')
    await nameConversationBooking(db, 'experience-thread', (await claimSessionCapacity(db, { websiteSource: null, policyJson: OPEN_TERMS_JSON, env,organizationId:'org',productId:'experience',sessionId:'session',productVariantId:'variant',partySize:1,userId:'buyer'})).bookingId)
    await nameConversationBooking(db, 'dining-thread', (await claimSessionCapacity(db, { websiteSource: null, policyJson: OPEN_TERMS_JSON, env,organizationId:'org',productId:'tables',sessionId:'seating',productVariantId:'table-variant',partySize:2,userId:'buyer'})).bookingId)
    await storeCalendarSelection(db,'org',{account_id:'linked',calendar_id:'managed',calendar_name:'Calendar'})
    const provider={token:async()=> 'token'}
    const events=new Map<string,Record<string,unknown>>()
    let inserts=0
    t.mock.method(globalThis,'fetch',async(input,init)=>{
      const url=new URL(String(input));const method=init?.method??'GET'
      if(url.pathname.includes('/calendarList/')) return Response.json({accessRole:'writer'})
      const payload=init?.body?JSON.parse(String(init.body)):null
      const id=method==='POST'?payload.id:url.pathname.split('/').at(-1)!
      if(method==='GET') return events.has(id)?Response.json(events.get(id)):new Response(null,{status:404})
      assert.equal(url.searchParams.get('sendUpdates'),'all')
      if(method==='POST') inserts++
      if(method==='PUT') assert.equal(new Headers(init?.headers).get('If-Match'),events.get(id)?.etag)
      const event={...payload,id,etag:`"${id}"`}
      events.set(id,event)
      return Response.json(event)
    })
    assert.equal((await syncCalendarOrganization(env,'org',25,provider)).failed,0)
    assert.equal(events.size,3)
    const links=(await db.prepare('SELECT request_id,event_id FROM google_calendar_event_links ORDER BY request_id').all()).results
    assert.deepEqual(links.map(link=>link.request_id),['dining-thread','experience-thread','stay-thread'])
    for(const link of links) {
      // A table is still a reservation to its guest, a home a stay; every visit is managed at its booking.
      const word=link.request_id==='dining-thread'?'reservation':link.request_id==='stay-thread'?'stay':'booking'
      const event=events.get(String(link.event_id))!
      assert.ok(String(event.description).endsWith(`Manage ${word}: http://localhost:3113/dashboard/account/messages/${link.request_id}/reservation`))
      assert.equal(event.attendees,undefined,'this link does not introduce consultation attendee semantics to other verticals')
      assert.ok(!JSON.stringify(event).includes('PRIVATE_'))
      assert.ok(!JSON.stringify(event).includes('PRIVATE NOTES'))
      assert.ok(!JSON.stringify(event).includes('/dashboard/org/'))
    }
    const stayEvent=events.get(String(links.find(link=>link.request_id==='stay-thread')!.event_id))!
    assert.equal(stayEvent.summary,'Stay — Buyer')
    assert.deepEqual([stayEvent.start,stayEvent.end],[{date:'2099-11-05'},{date:'2099-11-08'}],'a checkout with no time spans whole days to the checkout day')
    const identities=[...events.keys()]
    await db.prepare("UPDATE conversations SET user_id='other-buyer' WHERE id IN ('experience-thread','dining-thread','stay-thread')").run()
    assert.equal((await syncCalendarOrganization(env,'org',25,provider)).failed,0)
    for(const event of events.values()) assert.ok(!String(event.description).includes('Manage '),'a request/commitment ownership mismatch removes an unusable management link')
    await db.prepare("UPDATE conversations SET user_id='buyer' WHERE id IN ('experience-thread','dining-thread','stay-thread')").run()
    assert.equal((await syncCalendarOrganization(env,'org',25,provider)).failed,0)
    assert.deepEqual([...events.keys()],identities,'ownership eligibility reconciles existing event identities')
    assert.equal(inserts,3,'eligible management links update existing events instead of duplicating them')
    for(const event of events.values()) assert.ok(String(event.description).includes('/dashboard/account/messages/'))
  } finally {await runtime.dispose()}
})
