import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { hashPassword } from 'better-auth/crypto'
import sharp from 'sharp'
import * as schema from '../../server/db/schema.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import createHomeRoute from '../../server/api/dashboard/stay-homes/index.post.ts'
import listHomesRoute from '../../server/api/dashboard/stay-homes/index.get.ts'
import updateHomeRoute from '../../server/api/dashboard/stay-homes/[productId].patch.ts'
import addPhotoRoute from '../../server/api/dashboard/stay-homes/[productId]/photos/index.post.ts'
import orderPhotosRoute from '../../server/api/dashboard/stay-homes/[productId]/photos/index.put.ts'
import describePhotoRoute from '../../server/api/dashboard/stay-homes/[productId]/photos/[photoId].patch.ts'
import removePhotoRoute from '../../server/api/dashboard/stay-homes/[productId]/photos/[photoId].delete.ts'
import createRoomRoute from '../../server/api/dashboard/stay-homes/[productId]/rooms/index.post.ts'
import updateRoomRoute from '../../server/api/dashboard/stay-homes/[productId]/rooms/[roomId].patch.ts'
import { getProduct, hydrateProductMedia } from '../../server/utils/product-management.ts'
import publicShellRoute from '../../server/api/public/shell.get.ts'
import type { StayPhotoRoom } from '../../shared/stay-photos.ts'

// A home's photos are its product's media: the product image is the cover and
// the gallery follows. The native app's routes order, describe and remove them
// as one list, each change read back through the product the pages render.
// The photos placed before these routes run are library media placed on the
// product the way the dashboard and MCP place them.

const ORG = 'org'
const BASE = 'https://proof.example'
const PASSWORD = 'StayHomePhotos123!'

test('a home authors room details and manages its product photos through authenticated native routes', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'stay-home-photos-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, ORGANIZATION_CACHE: { type: 'kv' }, MEDIA_BUCKET: { type: 'r2' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'stay-home-photos-proof', exportName: 'Hub' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))
    await db.batch(statements.map(statement => db.prepare(statement)))
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Org', 'org', 'org', '{}', 'saya-theme-v1', 'USD', 'active', 'active', 'flat', 'lodging', '2026-10-15T00:00:00.000Z', 'America/Denver')`).bind(ORG).run()
    await db.prepare("INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('source-en', ?, 'en', 1, 'published')").bind(ORG).run()
    for (const [id, role] of [['owner', 'owner'], ['helper', 'member']] as const) {
      await db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)').bind(id, id, `${id}@proof.example`).run()
      await db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, 0)').bind(`m-${id}`, ORG, id, role).run()
      await db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, 0, 0)").bind(`a-${id}`, id, id, await hashPassword(PASSWORD)).run()
    }
    const env = {
      ...await runtime.getBindings<CloudflareEnv>(), DB: db, BETTER_AUTH_SECRET: 'stay-home-photos-secret-long-enough-for-auth', BETTER_AUTH_URL: BASE, NUXT_PUBLIC_PLATFORM_DOMAIN: BASE,
      STRIPE_SECRET_KEY: 'sk_test_stay_home_photos_no_provider_requests', EMAIL_DELIVERY_MODE: 'log_only', WHATSAPP_DELIVERY_MODE: 'log_only',
      MEDIA_BASE_URL: 'https://media.proof.example',
    } as CloudflareEnv
    const cookieFor = async (id: string) => {
      const login = await createAuth(env).api.signInEmail({ body: { email: `${id}@proof.example`, password: PASSWORD }, asResponse: true })
      assert.equal(login.status, 200)
      return login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    }
    const app = new H3()
    app.use(event => { if (new URL(event.req.url).pathname === '/api/public/shell') event.context.organizationId = ORG })
    app.get('/api/public/shell', publicShellRoute)
    app.post('/api/dashboard/stay-homes', createHomeRoute)
    app.get('/api/dashboard/stay-homes', listHomesRoute)
    app.patch('/api/dashboard/stay-homes/:productId', updateHomeRoute)
    app.post('/api/dashboard/stay-homes/:productId/photos', addPhotoRoute)
    app.put('/api/dashboard/stay-homes/:productId/photos', orderPhotosRoute)
    app.patch('/api/dashboard/stay-homes/:productId/photos/:photoId', describePhotoRoute)
    app.delete('/api/dashboard/stay-homes/:productId/photos/:photoId', removePhotoRoute)
    app.post('/api/dashboard/stay-homes/:productId/rooms', createRoomRoute)
    app.patch('/api/dashboard/stay-homes/:productId/rooms/:roomId', updateRoomRoute)
    const call = async (cookie: string, method: string, path: string, body?: Record<string, unknown> | FormData) => {
      const json = body !== undefined && !(body instanceof FormData)
      const response = await app.request(Object.assign(new Request(`${BASE}/api/dashboard/stay-homes${path}?org=org`, {
        method, headers: { cookie, origin: BASE, ...(json ? { 'content-type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: json ? JSON.stringify(body) : body }),
      }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    const refusal = (result: { status: number; body: Record<string, unknown> }) => ({ status: result.status, ...(result.body.data as Record<string, unknown>) })
    const owner = await cookieFor('owner')

    const created = await call(owner, 'POST', '', {
      idempotency_key: 'cabin', name: 'Cliff Cabin', timezone: 'America/Denver', address: '1 Cliff Rd', city: 'Moab', state: 'UT', country: 'US', zip_code: '84532',
      phone: '+14355550100', email: 'host@example.test', check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2,
    })
    assert.equal(created.status, 201)
    const productId = (created.body.home as { product_id: string }).product_id
    assert.deepEqual((created.body.home as { photos: unknown[] }).photos, [])

    // Native Home updates must complete their Location's visibility change,
    // including a public shell already cached by an earlier guest request.
    const locationId = (created.body.home as { location_id: string }).location_id
    const shell = () => app.request(Object.assign(new Request('https://org.proof.example/api/public/shell', { headers: { host: 'org.proof.example' } }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    const initialShell = await shell()
    assert.equal(initialShell.status, 200, await initialShell.clone().text())
    assert.equal(initialShell.headers.get('x-bootstrap-cache'), 'MISS')
    const cachedShell = await shell()
    assert.equal(cachedShell.status, 200, await cachedShell.clone().text())
    assert.equal(cachedShell.headers.get('x-bootstrap-cache'), 'HIT')
    assert.equal((await cachedShell.json() as { locations: Array<{ id: string; stay_map_sharing: string }> }).locations.find(location => location.id === locationId)?.stay_map_sharing, 'general')
    const changedPrivacy = await call(owner, 'PATCH', `/${productId}`, { stay_map_sharing: 'specific' })
    assert.equal(changedPrivacy.status, 200, JSON.stringify(changedPrivacy.body))
    assert.equal(await db.prepare('SELECT stay_map_sharing FROM business_locations WHERE id = ? AND organization_id = ?').bind(locationId, ORG).first('stay_map_sharing'), 'specific')
    const changedShell = await shell()
    assert.equal(changedShell.status, 200, await changedShell.clone().text())
    assert.equal(changedShell.headers.get('x-bootstrap-cache'), 'MISS')
    assert.equal((await changedShell.json() as { locations: Array<{ id: string; stay_map_sharing: string; address: unknown }> }).locations.find(location => location.id === locationId)?.stay_map_sharing, 'specific')
    const recachedShell = await shell()
    assert.equal(recachedShell.status, 200, await recachedShell.clone().text())
    assert.equal(recachedShell.headers.get('x-bootstrap-cache'), 'HIT')
    const publicLocation = (await recachedShell.json() as { locations: Array<{ id: string; stay_map_sharing: string; address: unknown }> }).locations.find(location => location.id === locationId)
    assert(publicLocation)
    assert.equal(publicLocation.stay_map_sharing, 'specific')
    assert.equal(publicLocation.address, null)

    const now = '2026-10-15T00:00:00.000Z'
    for (const id of ['deck', 'kitchen', 'bedroom']) {
      await db.prepare(`INSERT INTO media_assets (id, organization_id, kind, provider, source, public_url, mime_type, width, height, alt_text, status, created_at, updated_at)
        VALUES (?, ?, 'image', 'cloudflare_images', 'uploaded', ?, 'image/jpeg', 1600, 1200, NULL, 'active', ?, ?)`).bind(id, ORG, `https://imagedelivery.net/acct/${id}/public`, now, now).run()
    }
    for (const [slot, asset, order] of [['image', 'deck', 0], ['gallery', 'kitchen', 0], ['gallery', 'bedroom', 1]] as const) {
      await db.prepare(`INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status, created_at, updated_at)
        VALUES (?, ?, 'product', ?, ?, ?, ?, 'active', ?, ?)`).bind(`p-${asset}`, ORG, productId, slot, asset, order, now, now).run()
    }
    // The product as its pages read it: the image is the cover, the gallery follows.
    const rendered = async () => (await hydrateProductMedia(db, ORG, [await getProduct(db, ORG, productId)]))[0]!
    const photo = (id: string, position: number, alt_text: string | null = null) => ({ id, kind: 'image', url: `https://imagedelivery.net/acct/${id}/public`, width: 1600, height: 1200, alt_text, position })
    const homes = async () => (await call(owner, 'GET', '')).body.homes as Array<{ photos: unknown[] }>
    assert.deepEqual((await homes())[0]!.photos, [photo('deck', 0), photo('kitchen', 1), photo('bedroom', 2)])

    // The room allocates the explicitly declared listing inventory; neither
    // its photos nor its sleeping arrangements create a listing bed total.
    const declaredBeds = await call(owner, 'PATCH', `/${productId}`, { beds: 2 })
    assert.equal(declaredBeds.status, 200, JSON.stringify(declaredBeds.body))
    assert.equal((await getProduct(db, ORG, productId)).stay?.beds, 2)
    const createdRoom = await call(owner, 'POST', `/${productId}/rooms`, { type: 'bedroom' })
    assert.equal(createdRoom.status, 201, JSON.stringify(createdRoom.body))
    const roomId = (createdRoom.body.room as StayPhotoRoom).id
    assert.equal(typeof roomId, 'string')
    const unansweredRoom: StayPhotoRoom = { id: roomId, type: 'bedroom', photo_ids: [], details_version: 1, sleeping_arrangements: null, private_attached_bathroom: null }
    assert.deepEqual(createdRoom.body.room, unansweredRoom)
    assert.deepEqual((await getProduct(db, ORG, productId)).stay?.photo_rooms, [unansweredRoom])

    const roomDetails = await call(owner, 'PATCH', `/${productId}/rooms/${roomId}`, { expected_details_version: 1, sleeping_arrangements: [{ type: 'queen', count: 2 }], private_attached_bathroom: false })
    assert.equal(roomDetails.status, 200, JSON.stringify(roomDetails.body))
    const authoredRoom: StayPhotoRoom = { ...unansweredRoom, details_version: 2, sleeping_arrangements: [{ type: 'queen', count: 2 }], private_attached_bathroom: false }
    assert.deepEqual(roomDetails.body.room, authoredRoom)
    assert.deepEqual((await getProduct(db, ORG, productId)).stay?.photo_rooms, [authoredRoom])
    const storedDetails = await db.prepare('SELECT details_version, sleeping_arrangements, private_attached_bathroom FROM product_stay_photo_rooms WHERE organization_id = ? AND product_id = ? AND id = ?').bind(ORG, productId, roomId).first()
    assert.deepEqual(storedDetails, { details_version: 2, sleeping_arrangements: '[{"type":"queen","count":2}]', private_attached_bathroom: 0 })

    // A stale editor cannot replace either field, including an explicit false.
    assert.deepEqual(refusal(await call(owner, 'PATCH', `/${productId}/rooms/${roomId}`, { expected_details_version: 1, sleeping_arrangements: [{ type: 'single', count: 1 }], private_attached_bathroom: true })), { status: 409, code: 'ROOM_DETAILS_CHANGED', field: 'expected_details_version' })
    assert.deepEqual(await db.prepare('SELECT details_version, sleeping_arrangements, private_attached_bathroom FROM product_stay_photo_rooms WHERE organization_id = ? AND product_id = ? AND id = ?').bind(ORG, productId, roomId).first(), storedDetails)
    assert.deepEqual((await getProduct(db, ORG, productId)).stay?.photo_rooms, [authoredRoom])
    assert.deepEqual(refusal(await call(owner, 'PATCH', `/${productId}/rooms/${roomId}`, { expected_details_version: 2, private_attached_bathroom: 'false' })), { status: 422, code: 'INVALID_ROOM_DETAILS', field: 'private_attached_bathroom' })

    const noBeds = await call(owner, 'PATCH', `/${productId}/rooms/${roomId}`, { expected_details_version: 2, sleeping_arrangements: [] })
    assert.equal(noBeds.status, 200, JSON.stringify(noBeds.body))
    const emptyRoom: StayPhotoRoom = { ...authoredRoom, details_version: 3, sleeping_arrangements: [] }
    assert.deepEqual(noBeds.body.room, emptyRoom)
    assert.deepEqual((await getProduct(db, ORG, productId)).stay?.photo_rooms, [emptyRoom])
    assert.deepEqual(await db.prepare('SELECT sleeping_arrangements, private_attached_bathroom FROM product_stay_photo_rooms WHERE organization_id = ? AND product_id = ? AND id = ?').bind(ORG, productId, roomId).first(), { sleeping_arrangements: '[]', private_attached_bathroom: 0 })

    const clearedDetails = await call(owner, 'PATCH', `/${productId}/rooms/${roomId}`, { expected_details_version: 3, sleeping_arrangements: null, private_attached_bathroom: null })
    assert.equal(clearedDetails.status, 200, JSON.stringify(clearedDetails.body))
    const clearedRoom: StayPhotoRoom = { ...unansweredRoom, details_version: 4 }
    assert.deepEqual(clearedDetails.body.room, clearedRoom)
    assert.deepEqual((await getProduct(db, ORG, productId)).stay?.photo_rooms, [clearedRoom])
    assert.deepEqual(await db.prepare('SELECT sleeping_arrangements, private_attached_bathroom FROM product_stay_photo_rooms WHERE organization_id = ? AND product_id = ? AND id = ?').bind(ORG, productId, roomId).first(), { sleeping_arrangements: null, private_attached_bathroom: null })
    assert.equal(await db.prepare('SELECT beds FROM product_stay_configs WHERE organization_id = ? AND product_id = ?').bind(ORG, productId).first('beds'), 2)

    // Ordering makes the first photo the cover; the product the pages render agrees.
    const ordered = await call(owner, 'PUT', `/${productId}/photos`, { photo_ids: ['bedroom', 'deck', 'kitchen'] })
    assert.equal(ordered.status, 200)
    assert.deepEqual((ordered.body.home as { photos: unknown[] }).photos, [photo('bedroom', 0), photo('deck', 1), photo('kitchen', 2)])
    const product = await rendered()
    assert.deepEqual([product.image?.asset_id, product.gallery.map(asset => asset.asset_id)], ['bedroom', ['deck', 'kitchen']])
    assert.deepEqual((await homes())[0]!.photos, [photo('bedroom', 0), photo('deck', 1), photo('kitchen', 2)])

    // An order from a stale read, or one that is not every photo once, changes nothing.
    assert.deepEqual(refusal(await call(owner, 'PUT', `/${productId}/photos`, { photo_ids: ['deck', 'kitchen'] })), { status: 409, code: 'PHOTOS_CHANGED', field: 'photo_ids' })
    assert.deepEqual(refusal(await call(owner, 'PUT', `/${productId}/photos`, { photo_ids: ['deck', 'deck', 'kitchen'] })), { status: 422, code: 'INVALID_PHOTO_ORDER', field: 'photo_ids' })
    assert.deepEqual(refusal(await call(owner, 'PUT', `/${productId}/photos`, { photo_ids: 'deck' })), { status: 422, code: 'INVALID_PHOTO_ORDER', field: 'photo_ids' })

    // Alt text is the asset's own, so every page showing the photo has it.
    const described = await call(owner, 'PATCH', `/${productId}/photos/deck`, { alt_text: '  The deck at sunset ' })
    assert.equal(described.status, 200)
    assert.deepEqual((described.body.home as { photos: unknown[] }).photos[1], photo('deck', 1, 'The deck at sunset'))
    assert.equal((await rendered()).gallery[0]?.alt_text, 'The deck at sunset')
    assert.deepEqual(refusal(await call(owner, 'PATCH', `/${productId}/photos/deck`, { alt_text: ' ' })), { status: 422, code: 'INVALID_PHOTO_FIELD', field: 'alt_text' })
    assert.deepEqual(refusal(await call(owner, 'PATCH', `/${productId}/photos/deck`, { caption: 'x' })), { status: 422, code: 'INVALID_PHOTO_FIELD', field: 'caption' })
    assert.deepEqual(refusal(await call(owner, 'PATCH', `/${productId}/photos/absent`, { alt_text: 'x' })), { status: 404, code: 'PHOTO_NOT_FOUND', field: 'photo_id' })

    // Removing the cover makes the next photo the cover; the file stays in the library.
    const removed = await call(owner, 'DELETE', `/${productId}/photos/bedroom`)
    assert.equal(removed.status, 200)
    assert.deepEqual((removed.body.home as { photos: unknown[] }).photos, [photo('deck', 0, 'The deck at sunset'), photo('kitchen', 1)])
    assert.equal((await rendered()).image?.asset_id, 'deck')
    assert.equal(await db.prepare("SELECT status FROM media_assets WHERE id = 'bedroom'").first('status'), 'active')
    assert.deepEqual(refusal(await call(owner, 'DELETE', `/${productId}/photos/bedroom`)), { status: 404, code: 'PHOTO_NOT_FOUND', field: 'photo_id' })

    // A library append reads the current home rather than trusting a tab's
    // earlier cover choice. Existing cover/gallery placements survive it.
    const attached = await call(owner, 'POST', `/${productId}/photos`, { asset_id: 'bedroom' })
    assert.equal(attached.status, 201)
    assert.deepEqual([((await rendered()).image)?.asset_id, (await rendered()).gallery.map(asset => asset.asset_id)], ['deck', ['kitchen', 'bedroom']])
    assert.deepEqual((await homes())[0]!.photos, [photo('deck', 0, 'The deck at sunset'), photo('kitchen', 1), photo('bedroom', 2)])
    assert.deepEqual(refusal(await call(owner, 'POST', `/${productId}/photos`, { asset_id: 'bedroom' })), { status: 409, code: 'PHOTO_ALREADY_ADDED', field: 'asset_id' })
    assert.deepEqual(refusal(await call(owner, 'POST', `/${productId}/photos`, { asset_id: 'bedroom', caption: 'x' })), { status: 422, code: 'INVALID_PHOTO_FIELD', field: 'caption' })
    assert.deepEqual(refusal(await call(owner, 'POST', `/${productId}/photos`, { asset_id: 'absent' })), { status: 404, code: 'PHOTO_NOT_FOUND', field: 'asset_id' })
    assert.equal(await db.prepare("SELECT status FROM media_assets WHERE id = 'bedroom'").first('status'), 'active')
    assert.equal((await call(owner, 'DELETE', `/${productId}/photos/bedroom`)).status, 200)

    // Uploads refuse what is not a photo before anything is stored.
    const form = (part: Blob | string, name = 'image') => { const data = new FormData(); data.append(name, part, ...(typeof part === 'string' ? [] : ['notes.txt'] as [string])); return data }
    assert.deepEqual(refusal(await call(owner, 'POST', `/${productId}/photos`, form(new Blob(['not a photo'], { type: 'text/plain' })))), { status: 415, code: 'UNSUPPORTED_PHOTO_TYPE', field: 'image' })
    assert.deepEqual(refusal(await call(owner, 'POST', `/${productId}/photos`, form(new Blob([]), 'file'))), { status: 422, code: 'PHOTO_REQUIRED', field: 'image' })
    // JSON now explicitly accepts asset_id; a JSON file surrogate is invalid.
    assert.deepEqual(refusal(await call(owner, 'POST', `/${productId}/photos`, { image: 'x' })), { status: 422, code: 'PHOTO_REQUIRED', field: 'asset_id' })
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE organization_id = ?').bind(ORG).first('n'), 3)

    // Only managers change a home's photos.
    const helper = await cookieFor('helper')
    assert.deepEqual(refusal(await call(helper, 'PATCH', `/${productId}/rooms/${roomId}`, { expected_details_version: 4, private_attached_bathroom: true })), { status: 403, code: 'STAY_ROLE_REQUIRED' })
    assert.deepEqual((await getProduct(db, ORG, productId)).stay?.photo_rooms, [clearedRoom])
    assert.deepEqual(refusal(await call(helper, 'PUT', `/${productId}/photos`, { photo_ids: ['kitchen', 'deck'] })), { status: 403, code: 'STAY_ROLE_REQUIRED' })
    assert.deepEqual(refusal(await call(helper, 'DELETE', `/${productId}/photos/deck`)), { status: 403, code: 'STAY_ROLE_REQUIRED' })
    assert.deepEqual(refusal(await call(helper, 'POST', `/${productId}/photos`, { asset_id: 'bedroom' })), { status: 403, code: 'STAY_ROLE_REQUIRED' })
    assert.deepEqual((await homes())[0]!.photos, [photo('deck', 0, 'The deck at sunset'), photo('kitchen', 1)])

    // Multipart File remains a distinct input: the real AVIF bytes reach R2
    // unchanged and the appended photo is read independently through Product.
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#2563eb' } }).avif().toBuffer()
    const upload = new FormData()
    upload.append('image', new File([Uint8Array.from(bytes)], 'native-photo-proof.avif', { type: 'image/avif' }))
    const uploaded = await call(owner, 'POST', `/${productId}/photos`, upload)
    assert.equal(uploaded.status, 201)
    const uploadedId = (uploaded.body.home as { photos: Array<{ id: string }> }).photos.at(-1)!.id
    const uploadedProduct = await rendered()
    assert.deepEqual([uploadedProduct.image?.asset_id, uploadedProduct.gallery.map(asset => asset.asset_id)], ['deck', ['kitchen', uploadedId]])
    const stored = await db.prepare('SELECT r2_key, kind, mime_type, provider, status FROM media_assets WHERE id = ? AND organization_id = ?').bind(uploadedId, ORG).first<{ r2_key: string; kind: string; mime_type: string; provider: string; status: string }>()
    assert(stored)
    assert.partialDeepStrictEqual(stored, { kind: 'image', mime_type: 'image/avif', provider: 'cloudflare_r2', status: 'active' })
    const object = await env.MEDIA_BUCKET!.get(stored.r2_key)
    assert(object)
    assert.deepEqual(new Uint8Array(await object.arrayBuffer()), Uint8Array.from(bytes))
    assert.equal((await call(owner, 'DELETE', `/${productId}/photos/${uploadedId}`)).status, 200)
    assert.equal(await db.prepare('SELECT status FROM media_assets WHERE id = ?').bind(uploadedId).first('status'), 'active')
    assert.deepEqual((await homes())[0]!.photos, [photo('deck', 0, 'The deck at sunset'), photo('kitchen', 1)])
  } finally {
    await runtime.dispose()
  }
})
