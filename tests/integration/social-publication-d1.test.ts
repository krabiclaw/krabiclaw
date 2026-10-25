import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import sharp from 'sharp'
import { H3 } from 'nitro/h3'
import { HTTPError } from 'nitro'
import { handlePostsTools } from '../../server/utils/mcp-tools/posts.ts'
import type { McpExecutorContext } from '../../server/utils/mcp-tools/execution.ts'
import { MCP_ERROR } from '../../server/utils/mcp-protocol.ts'
import { linkedAccountAccessToken, type CloudflareEnv } from '../../server/utils/auth.ts'
import { createPost, deletePost, getPost, listPublicSocialPosts, postPayloadFingerprint, updatePost } from '../../server/utils/post-management.ts'
import { publishPost, reconcilePostPublication, type PublishTarget } from '../../server/utils/social-publication.ts'
import { listChannelPosts, getChannelPost, deleteChannelPost } from '../../server/utils/social-channel-posts.ts'
import { remainingMetaSubjectData } from '../../server/utils/integration-release.ts'
import { deleteIntegration, listIntegrations, readIntegration, storeIntegration } from '../../server/utils/organization-integrations.ts'
import { MetaGraphError, verifyMetaSignedRequest, configuredMetaApps } from '../../server/utils/meta-graph.ts'
import { instagramAccessToken, listMedia, readAccountInsights, readMediaInsights } from '../../server/utils/instagram.ts'
import { attachMediaPlacement } from '../../server/utils/media-placement.ts'
import { listLinkedFacebookPages, facebookPageToken } from '../../server/utils/facebook-pages.ts'
import deauthorizeCallback from '../../server/api/integrations/meta/deauthorize.post.ts'
import { loadInstagramInsights } from '../../server/utils/instagram-insights.ts'
import deleteCallback from '../../server/api/integrations/meta/data-deletion.post.ts'
import deletionStatus from '../../server/api/integrations/meta/data-deletion.get.ts'
import { createBlogPost, getBlogPost } from '../../server/utils/content/publishing.ts'
import { fetchTransformedImageAsDataUri } from '../../server/utils/og-image/fetch-image.ts'
import { renderOgImagePng } from '../../server/utils/og-image/render.ts'

/**
 * Publication, channel management and erasure against real local D1, with Meta and
 * Cloudflare Images replaced at their HTTP boundary by a fixture that behaves
 * like their documented primitives and records every request it receives.
 * The assertions read what the provider was sent and what D1 holds.
 */

const PAGE = '1205835975938850'
const IG = '17841401765050246'
const OTHER_PAGE = '1205835975938851'
const OTHER_IG = '17841401765050247'

type Fault = { match: (request: SeenRequest) => boolean; kind: 'dropped' | 'reject' | 'missing'; times: number }
interface SeenRequest { method: string; host: string; path: string; query: URLSearchParams; body: Record<string, string>; headers: Record<string, string> }

class FakeMeta {
  requests: SeenRequest[] = []
  faults: Fault[] = []
  counter = 0
  fbPosts = new Map<string, { published: boolean; message?: string; link?: string; attached: string[] }>()
  fbPhotos = new Map<string, string>()
  /** `publish` is Facebook's intent: a published upload, or a Reel session that was finished. */
  fbVideos = new Map<string, { ready: number; publish: boolean; published: boolean; postId: string | null; reel?: boolean; uploaded?: boolean }>()
  igContainers = new Map<string, { status: string; inProgressReads: number; children?: string[]; kind: string; url?: string; caption?: string }>()
  igMedia = new Map<string, { container: string }>()
  pagePosts: Array<Record<string, unknown>> = []
  igFeed: Array<Record<string, unknown>> = []
  igResponses = new Map<string, unknown>()
  assignedPageResponses = new Map<string, unknown>([['', { data: [{ id: PAGE, name: 'Krabi Claw', access_token: 'page-token' }] }]])

  fault(kind: Fault['kind'], match: Fault['match'], times = 1) { this.faults.push({ kind, match, times }) }
  sent(predicate: (request: SeenRequest) => boolean) { return this.requests.filter(predicate) }
  id(prefix: string) { this.counter += 1; return `${prefix}${this.counter}` }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const body: Record<string, string> = {}
    if (typeof init.body === 'string') for (const [key, value] of new URLSearchParams(init.body)) body[key] = value
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]))
    const request: SeenRequest = { method, host: url.hostname, path: url.pathname, query: url.searchParams, body, headers }
    this.requests.push(request)
    const fault = this.faults.find(candidate => candidate.times > 0 && candidate.match(request))
    if (fault) {
      fault.times -= 1
      if (fault.kind === 'dropped') throw new TypeError('Network connection lost')
      if (fault.kind === 'missing') return json({ error: { message: 'Unsupported get request. Object does not exist', code: 100, error_subcode: 33, fbtrace_id: 'trace-missing' } }, 400)
      return json({ error: { message: 'Invalid parameter', code: 100, fbtrace_id: 'trace-reject' } }, 400)
    }
    if (url.hostname === 'api.cloudflare.com') {
      const id = init.body instanceof FormData ? init.body.get('id') : this.id('img-')
      assert.equal(typeof id, 'string')
      return json({ success: true, result: { id } })
    }
    if (url.hostname === 'graph.facebook.com') return this.facebook(method, url.pathname.replace('/v25.0/', ''), url.searchParams, body)
    if (url.hostname === 'rupload.facebook.com') {
      const video = this.fbVideos.get(url.pathname.split('/').pop()!)
      if (!video?.reel || !headers.file_url || !headers.authorization?.startsWith('OAuth ')) return json({ error: { message: 'Invalid upload', code: 100, fbtrace_id: 'trace-upload' } }, 400)
      video.uploaded = true
      return json({ success: true })
    }
    if (url.hostname === 'graph.instagram.com') return this.instagram(method, url.pathname.replace('/v23.0/', ''), url.searchParams, body)
    throw new Error(`Unexpected request ${method} ${url}`)
  }

  facebook(method: string, path: string, query: URLSearchParams, body: Record<string, string>): Response {
    if (path === 'me/assigned_pages') {
      const cursor = query.get('after') ?? ''
      if (!this.assignedPageResponses.has(cursor)) throw new Error(`Unexpected assigned Pages cursor ${cursor}`)
      return json(this.assignedPageResponses.get(cursor))
    }
    if (method === 'POST' && path === `${PAGE}/photos`) { const id = this.id('photo-'); this.fbPhotos.set(id, body.url!); return json({ id }) }
    if (method === 'POST' && path === `${PAGE}/feed`) {
      const attached: string[] = Object.keys(body).filter(key => key.startsWith('attached_media')).sort().map(key => JSON.parse(body[key]!).media_fbid)
      // Production answered this on 2026-09-29 for photos a deleted unpublished post had carried.
      const invalid = attached.findIndex(photo => !this.fbPhotos.has(photo))
      if (invalid >= 0) return json({ error: { message: `(#100) Param attached_media[${invalid}][media_fbid] must be a valid media id`, code: 100, fbtrace_id: 'trace-100' } }, 400)
      const id = this.id(`${PAGE}_`)
      this.fbPosts.set(id, { published: body.published !== 'false', message: body.message, link: body.link, attached })
      return json({ id })
    }
    if (method === 'POST' && path === `${PAGE}/videos`) { const id = this.id('video-'); this.fbVideos.set(id, { ready: 1, publish: body.published !== 'false', published: false, postId: null }); return json({ id }) }
    if (method === 'POST' && path === `${PAGE}/video_reels`) {
      if (body.upload_phase === 'start') { const id = this.id('reel-'); this.fbVideos.set(id, { ready: 1, publish: false, published: false, postId: null, reel: true }); return json({ video_id: id, upload_url: `https://rupload.facebook.com/video-upload/v25.0/${id}` }) }
      const video = this.fbVideos.get(body.video_id ?? '')
      if (body.upload_phase !== 'finish' || !video?.reel || !video.uploaded || body.video_state !== 'PUBLISHED') return json({ error: { message: 'Invalid parameter', code: 100, fbtrace_id: 'trace-reel' } }, 400)
      // Production 2026-10-06: the finish answers with the Page post it made.
      video.publish = true
      video.postId = `${PAGE}_${body.video_id}`
      this.fbPosts.set(video.postId, { published: true, attached: [] })
      return json({ success: true, post_id: video.postId })
    }
    if (method === 'GET' && path === `${PAGE}/posts`) {
      const offset = Number(query.get('after') ?? 0)
      const limit = Number(query.get('limit'))
      const page = this.pagePosts.slice(offset, offset + limit)
      const next = offset + limit < this.pagePosts.length
      return json({ data: page, paging: next ? { cursors: { after: String(offset + limit) }, next: `https://graph.facebook.com/next?access_token=secret&after=${offset + limit}` } : { cursors: {} } })
    }
    const post = this.fbPosts.get(path)
    // Facebook does not publish an unpublished feed post later (production answered this on 2026-09-28).
    if (post && method === 'POST') return json({ error: { message: '(#10) Failed to publish post', code: 10, fbtrace_id: 'trace-10' } }, 400)
    if (post && method === 'GET') return json({ id: path, is_published: post.published, message: post.message, permalink_url: `https://www.facebook.com/${path}`, created_time: '2026-09-28T10:00:00+0000' })
    const video = this.fbVideos.get(path)
    if (video && method === 'GET') {
      if (query.get('fields')?.includes('source')) return json({ source: 'https://video.xx.fbcdn.net/v.mp4', picture: 'https://scontent.xx.fbcdn.net/poster.jpg', length: 12 })
      video.ready -= 1
      const ready = video.ready < 0
      // Facebook publishes a published upload or a finished Reel once processing completes.
      if (ready && video.publish && !video.published) { video.published = true; video.postId = `${PAGE}_${path}`; this.fbPosts.set(video.postId, { published: true, attached: [] }) }
      return json({ id: path, published: video.published, post_id: video.postId, permalink_url: video.reel ? `/reel/${path}/` : `/Krabi/videos/${path}/`,
        status: { video_status: ready ? 'ready' : 'processing', processing_phase: { status: ready ? 'complete' : 'in_progress' }, publishing_phase: { status: !video.publish ? 'not_started' : ready ? 'complete' : 'in_progress' } } })
    }
    // Meta offers no later publish of a video (production answered this on 2026-10-06 for a 9:16 upload it had stored as a Reel).
    if (video && method === 'POST') return json({ error: { message: '(#200) Permissions error', code: 200, fbtrace_id: 'trace-200' } }, 400)
    if (method === 'DELETE') { for (const photo of this.fbPosts.get(path)?.attached ?? []) this.fbPhotos.delete(photo); this.fbPosts.delete(path); this.fbPhotos.delete(path); return json({ success: true }) }
    const record = this.pagePosts.find(item => item.id === path)
    if (record) return json(record)
    return json({ error: { message: 'Unsupported get request. Object does not exist', code: 100, error_subcode: 33 } }, 400)
  }

  instagram(method: string, path: string, query: URLSearchParams, body: Record<string, string>): Response {
    if (method === 'GET' && this.igResponses.has(path)) return json(this.igResponses.get(path))
    if (method === 'POST' && path === `${IG}/media`) {
      const id = this.id('container-')
      const kind = body.media_type ?? 'IMAGE'
      this.igContainers.set(id, { status: this.expireNewContainers ? 'EXPIRED' : 'FINISHED', inProgressReads: kind === 'REELS' ? this.reelProcessingReads : 0, kind, url: body.image_url ?? body.video_url, caption: body.caption, children: body.children?.split(',') })
      return json({ id })
    }
    if (method === 'POST' && path === `${IG}/media_publish`) {
      const container = this.igContainers.get(body.creation_id!)
      if (!container || container.status !== 'FINISHED') return json({ error: { message: 'Media not ready', code: 9007 } }, 400)
      container.status = 'PUBLISHED'
      const id = this.id('ig-media-')
      this.igMedia.set(id, { container: body.creation_id! })
      return json({ id })
    }
    if (method === 'GET' && path === `${IG}/media`) {
      const offset = Number(query.get('after') ?? 0)
      const limit = Number(query.get('limit'))
      const next = offset + limit < this.igFeed.length
      return json({ data: this.igFeed.slice(offset, offset + limit), paging: next ? { cursors: { after: String(offset + limit) }, next: 'https://graph.instagram.com/next' } : { cursors: {} } })
    }
    const container = this.igContainers.get(path)
    if (container && method === 'GET') {
      if (container.inProgressReads > 0) { container.inProgressReads -= 1; return json({ status_code: 'IN_PROGRESS' }) }
      return json({ status_code: container.status })
    }
    if (this.igMedia.has(path)) return json({ id: path, permalink: `https://www.instagram.com/p/${path}/`, timestamp: '2026-09-28T10:00:00+0000', username: 'krabiclaw' })
    if (method === 'GET' && path === `${IG}/insights`) return json({ data: Object.entries(this.igInsights).map(([name, value]) => ({ name, period: 'day', total_value: { value } })) })
    if (method === 'GET' && path.endsWith('/insights') && this.igMediaInsights.has(path.slice(0, -'/insights'.length))) {
      return json({ data: Object.entries(this.igMediaInsights.get(path.slice(0, -'/insights'.length))!).map(([name, value]) => ({ name, period: 'lifetime', values: [{ value }] })) })
    }
    const record = this.igFeed.find(item => item.id === path)
    if (record) return json(record)
    return json({ error: { message: 'Object does not exist', code: 100, error_subcode: 33 } }, 400)
  }
  igInsights: Record<string, number> = {}
  igMediaInsights = new Map<string, Record<string, number>>()
  reelProcessingReads = 0
  expireNewContainers = false
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

async function setUp() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'social-publication-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' }, MEDIA_BUCKET: { type: 'r2' }, IMAGES: { type: 'images' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  const journal = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')) as { entries: { tag: string }[] }
  for (const { tag } of journal.entries) {
    for (const statement of readFileSync(`migrations/${tag}.sql`, 'utf8').split('--> statement-breakpoint').map(sql => sql.trim()).filter(Boolean)) await db.prepare(statement).run()
  }
  const env = {
    ...await runtime.getBindings<CloudflareEnv>(),
    BETTER_AUTH_SECRET: 'local-proof-secret-long-enough-for-auth', BETTER_AUTH_URL: 'https://proof.example', STRIPE_SECRET_KEY: 'sk_test_local_d1_no_stripe_requests',
    NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://proof.example', PREVIEW_SECRET: 'preview-proof-secret',
    FACEBOOK_APP_ID: 'fb-app', FACEBOOK_APP_SECRET: 'facebook-secret', INSTAGRAM_APP_ID: 'ig-app', INSTAGRAM_APP_SECRET: 'instagram-secret',
    CF_ACCOUNT_ID: 'cf-proof', CLOUDFLARE_IMAGES_API_TOKEN: 'cf-images-proof', CLOUDFLARE_IMAGES_VARIANT_BASE: 'https://imagedelivery.example.test/hash',
    MEDIA_BASE_URL: 'https://media.example.test',
  } as unknown as CloudflareEnv
  const later = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60
  const run = (sql: string) => db.prepare(sql).run()
  for (const organization of ['org-a', 'org-b']) {
    await run(`INSERT INTO organization (id, name, slug, subdomain, status, onboarding_status, default_currency, timezone) VALUES ('${organization}', '${organization}', '${organization}', '${organization}', 'active', 'active', 'USD', 'UTC')`)
    await run(`INSERT INTO organization_domains (id, organization_id, domain, type, role, status) VALUES ('domain-${organization}', '${organization}', '${organization}.krabiclaw.test', 'subdomain', 'canonical', 'active')`)
    await run(`INSERT INTO organization_locales (id, organization_id, locale, is_source, status) VALUES ('${organization}-en', '${organization}', 'en', 1, 'published')`)
    await run(`INSERT INTO subscription (id, plan, referenceId, status) VALUES ('sub-${organization}', 'growth', '${organization}', 'active')`)
  }
  await run("INSERT INTO user (id, name, email) VALUES ('owner', 'Owner', 'owner@proof.example')")
  await run("INSERT INTO account (id, accountId, providerId, userId, accessToken) VALUES ('fb-account', 'fb-subject', 'facebook', 'owner', 'user-token')")
  await run(`INSERT INTO account (id, accountId, providerId, userId, accessToken, accessTokenExpiresAt) VALUES ('ig-account', 'ig-subject', 'instagram', 'owner', 'ig-token', ${later})`)
  // One person's linked accounts, two businesses: each organization has its own Page and professional account.
  for (const organization of ['org-a', 'org-b']) {
    const own = organization === 'org-a'
    await run(`INSERT INTO organization_integrations (id, organization_id, provider, account_id, target_id, target_name, revision, created_at, updated_at) VALUES ('fb-${organization}', '${organization}', 'facebook', 'fb-account', '${own ? PAGE : OTHER_PAGE}', 'Krabi Claw', 'fb-rev-${organization}', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z'),
      ('ig-${organization}', '${organization}', 'instagram', 'ig-account', '${own ? IG : OTHER_IG}', 'krabiclaw', 'ig-rev-${organization}', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z')`)
  }
  const meta = new FakeMeta()
  const realFetch = globalThis.fetch
  globalThis.fetch = meta.fetch as typeof fetch
  const asset = async (id: string, mime: string, kind: 'image' | 'video' = 'image', dimensions: { width: number; height: number; duration: number } | null = null) => run(`INSERT INTO media_assets (id, organization_id, kind, provider, source, public_url, thumbnail_url, mime_type, file_size, width, height, duration)
    VALUES ('${id}', 'org-a', '${kind}', 'cloudflare_images', 'uploaded', 'https://imagedelivery.example.test/hash/${id}/public', ${kind === 'video' ? `'https://imagedelivery.example.test/hash/${id}-poster/public'` : 'NULL'}, '${mime}', 1000, ${dimensions?.width ?? 'NULL'}, ${dimensions?.height ?? 'NULL'}, ${dimensions ? dimensions.duration : kind === 'video' ? 20 : 'NULL'})`)
  // Ordinary publication cases run without production Images credentials, as
  // local development does. The card contract below uses the native binding.
  const { CLOUDFLARE_IMAGES_API_TOKEN: _token, ...cardless } = env as unknown as Record<string, unknown>
  return { runtime, db, env, cardless: cardless as unknown as CloudflareEnv, meta, run, asset, restore: () => { globalThis.fetch = realFetch } }
}

const targets = {
  website: { channel: 'organization' } as PublishTarget,
  facebook: (organization = 'org-a') => ({ channel: 'facebook', target_id: PAGE, connection_revision: `fb-rev-${organization}` }) as PublishTarget,
  instagram: (organization = 'org-a') => ({ channel: 'instagram', target_id: IG, connection_revision: `ig-rev-${organization}` }) as PublishTarget,
}

test('an AVIF article picture renders through native Images and a create replay repairs its failed social card', async () => {
  const { runtime, db, env, meta, asset, restore } = await setUp()
  try {
    const source = readFileSync(new URL('../../docs/marketing/publishing-assets/lodging-2026-10-23/new-home.avif', import.meta.url))
    const sourceUrl = 'https://imagedelivery.example.test/hash/avif-source/public'
    const images = await runtime.getImagesBinding('IMAGES')
    const uploads = new Map<string, Uint8Array>()
    let unavailable = false
    let cancelFailure = false
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.href === sourceUrl) {
        if (cancelFailure) return new Response(new ReadableStream({ cancel() { throw new Error('Image response cancellation refused') } }), { headers: { 'content-type': 'text/plain' } })
        return unavailable ? new Response('Picture unavailable', { headers: { 'content-type': 'text/plain' } })
          : new Response(source, { headers: { 'content-type': 'image/avif', 'content-length': String(source.byteLength) } })
      }
      if (uploads.has(url.href)) return new Response(init.method === 'HEAD' ? null : uploads.get(url.href), { headers: { 'content-type': 'image/png' } })
      if (url.hostname === 'api.cloudflare.com' && init.body instanceof FormData) {
        const file = init.body.get('file')
        assert(file instanceof Blob)
        const response = await meta.fetch(input, init)
        const uploaded = await response.clone().json() as { result: { id: string } }
        uploads.set(`https://imagedelivery.example.test/hash/${uploaded.result.id}/public`, new Uint8Array(await file.arrayBuffer()))
        return response
      }
      return meta.fetch(input, init)
    }
    cancelFailure = true
    await assert.rejects(fetchTransformedImageAsDataUri(images, sourceUrl, {}, { format: 'image/jpeg' }), /Image response cancellation refused/)
    cancelFailure = false
    const jpegUri = await fetchTransformedImageAsDataUri(images, sourceUrl, { width: 1200, height: 630, fit: 'cover' }, { format: 'image/jpeg', quality: 85 })
    assert(jpegUri?.startsWith('data:image/jpeg;base64,'))
    const jpeg = await sharp(Buffer.from(jpegUri.split(',')[1]!, 'base64')).raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([jpeg.info.width, jpeg.info.height], [1200, 630])
    const require = createRequire(import.meta.url)
    const png = await renderOgImagePng({ template: 'tenant', title: 'A home with an AVIF picture', organizationName: 'org-a', backgroundImageUrl: sourceUrl }, {
      images, publicOrigin: env.NUXT_PUBLIC_PLATFORM_DOMAIN!,
      wasmModule: await WebAssembly.compile(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'))),
      yogaModule: await WebAssembly.compile(readFileSync(require.resolve('satori/yoga.wasm'))),
    })
    const rendered = await sharp(png).raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([rendered.info.width, rendered.info.height], [1200, 630])

    await asset('avif-source', 'image/avif')
    const input = { idempotency_key: 'avif-article', title: 'A home with an AVIF picture', content_blocks: [{ type: 'image' as const, data: { caption: 'The actual new-home editor' }, media: [{ asset_id: 'avif-source', slot: 'media' }] }] }
    unavailable = true
    await assert.rejects(createBlogPost(db, 'owner', input, { organization_id: 'org-a' }, env), /OG page media could not be loaded/)
    const saved = await db.prepare("SELECT id, status, updated_at FROM content_documents WHERE organization_id = 'org-a' AND kind = 'article' AND row_role = 'root'").first<{ id: string; status: string; updated_at: string }>()
    assert(saved)
    assert.equal(saved.status, 'draft')
    await assert.rejects(createBlogPost(db, 'owner', input, { organization_id: 'org-a' }, env), /OG page media could not be loaded/)
    assert.equal(uploads.size, 0)
    unavailable = false
    const repaired = await createBlogPost(db, 'owner', input, { organization_id: 'org-a' }, env)
    assert.equal(repaired.id, saved.id)
    const read = await getBlogPost(db, saved.id, 'org-a', env)
    assert.deepEqual([read.status, read.updated_at], ['draft', saved.updated_at])
    const card = await db.prepare("SELECT ma.public_url, ma.mime_type, ma.width, ma.height FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id WHERE mp.owner_type = 'content_document' AND mp.owner_id = ? AND mp.slot = 'social_card' AND mp.status = 'active'").bind(saved.id).first<{ public_url: string; mime_type: string; width: number; height: number }>()
    assert(card)
    assert.deepEqual([card.mime_type, card.width, card.height], ['image/png', 1200, 630])
    const served = await fetch(card.public_url)
    assert.equal(served.status, 200)
    const decoded = await sharp(new Uint8Array(await served.arrayBuffer())).raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([decoded.info.width, decoded.info.height], [1200, 630])
    assert.equal((await createBlogPost(db, 'owner', input, { organization_id: 'org-a' }, env)).id, saved.id)
    assert.equal(uploads.size, 1, 'a completed replay reuses the one independently served card')
    assert.equal(await db.prepare("SELECT count(*) FROM content_documents WHERE organization_id = 'org-a' AND kind = 'article' AND row_role = 'root'").first('count(*)'), 1)
  } finally {
    restore()
    await runtime.dispose()
  }
})

test('publication: one result, one external post per target, and no blind resend under any fault', async () => {
  const { runtime, db, env, cardless, meta, run, asset, restore } = await setUp()
  try {
    await asset('a1', 'image/jpeg')
    await asset('a2', 'image/jpeg')
    await asset('a3', 'image/png')
    await asset('v1', 'video/mp4', 'video')
    const create = (key: string, post: Record<string, unknown>) => createPost(db, cardless, 'org-a', { post, idempotencyKey: key }, 'owner')
    // What a receipt claims, read back from the database and from the fake provider's own state.
    const publishedOnMeta = async (postId: string, channel: 'facebook' | 'instagram') => {
      const row = await db.prepare('SELECT state, provider_post_id FROM post_publications WHERE post_id = ? AND channel = ?').bind(postId, channel).first<{ state: string; provider_post_id: string | null }>()
      assert.equal(row?.state, 'published')
      assert.ok(row!.provider_post_id)
      if (channel === 'instagram') assert.ok(meta.igMedia.has(row!.provider_post_id!))
      else assert.equal(meta.fbPosts.get(row!.provider_post_id!)?.published ?? meta.fbVideos.get(row!.provider_post_id!)?.published, true)
    }

    // Creation is idempotent by key, and a reused key for other words conflicts.
    const first = await create('key-1', { body: 'Pizza night Friday', media: [{ asset_id: 'a1', slot: 'cover' }, { asset_id: 'a2', slot: 'gallery' }], call_to_action: { label: 'Book', url: 'https://example.test/book' } })
    assert.equal(first.replayed, false)
    assert.equal(first.post.status, 'draft')
    assert.equal(first.post.slug, 'pizza-night-friday')
    assert.match(first.post.preview_url ?? '', /^https:\/\/org-a\.krabiclaw\.test\/posts\/pizza-night-friday\?preview_token=/)
    assert.equal((await create('key-1', { body: 'Pizza night Friday', media: [{ asset_id: 'a1', slot: 'cover' }, { asset_id: 'a2', slot: 'gallery' }], call_to_action: { label: 'Book', url: 'https://example.test/book' } })).post.id, first.post.id)
    await assert.rejects(create('key-1', { body: 'Something else' }), /different post/)
    assert.equal(await db.prepare("SELECT count(*) FROM content_documents WHERE kind = 'social_post'").first('count(*)'), 1)
    // An empty draft exists and has a generated route, and cannot be published.
    const empty = await create('key-empty', {})
    assert.equal(empty.post.slug, `update-${empty.post.id}`)
    const emptyResult = await publishPost(env, 'org-a', empty.post.id, { expectedUpdatedAt: empty.post.updated_at, targets: [targets.website] }, 'owner')
    assert.deepEqual([emptyResult.ok, emptyResult.outcomes[0]!.code], [false, 'empty_post'])
    assert.deepEqual(await db.prepare('SELECT status, published_at FROM content_documents WHERE id = ?').bind(empty.post.id).first(), { status: 'draft', published_at: null })

    // Website, Facebook photos and an Instagram carousel in one call.
    const all = await publishPost(env, 'org-a', first.post.id, { expectedUpdatedAt: first.post.updated_at, targets: [targets.website, targets.facebook(), targets.instagram()] }, 'owner')
    assert.equal(all.ok, true, JSON.stringify(all.outcomes))
    assert.deepEqual(all.outcomes.map(outcome => [outcome.channel, outcome.status]), [['organization', 'published'], ['facebook', 'published'], ['instagram', 'published']])
    // What Facebook received: two unpublished photos in order, then one published post attaching them with the caption and link line.
    const photos = meta.sent(request => request.path.endsWith(`${PAGE}/photos`))
    assert.deepEqual(photos.map(request => [request.body.url, request.body.published]), [['https://imagedelivery.example.test/hash/a1/public', 'false'], ['https://imagedelivery.example.test/hash/a2/public', 'false']])
    const [feed] = meta.sent(request => request.path.endsWith(`${PAGE}/feed`))
    assert.equal(feed!.body.message, 'Pizza night Friday\n\nBook: https://example.test/book')
    assert.equal(feed!.body.published, undefined)
    assert.equal(feed!.body.link, undefined)
    assert.deepEqual([...meta.fbPosts.values()][0]!.attached, ['photo-1', 'photo-2'])
    assert.equal(meta.sent(request => request.body.is_published !== undefined).length, 0)
    // What Instagram received: two carousel children, one carousel container with the caption, one media_publish.
    const containers = meta.sent(request => request.method === 'POST' && request.path.endsWith(`${IG}/media`))
    assert.deepEqual(containers.map(request => [request.body.media_type ?? 'IMAGE', request.body.is_carousel_item ?? '', request.body.caption ?? '']), [
      ['IMAGE', 'true', ''], ['IMAGE', 'true', ''], ['CAROUSEL', '', 'Pizza night Friday\n\nBook: https://example.test/book'],
    ])
    assert.equal(meta.sent(request => request.path.endsWith('media_publish')).length, 1)
    const stored = await db.prepare("SELECT channel, state, provider_post_id, provider_permalink, attempt_id FROM post_publications WHERE post_id = ? ORDER BY channel").bind(first.post.id).all()
    assert.deepEqual(stored.results.map(row => [row.channel, row.state, row.attempt_id]), [['facebook', 'published', null], ['instagram', 'published', null]])

    // A repeat reads the receipts: nothing is sent again and the publication date stays.
    const requestCount = meta.requests.length
    const published = await getPost(db, env, 'org-a', first.post.id)
    const again = await publishPost(env, 'org-a', first.post.id, { expectedUpdatedAt: 'stale-token', targets: [targets.website, targets.facebook(), targets.instagram()] }, 'owner')
    assert.deepEqual(again.outcomes.map(outcome => outcome.status), ['already_published', 'already_published', 'already_published'])
    assert.equal(again.ok, true)
    assert.equal(meta.requests.filter(request => request.method !== 'GET').length, meta.requests.slice(0, requestCount).filter(request => request.method !== 'GET').length)
    assert.equal((await getPost(db, env, 'org-a', first.post.id))!.published_at, published!.published_at)
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE event_name = 'post.published'").first('count(*)'), 1)
    // The public projection carries only confirmed publications, with Meta's own links.
    const feedPage = await listPublicSocialPosts(env, db, 'org-a', { locale: 'en', window: { limit: 12, offset: 0 }, resource: 'r' })
    assert.deepEqual(feedPage.posts[0]!.publications, [{ channel: 'facebook', url: `https://www.facebook.com/${PAGE}_3`, account_name: 'Krabi Claw' }, { channel: 'instagram', url: `https://www.instagram.com/p/${[...meta.igMedia.keys()][0]}/`, account_name: 'krabiclaw' }])
    assert.deepEqual(feedPage.posts[0]!.media.map(item => item.asset_id), ['a1', 'a2'])
    // A post is published once per channel: another Page is a conflict.
    const elsewhere = await publishPost(env, 'org-a', first.post.id, { expectedUpdatedAt: published!.updated_at, targets: [{ channel: 'facebook', target_id: 'another-page', connection_revision: 'fb-rev-org-a' }] }, 'owner')
    assert.equal(elsewhere.outcomes[0]!.code, 'target_conflict')

    // A disconnected channel is skipped; the independent website target still publishes; ok is false.
    await run("DELETE FROM organization_integrations WHERE organization_id = 'org-a' AND provider = 'facebook'")
    const second = await create('key-2', { body: 'Text only' })
    const partial = await publishPost(env, 'org-a', second.post.id, { expectedUpdatedAt: second.post.updated_at, targets: [targets.website, targets.facebook()] }, 'owner')
    assert.deepEqual([partial.ok, partial.outcomes.map(outcome => `${outcome.status}:${outcome.code ?? ''}`)], [false, ['published:', 'skipped:not_connected']])
    assert.equal(await db.prepare('SELECT count(*) FROM post_publications WHERE post_id = ?').bind(second.post.id).first('count(*)'), 0)
    await run(`INSERT INTO organization_integrations (id, organization_id, provider, account_id, target_id, target_name, revision, created_at, updated_at) VALUES ('fb-org-a', 'org-a', 'facebook', 'fb-account', '${PAGE}', 'Krabi Claw', 'fb-rev-org-a', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z')`)
    // Instagram refuses a text-only post and a PNG before anything is sent; a changed connection is a conflict, not another account.
    const refused = await publishPost(env, 'org-a', second.post.id, { expectedUpdatedAt: (await getPost(db, env, 'org-a', second.post.id))!.updated_at, targets: [targets.instagram(), { ...targets.facebook(), connection_revision: 'old' } as PublishTarget] }, 'owner')
    assert.deepEqual(refused.outcomes.map(outcome => outcome.code), ['media_required', 'connection_changed'])
    const png = await create('key-png', { media: [{ asset_id: 'a3', slot: 'cover' }] })
    assert.match((await publishPost(env, 'org-a', png.post.id, { expectedUpdatedAt: png.post.updated_at, targets: [targets.instagram()] }, 'owner')).outcomes[0]!.message!, /JPEG images only; asset a3 is image\/png and has no JPEG rendition/)
    // A PNG held in Cloudflare Images is sent to Instagram as its JPEG rendition.
    await asset('a4', 'image/png')
    await run(`UPDATE media_assets SET cloudflare_image_id = 'cf-a4' WHERE id = 'a4'`)
    const rendered = await create('key-png-rendition', { media: [{ asset_id: 'a4', slot: 'cover' }] })
    assert.equal((await publishPost(env, 'org-a', rendered.post.id, { expectedUpdatedAt: rendered.post.updated_at, targets: [targets.instagram()] }, 'owner')).outcomes[0]!.status, 'published')
    assert.equal(meta.sent(request => request.method === 'POST' && request.path.endsWith('/media') && Boolean(request.body.image_url)).at(-1)!.body.image_url, 'https://imagedelivery.example.test/hash/cf-a4/format=jpeg')
    // Stale content for a new target.
    const stale = await publishPost(env, 'org-a', second.post.id, { expectedUpdatedAt: second.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.equal(stale.outcomes[0]!.code, 'stale_revision')

    // Definite rejection before the native draft: failed, then the corrected retry publishes once.
    const third = await create('key-3', { body: 'Rejected first', media: [{ asset_id: 'a1', slot: 'cover' }] })
    meta.fault('reject', request => request.path.endsWith(`${PAGE}/photos`))
    const rejected = await publishPost(env, 'org-a', third.post.id, { expectedUpdatedAt: third.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.deepEqual([rejected.ok, rejected.outcomes[0]!.status, rejected.outcomes[0]!.code], [false, 'failed', 'provider_rejected'])
    const retried = await publishPost(env, 'org-a', third.post.id, { expectedUpdatedAt: third.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.equal(retried.outcomes[0]!.status, 'published')
    await publishedOnMeta(third.post.id, 'facebook')

    // The final call's connection dropped before Facebook answered: unknown, never sent again; its photos stay saved.
    const fourth = await create('key-4', { body: 'Lost feed', media: [{ asset_id: 'a2', slot: 'cover' }] })
    meta.fault('dropped', request => request.path.endsWith(`${PAGE}/feed`))
    const lost = await publishPost(env, 'org-a', fourth.post.id, { expectedUpdatedAt: fourth.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.deepEqual([lost.ok, lost.outcomes[0]!.status, lost.outcomes[0]!.code], [false, 'unknown', 'final_unconfirmed'])
    const pinned = (await getPost(db, env, 'org-a', fourth.post.id))!
    await assert.rejects(updatePost(db, cardless, 'org-a', fourth.post.id, { changes: { body: 'Edited' }, expectedUpdatedAt: pinned.updated_at }, 'owner'), /unresolved/)
    await assert.rejects(deletePost(db, 'org-a', fourth.post.id, 'owner'), /unresolved/)
    const feedsBefore = meta.sent(request => request.path.endsWith(`${PAGE}/feed`)).length
    assert.equal((await publishPost(env, 'org-a', fourth.post.id, { expectedUpdatedAt: pinned.updated_at, targets: [targets.facebook()] }, 'owner')).outcomes[0]!.status, 'unknown')
    assert.equal(meta.sent(request => request.path.endsWith(`${PAGE}/feed`)).length, feedsBefore)

    // The final call took effect but its answer was lost: unknown until reconciliation is told the post it became, which it reads on the Page.
    const fifth = await create('key-5', { body: 'Answer lost' })
    let createdId: string | null = null
    meta.fault('dropped', request => {
      if (request.method !== 'POST' || !request.path.endsWith(`${PAGE}/feed`)) return false
      createdId = `${PAGE}_answer-lost`
      meta.fbPosts.set(createdId, { published: true, message: request.body.message, link: request.body.link, attached: [] })
      return true
    })
    const answerLost = await publishPost(env, 'org-a', fifth.post.id, { expectedUpdatedAt: fifth.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.equal(answerLost.outcomes[0]!.status, 'unknown')
    const fifthPublication = (await getPost(db, env, 'org-a', fifth.post.id))!.publications[0]!
    assert.equal((await reconcilePostPublication(env, 'org-a', fifthPublication.id, createdId)).state, 'published')
    await publishedOnMeta(fifth.post.id, 'facebook')

    // A publication an earlier version prepared as an unpublished feed post: that draft is deleted with the photos it carried, and the post is published once with new ones.
    const sixth = await create('key-6', { body: 'Prepared the old way', media: [{ asset_id: 'a1', slot: 'cover' }] })
    const draftId = `${PAGE}_legacy-draft`
    meta.fbPhotos.set('photo-legacy', 'https://legacy.example.test/a.jpg')
    meta.fbPosts.set(draftId, { published: false, attached: ['photo-legacy'] })
    await run(`INSERT INTO post_publications (id, organization_id, post_id, channel, provider_app_id, provider_subject_id, provider_target_id, state, provider_post_id, provider_handles_json, payload_hash, error_code, error_message)
      VALUES ('legacy', 'org-a', '${sixth.post.id}', 'facebook', 'fb-app', 'fb-subject', '${PAGE}', 'failed', '${draftId}', '${JSON.stringify({ photo_ids: ['photo-legacy'], post_id: draftId })}',
        '${await postPayloadFingerprint((await getPost(db, env, 'org-a', sixth.post.id))!, { channel: 'facebook', target_id: PAGE })}', 'connection_error', '(#10) Failed to publish post')`)
    const stillUnpublished = await reconcilePostPublication(env, 'org-a', 'legacy', draftId)
    assert.deepEqual([stillUnpublished.state, stillUnpublished.publication?.status, stillUnpublished.publication?.code, stillUnpublished.publication?.message],
      ['failed', 'failed', 'connection_error', '(#10) Failed to publish post'])
    assert.deepEqual(await db.prepare('SELECT state, attempt_id, error_code, error_message FROM post_publications WHERE id = ?').bind('legacy').first(),
      { state: 'failed', attempt_id: null, error_code: 'connection_error', error_message: '(#10) Failed to publish post' })
    const republished = await publishPost(env, 'org-a', sixth.post.id, { expectedUpdatedAt: sixth.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.equal(republished.outcomes[0]!.status, 'published', JSON.stringify(republished.outcomes))
    assert.equal(meta.fbPosts.has(draftId), false)
    const attachedPhoto = JSON.parse(meta.sent(request => request.method === 'POST' && request.path.endsWith(`${PAGE}/feed`)).at(-1)!.body['attached_media[0]']!).media_fbid
    assert.notEqual(attachedPhoto, 'photo-legacy')
    assert.equal(meta.fbPhotos.has(attachedPhoto), true)
    await publishedOnMeta(sixth.post.id, 'facebook')

    // An earlier reconciliation left an unclaimed unpublished draft in preparing.
    const seventh = await create('key-7', { body: 'Unclaimed legacy draft' })
    const unclaimedId = `${PAGE}_unclaimed-draft`
    meta.fbPosts.set(unclaimedId, { published: false, attached: [] })
    await run(`INSERT INTO post_publications (id, organization_id, post_id, channel, provider_app_id, provider_subject_id, provider_target_id, state, provider_post_id, provider_handles_json, payload_hash)
      VALUES ('unclaimed', 'org-a', '${seventh.post.id}', 'facebook', 'fb-app', 'fb-subject', '${PAGE}', 'preparing', '${unclaimedId}', '${JSON.stringify({ post_id: unclaimedId })}',
        '${await postPayloadFingerprint((await getPost(db, env, 'org-a', seventh.post.id))!, { channel: 'facebook', target_id: PAGE })}')`)
    const ready = await reconcilePostPublication(env, 'org-a', 'unclaimed', unclaimedId)
    assert.deepEqual([ready.state, ready.publication?.status, ready.publication?.code], ['preparing', 'processing', 'preparation_ready'])
    assert.match(ready.publication!.message!, /Call publish_post again/)
    assert.equal((await publishPost(env, 'org-a', seventh.post.id, { expectedUpdatedAt: seventh.post.updated_at, targets: [targets.facebook()] }, 'owner')).outcomes[0]!.status, 'published')
    assert.equal(meta.fbPosts.has(unclaimedId), false)
    await publishedOnMeta(seventh.post.id, 'facebook')

    // A Reel Instagram is still processing is waited for and published by the same call.
    meta.reelProcessingReads = 2
    const reel = await create('key-reel', { body: 'Reel', media: [{ asset_id: 'v1', slot: 'cover' }] })
    const reelPublished = await publishPost(env, 'org-a', reel.post.id, { expectedUpdatedAt: reel.post.updated_at, targets: [targets.instagram()] }, 'owner')
    assert.equal(reelPublished.outcomes[0]!.status, 'published', JSON.stringify(reelPublished.outcomes))
    assert.equal(meta.sent(request => request.body.media_type === 'REELS').length, 1)
    assert.equal(meta.sent(request => request.method === 'GET' && Boolean(request.query.get('fields')?.includes('status_code')) && meta.igContainers.get(request.path.split('/').at(-1)!)?.kind === 'REELS').length, 3)
    meta.reelProcessingReads = 0
    await publishedOnMeta(reel.post.id, 'instagram')

    // An expired container is a definite non-publication; the next call prepares new ones.
    const expiring = await create('key-expire', { media: [{ asset_id: 'a2', slot: 'cover' }] })
    meta.expireNewContainers = true
    const expired = await publishPost(env, 'org-a', expiring.post.id, { expectedUpdatedAt: expiring.post.updated_at, targets: [targets.instagram()] }, 'owner')
    assert.equal(expired.outcomes[0]!.code, 'container_expired')
    meta.expireNewContainers = false
    assert.equal((await publishPost(env, 'org-a', expiring.post.id, { expectedUpdatedAt: expiring.post.updated_at, targets: [targets.instagram()] }, 'owner')).outcomes[0]!.status, 'published')
    await publishedOnMeta(expiring.post.id, 'instagram')

    // Concurrent calls for one new target: one claim, one media_publish.
    const racing = await create('key-race', { media: [{ asset_id: 'a1', slot: 'cover' }] })
    const publishesBefore = meta.sent(request => request.path.endsWith('media_publish')).length
    const raced = await Promise.all([1, 2].map(() => publishPost(env, 'org-a', racing.post.id, { expectedUpdatedAt: racing.post.updated_at, targets: [targets.instagram()] }, 'owner')))
    assert.deepEqual(raced.map(result => result.outcomes[0]!.status).sort(), ['processing', 'published'])
    assert.equal(meta.sent(request => request.path.endsWith('media_publish')).length, publishesBefore + 1)

    // After publication, local edits are allowed and nothing is re-sent; the management view says the website copy changed.
    const edited = await updatePost(db, cardless, 'org-a', racing.post.id, { changes: { body: 'Edited later' }, expectedUpdatedAt: (await getPost(db, env, 'org-a', racing.post.id))!.updated_at }, 'owner')
    assert.equal(edited!.publications[0]!.local_content_changed, true)
    // Deleting the website post detaches, and keeps, the provider identity.
    assert.equal(await deletePost(db, 'org-a', racing.post.id, 'owner'), true)
    assert.equal(await db.prepare("SELECT count(*) FROM post_publications WHERE post_id IS NULL AND provider_post_id IS NOT NULL").first('count(*)'), 1)
    // Deleted keys answer gone.
    await assert.rejects(create('key-race', { media: [{ asset_id: 'a1', slot: 'cover' }] }), /deleted/)
    assert.equal(await db.prepare('PRAGMA foreign_key_check').all().then(result => result.results.length), 0)
  } finally {
    restore()
    await runtime.dispose()
  }
})

test('a provider resource belongs to one organization, and an organization has one of each', async () => {
  const { runtime, db, restore } = await setUp()
  try {
    // An agency's login also manages its client's Page; choosing it on the agency's own site is refused.
    const conflict = (error: unknown) => error instanceof HTTPError && error.status === 409 && /already connected to another KrabiClaw site/.test(error.message)
    await assert.rejects(storeIntegration(db, 'org-b', 'facebook', { account_id: 'fb-account', target_id: PAGE, target_name: 'Krabi Claw' }, { revision: 'fb-rev-org-b' }), conflict)
    await assert.rejects(storeIntegration(db, 'org-b', 'instagram', { account_id: 'ig-account', target_id: IG, target_name: 'krabiclaw' }, { revision: 'ig-rev-org-b' }), conflict)
    assert.equal((await readIntegration(db, 'org-b', 'facebook'))!.target_id, OTHER_PAGE)
    assert.equal((await readIntegration(db, 'org-b', 'instagram'))!.target_id, OTHER_IG)

    // The organization that has it can choose it again, a stale revision is a
    // revision conflict, and a second Facebook row for one organization cannot exist.
    await storeIntegration(db, 'org-a', 'facebook', { account_id: 'fb-account', target_id: PAGE, target_name: 'Krabi Claw' }, { revision: 'fb-rev-org-a' })
    assert.notEqual((await readIntegration(db, 'org-a', 'facebook'))!.revision, 'fb-rev-org-a')
    await assert.rejects(storeIntegration(db, 'org-a', 'facebook', { account_id: 'fb-account', target_id: PAGE, target_name: 'Krabi Claw' }, { revision: 'fb-rev-org-a' }), /The Facebook connection changed/)
    await assert.rejects(storeIntegration(db, 'org-a', 'facebook', { account_id: 'fb-account', target_id: 'third-page', target_name: 'Third' }, { revision: null }), /The Facebook connection changed/)
    await assert.rejects(db.prepare("INSERT INTO organization_integrations (id, organization_id, provider, account_id, target_id, target_name, revision) VALUES ('second', 'org-a', 'facebook', 'fb-account', 'third-page', 'Third', 'r')").run(), /UNIQUE constraint failed: organization_integrations.organization_id, organization_integrations.provider/)
    assert.equal(await db.prepare("SELECT count(*) AS n FROM organization_integrations WHERE organization_id = 'org-a' AND provider = 'facebook'").first('n'), 1)

    // Once the other organization lets it go, it can be connected — but a
    // selection read before the disconnect cannot bring the connection back.
    const beforeDisconnect = (await readIntegration(db, 'org-a', 'facebook'))!.revision
    assert.equal(await deleteIntegration(db, 'org-a', 'facebook'), true)
    await assert.rejects(storeIntegration(db, 'org-a', 'facebook', { account_id: 'fb-account', target_id: PAGE, target_name: 'Krabi Claw' }, { revision: beforeDisconnect }), /The Facebook connection changed/)
    assert.equal(await readIntegration(db, 'org-a', 'facebook'), null)
    assert.equal(await deleteIntegration(db, 'org-a', 'instagram'), true)
    await storeIntegration(db, 'org-b', 'facebook', { account_id: 'fb-account', target_id: PAGE, target_name: 'Krabi Claw' }, { revision: 'fb-rev-org-b' })
    await storeIntegration(db, 'org-b', 'instagram', { account_id: 'ig-account', target_id: IG, target_name: 'krabiclaw' }, { revision: 'ig-rev-org-b' })
    assert.deepEqual((await listIntegrations(db, 'org-b')).map(row => `${row.provider}:${row.target_id}`), [`facebook:${PAGE}`, `instagram:${IG}`])
    assert.deepEqual(await listIntegrations(db, 'org-a'), [])
  } finally {
    restore()
    await runtime.dispose()
  }
})

test('channel inventory and deletion stay separate from authored website content and verified Meta erasure', async () => {
  const { runtime, db, env, cardless, meta, asset, restore } = await setUp()
  try {
    await asset('own', 'image/jpeg')
    const own = await createPost(db, cardless, 'org-a', { post: { body: 'Written by us', media: [{ asset_id: 'own', slot: 'cover' }] }, idempotencyKey: 'own' }, 'owner')
    const publication = await publishPost(env, 'org-a', own.post.id, { expectedUpdatedAt: own.post.updated_at, targets: [targets.website, targets.facebook(), targets.instagram()] }, 'owner')
    assert.equal(publication.ok, true)
    const before = await listPublicSocialPosts(env, db, 'org-a', { locale: 'en', window: { limit: 100, offset: 0 }, resource: 'posts' })
    const channelTarget = { channel: 'facebook' as const, target_id: PAGE, connection_revision: 'fb-rev-org-a' }
    const externalId = (await getPost(db, env, 'org-a', own.post.id))!.publications.find(item => item.channel === 'facebook')!.provider_post_id!
    meta.pagePosts = [{ id: externalId, message: 'Written by us', created_time: '2026-09-30T11:00:00+0000' }, { id: `${PAGE}_native`, message: 'Only on Facebook', created_time: '2026-09-30T10:00:00+0000' }]
    const first = await listChannelPosts(env, 'org-a', channelTarget, { after: null, limit: 1 })
    assert.deepEqual(first.posts.map(post => post.provider_post_id), [externalId])
    assert.equal(first.next_after, '1')
    const next = await listChannelPosts(env, 'org-a', channelTarget, { after: first.next_after, limit: 1 })
    assert.deepEqual(next.posts.map(post => post.body), ['Only on Facebook'])
    assert.equal(next.next_after, null)
    meta.igFeed = [{ id: 'native-instagram', username: 'krabiclaw', caption: 'Only on Instagram', media_type: 'IMAGE', media_url: 'https://cdninstagram.com/native.jpg', timestamp: '2026-09-30T10:00:00+0000' }]
    const instagramTarget = { channel: 'instagram' as const, target_id: IG, connection_revision: 'ig-rev-org-a' }
    const instagramInventory = await listChannelPosts(env, 'org-a', instagramTarget, { after: null, limit: 25 })
    assert.deepEqual(instagramInventory.posts.map(post => post.provider_post_id), ['native-instagram'])
    assert.equal((await getChannelPost(env, 'org-a', instagramTarget, 'native-instagram')).body, 'Only on Instagram')
    meta.igFeed.push({ ...meta.igFeed[0], id: 'wrong-account', username: 'someone-else' })
    await assert.rejects(getChannelPost(env, 'org-a', instagramTarget, 'wrong-account'), /does not belong/)
    assert.equal(meta.sent(request => request.host === 'cdninstagram.com').length, 0)
    assert.deepEqual((await listPublicSocialPosts(env, db, 'org-a', { locale: 'en', window: { limit: 100, offset: 0 }, resource: 'posts' })).posts.map(post => post.id), before.posts.map(post => post.id))
    await assert.rejects(getChannelPost(env, 'org-a', { ...channelTarget, connection_revision: 'old' }, externalId), /connection changed/)
    await assert.rejects(deleteChannelPost(env, 'org-a', channelTarget, 'another-page_native', 'owner'), /selected Page/)
    await assert.rejects(deleteChannelPost(env, 'org-a', { channel: 'instagram', target_id: IG, connection_revision: 'ig-rev-org-a' }, 'ig-native', 'owner'), /Facebook Login/)
    const deleted = await deleteChannelPost(env, 'org-a', channelTarget, externalId, 'owner')
    assert.equal(deleted.deleted, true)
    assert.equal(deleted.publication!.state, 'removed')
    assert.equal(meta.fbPosts.has(externalId), false)
    const websiteReadback = (await getPost(db, env, 'org-a', own.post.id))!
    assert.equal(websiteReadback.status, 'published')
    assert.equal(websiteReadback.publications.find(item => item.channel === 'facebook')!.state, 'removed')
    const deletes = meta.sent(request => request.method === 'DELETE').length
    await deleteChannelPost(env, 'org-a', channelTarget, externalId, 'owner')
    assert.equal(meta.sent(request => request.method === 'DELETE').length, deletes)
    const body = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'fb-subject' })).toString('base64url')
    const signed = `${createHmac('sha256', 'facebook-secret').update(body).digest('base64url')}.${body}`
    const subject = (await verifyMetaSignedRequest(signed, configuredMetaApps(env as unknown as Record<string, unknown>)))!
    const app = new H3()
    app.post('/api/integrations/meta/deauthorize', deauthorizeCallback)
    app.post('/api/integrations/meta/data-deletion', deleteCallback)
    app.get('/api/integrations/meta/data-deletion', deletionStatus)
    const callback = (path: string, method: 'GET' | 'POST') => app.request(Object.assign(new Request(new URL(path, 'https://proof.example'), {
      method, ...(method === 'POST' && { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_request: signed }) }),
    }), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    const deauthorized = await callback('/api/integrations/meta/deauthorize', 'POST')
    assert.equal(deauthorized.status, 200)
    assert.deepEqual(await deauthorized.json(), { success: true, released: 2 })
    const deletion = await callback('/api/integrations/meta/data-deletion', 'POST')
    assert.equal(deletion.status, 200)
    const erased = await deletion.json() as { url: string; confirmation_code: string; detached_publications: number; remaining: number }
    assert.equal(erased.detached_publications, 1)
    assert.equal(erased.remaining, 0)
    const status = await callback(erased.url, 'GET')
    assert.equal(status.status, 200)
    assert.equal((await status.json() as { status: string }).status, 'complete')
    assert.equal(await remainingMetaSubjectData(env, subject), 0)
    const kept = (await getPost(db, env, 'org-a', own.post.id))!
    assert.equal(kept.body, 'Written by us')
    assert.equal(kept.media[0]!.asset_id, 'own')
    assert.deepEqual(kept.publications.map(item => item.channel), ['instagram'])
    assert.equal(await db.prepare("SELECT status FROM media_assets WHERE id = 'own'").first('status'), 'active')
    const repeatedDeletion = await callback('/api/integrations/meta/data-deletion', 'POST')
    assert.equal(repeatedDeletion.status, 200)
    assert.equal((await repeatedDeletion.json() as { detached_publications: number }).detached_publications, 0)
    assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0)
    const beforeGallery = (await getPost(db, env, 'org-a', own.post.id))!
    await attachMediaPlacement(db, { organizationId: 'org-a', env: cardless, placement: { owner_type: 'content_document', owner_id: own.post.id, slot: 'gallery' }, assetId: 'own' })
    const afterGallery = (await getPost(db, env, 'org-a', own.post.id))!
    assert.notEqual(afterGallery.updated_at, beforeGallery.updated_at)
  } finally {
    restore()
    await runtime.dispose()
  }
})


test('configured Facebook system user reads every assigned Page and rejects incomplete provider data', async () => {
  const { runtime, env, meta, restore } = await setUp()
  try {
    const first = { id: OTHER_PAGE, name: 'Another Page', access_token: 'another-token' }
    const second = { id: PAGE, name: 'Krabi Claw', access_token: 'page-token' }
    meta.assignedPageResponses.set('', { data: [first], paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'second' } } })
    meta.assignedPageResponses.set('second', { data: [second] })
    assert.deepEqual(await listLinkedFacebookPages(env, 'fb-account'), [first, second])
    assert.equal(await facebookPageToken(env, { account_id: 'fb-account', target_id: PAGE, target_name: 'Krabi Claw' }), 'page-token')
    const requests = meta.sent(request => request.path.endsWith('/assigned_pages'))
    assert.deepEqual(requests.map(request => [request.method, request.path, request.query.get('after')]), [
      ['GET', '/v25.0/me/assigned_pages', null], ['GET', '/v25.0/me/assigned_pages', 'second'],
      ['GET', '/v25.0/me/assigned_pages', null], ['GET', '/v25.0/me/assigned_pages', 'second'],
    ])
    assert.equal(requests[0]!.query.get('fields'), 'id,name,access_token,category,fan_count,picture')
    assert.equal(meta.sent(request => request.path.endsWith('/accounts')).length, 0)
    for (const [response, message] of [
      [{}, /no assigned Pages data/],
      [{ data: [{}] }, /without its identity/],
      [{ data: [{ id: PAGE, name: 'Krabi Claw' }] }, /no access token/],
      [{ data: [], paging: { next: 'https://graph.facebook.com/next' } }, /invalid assigned Pages pagination cursor/],
      [{ data: [], paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'second' } } }, /invalid assigned Pages pagination cursor/],
    ] as const) {
      meta.assignedPageResponses.set('', response)
      meta.assignedPageResponses.set('second', response)
      await assert.rejects(listLinkedFacebookPages(env, 'fb-account'), message)
    }
    meta.assignedPageResponses.set('', { data: [] })
    assert.deepEqual(await listLinkedFacebookPages(env, 'fb-account'), [])
    await assert.rejects(facebookPageToken(env, { account_id: 'fb-account', target_id: PAGE, target_name: 'Krabi Claw' }), /has no assignment/)
  } finally {
    restore()
    await runtime.dispose()
  }
})

test('channel MCP tools report invalid parameters while preserving connection and provider failures', async () => {
  const { runtime, db, env, meta, restore } = await setUp()
  try {
    const organization = { env, db, organizationId: 'org-a', userId: 'owner' } as McpExecutorContext['organization']
    const args = { channel: 'facebook', target_id: PAGE, connection_revision: 'fb-rev-org-a', provider_post_id: `${PAGE}_native` }
    for (const toolName of ['list_channel_posts', 'get_channel_post', 'delete_channel_post']) {
      for (const invalid of [{ channel: 'unknown' }, { target_id: '' }, { connection_revision: '' }]) {
        await assert.rejects(handlePostsTools({ toolName, organization, args: { ...args, ...invalid } }),
          (error: unknown) => error instanceof Error && 'mcp' in error && (error.mcp as { code: number }).code === MCP_ERROR.invalidParams)
      }
      await assert.rejects(handlePostsTools({ toolName, organization, args: { ...args, connection_revision: 'old' } }),
        (error: unknown) => error instanceof HTTPError && error.statusCode === 409 && !('mcp' in error))
      meta.fault('reject', request => request.path.endsWith(toolName === 'list_channel_posts' ? '/posts' : args.provider_post_id))
      // Meta's refusal is named the way publish_post names it, with Meta's code
      // and trace, and keeps the provider error as its cause.
      await assert.rejects(handlePostsTools({ toolName, organization, args }),
        (error: unknown) => error instanceof Error && !('mcp' in error)
          && /^provider_rejected: .*\(Meta code 100, fbtrace_id [^)]+\)$/.test(error.message)
          && error.cause instanceof MetaGraphError && !error.cause.objectMissing)
    }
    for (const limit of [0, 101, 1.5, '25', null]) {
      await assert.rejects(handlePostsTools({ toolName: 'list_channel_posts', organization, args: { ...args, limit } }),
        { message: 'limit must be an integer between 1 and 100', mcp: { code: MCP_ERROR.invalidParams, message: 'limit must be an integer between 1 and 100', data: undefined, kind: 'tool_execution' } })
    }
  } finally {
    restore()
    await runtime.dispose()
  }
})

for (const method of ['GET', 'DELETE']) {
  test(`channel deletion propagates ambiguous missing-object errors during ${method}`, async () => {
    const { runtime, db, env, cardless, meta, restore } = await setUp()
    try {
      const target = { channel: 'facebook' as const, target_id: PAGE, connection_revision: 'fb-rev-org-a' }
      const { post } = await createPost(db, cardless, 'org-a', { post: { body: 'Delete from Facebook' }, idempotencyKey: 'delete-missing' }, 'owner')
      assert.equal((await publishPost(env, 'org-a', post.id, { expectedUpdatedAt: post.updated_at, targets: [target] }, 'owner')).ok, true)
      const providerId = (await getPost(db, env, 'org-a', post.id))!.publications[0]!.provider_post_id!
      const matches = (request: SeenRequest) => request.method === method && request.path.endsWith(`/${providerId}`)
      meta.fault('reject', matches)
      await assert.rejects(deleteChannelPost(env, 'org-a', target, providerId, 'owner'),
        (error: unknown) => error instanceof MetaGraphError && !error.objectMissing)
      assert.equal((await getPost(db, env, 'org-a', post.id))!.publications[0]!.state, 'published')

      meta.fault('missing', matches)
      await assert.rejects(deleteChannelPost(env, 'org-a', target, providerId, 'owner'),
        (error: unknown) => error instanceof MetaGraphError && error.objectMissing)
      assert.equal((await getPost(db, env, 'org-a', post.id))!.publications[0]!.state, 'published')
      assert.equal(meta.fbPosts.has(providerId), true)
      assert.equal(await db.prepare("SELECT count(*) AS count FROM activity_entries WHERE event_name = 'post.channel_deleted' AND json_extract(payload_json, '$.entityId') = ?").bind(providerId).first('count'), 0)

      const unknownId = `${PAGE}_untracked`
      meta.fbPosts.set(unknownId, { published: true, attached: [] })
      meta.fault('missing', request => request.method === method && request.path.endsWith(`/${unknownId}`))
      await assert.rejects(deleteChannelPost(env, 'org-a', target, unknownId, 'owner'),
        (error: unknown) => error instanceof MetaGraphError && error.objectMissing)
      assert.equal(await db.prepare("SELECT count(*) AS count FROM activity_entries WHERE event_name = 'post.channel_deleted' AND json_extract(payload_json, '$.entityId') = ?").bind(unknownId).first('count'), 0)
    } finally {
      restore()
      await runtime.dispose()
    }
  })
}

test('Instagram insights read the connected account and its posts for the organization range, and name every state without a report', async () => {
  const { runtime, env, meta, run, restore } = await setUp()
  try {
    await run(`UPDATE organization SET timezone = 'Asia/Bangkok' WHERE id IN ('org-a', 'org-b')`)
    const range = { startDate: '2026-09-28', endDate: '2026-09-30' }
    assert.equal((await loadInstagramInsights(env, 'org-a', range)).status, 'permission_missing')
    assert.equal(meta.requests.length, 0)

    await run("UPDATE account SET scope = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights' WHERE id = 'ig-account'")
    meta.igInsights = { views: 1200, reach: 0, accounts_engaged: 14, total_interactions: 31, likes: 20, comments: 3, shares: 4, saves: 4, profile_links_taps: 2 }
    meta.igFeed = [
      { id: 'later', media_type: 'IMAGE', timestamp: '2026-10-01T00:00:00+0000' },
      { id: 'reel', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/reel/', caption: 'Sunset', thumbnail_url: 'https://cdn.example/reel.jpg', timestamp: '2026-09-29T03:00:00+0000' },
      { id: 'carousel', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', timestamp: '2026-09-28T01:00:00+0000' },
      { id: 'earlier', media_type: 'IMAGE', timestamp: '2026-09-27T16:59:59+0000' },
    ]
    meta.igMediaInsights.set('reel', { views: 40, reach: 30, likes: 5, comments: 0, shares: 1, saved: 2 })
    const report = await loadInstagramInsights(env, 'org-a', range)
    assert.equal(report.status, 'connected')
    if (report.status !== 'connected') return
    assert.equal(report.username, 'krabiclaw')
    assert.deepEqual(report.period, range)
    // Zero is Instagram's zero; a metric it did not return is null.
    assert.deepEqual(report.account, { views: 1200, reach: 0, accounts_engaged: 14, total_interactions: 31, likes: 20, comments: 3, shares: 4, saves: 4, replies: null, profile_links_taps: 2 })
    const [accountRequest] = meta.sent(request => request.path.endsWith(`${IG}/insights`))
    // Bangkok's 28 September through 30 September, in the organization's own calendar.
    assert.equal(accountRequest!.query.get('since'), String(Date.parse('2026-09-27T17:00:00Z') / 1000))
    assert.equal(accountRequest!.query.get('until'), String(Date.parse('2026-09-30T17:00:00Z') / 1000))
    assert.equal(accountRequest!.query.get('metric_type'), 'total_value')
    assert.deepEqual(report.media.map(post => post.id), ['reel', 'carousel'])
    assert.deepEqual(report.media[0]!.insights, { views: 40, reach: 30, likes: 5, comments: 0, shares: 1, saved: 2, total_interactions: null })
    assert.equal(report.media[0]!.permalink, 'https://www.instagram.com/reel/reel/')
    assert.equal(report.media[1]!.insights, null)
    assert.match(report.media[1]!.unavailableReason!, /carousel/u)
    assert.equal(meta.sent(request => request.path === 'carousel/insights').length, 0)
    assert.equal(report.moreMedia, false)

    meta.fault('reject', request => request.path.endsWith(`${IG}/insights`))
    await assert.rejects(() => loadInstagramInsights(env, 'org-a', range), (error: unknown) => error instanceof HTTPError && error.status === 502 && /^Instagram: /u.test(error.message) && !/access_token|ig-token/u.test(error.message))

    await run("DELETE FROM organization_integrations WHERE organization_id = 'org-b' AND provider = 'instagram'")
    assert.equal((await loadInstagramInsights(env, 'org-b', range)).status, 'not_connected')
    await run("DELETE FROM subscription WHERE referenceId = 'org-b'")
    assert.equal((await loadInstagramInsights(env, 'org-b', range)).status, 'growth_plan_required')
    await run("UPDATE organization_integrations SET account_id = 'gone' WHERE organization_id = 'org-a' AND provider = 'instagram'")
    assert.equal((await loadInstagramInsights(env, 'org-a', range)).status, 'account_unlinked')
  } finally {
    restore()
    await runtime.dispose()
  }
})

test('Instagram insights classify malformed provider responses and preserve local token errors', async () => {
  const { runtime, db, env, meta, run, restore } = await setUp()
  try {
    await run("UPDATE account SET scope = 'instagram_business_manage_insights' WHERE id = 'ig-account'")
    const range = { startDate: '2026-09-28', endDate: '2026-09-30' }
    const target = { userId: IG, accessToken: 'ig-token' }
    const accountRange = { since: new Date('2026-09-28'), until: new Date('2026-10-01') }
    meta.igFeed = [{ id: 'reel', media_type: 'VIDEO', timestamp: '2026-09-29T03:00:00+0000' }]
    meta.igMediaInsights.set('reel', { views: 40 })
    const malformed: Array<[string, unknown, () => Promise<unknown>, string]> = [
      [`${IG}/media`, {}, () => listMedia(target, { after: null, limit: 25 }), 'Meta returned no post inventory'],
      [`${IG}/media`, { data: [], paging: { next: 'https://graph.instagram.com/next' } }, () => listMedia(target, { after: null, limit: 25 }), 'Meta returned another page without its cursor'],
      [`${IG}/insights`, { data: {} }, () => readAccountInsights(target, accountRange), 'Instagram returned no insights data'],
      ['reel/insights', {}, () => readMediaInsights(target, 'reel'), 'Instagram returned no insights data'],
    ]
    for (const [path, response, read, message] of malformed) {
      meta.igResponses.set(path, response)
      await assert.rejects(read, (error: unknown) => error instanceof MetaGraphError && error.failure === 'invalid-response' && error.message === message)
      await assert.rejects(() => loadInstagramInsights(env, 'org-a', range), (error: unknown) => error instanceof HTTPError && error.status === 502 && error.message === `Instagram: ${message}`)
      meta.igResponses.delete(path)
    }

    await run("UPDATE account SET accessTokenExpiresAt = NULL WHERE id = 'ig-account'")
    const requestsBefore = meta.requests.length
    await assert.rejects(() => loadInstagramInsights(env, 'org-a', range), (error: unknown) => error instanceof Error && !(error instanceof MetaGraphError) && !(error instanceof HTTPError) && /no token expiry/u.test(error.message))
    assert.equal(meta.requests.length, requestsBefore)

    await run(`UPDATE account SET accessTokenExpiresAt = ${Math.floor(Date.now() / 1000) + 60} WHERE id = 'ig-account'`)
    for (const response of [{ expires_in: 5184000 }, { access_token: 'renewed-token' }, { access_token: 'renewed-token', expires_in: '5184000' }]) {
      meta.igResponses.set('/refresh_access_token', response)
      await assert.rejects(() => instagramAccessToken(env, 'ig-account'), (error: unknown) => error instanceof MetaGraphError && error.failure === 'invalid-response')
      await assert.rejects(() => loadInstagramInsights(env, 'org-a', range), (error: unknown) => error instanceof HTTPError && error.status === 502 && error.message === 'Instagram: Instagram did not return a long-lived access token and its lifetime')
    }
    assert.equal(await db.prepare("SELECT accessToken FROM account WHERE id = 'ig-account'").first('accessToken'), 'ig-token')

    meta.igResponses.set('/refresh_access_token', { access_token: 'renewed-token', expires_in: 5184000 })
    await run("CREATE TRIGGER ignore_token_save BEFORE UPDATE OF accessToken ON account WHEN OLD.id = 'ig-account' BEGIN SELECT RAISE(IGNORE); END")
    await assert.rejects(() => loadInstagramInsights(env, 'org-a', range), (error: unknown) => error instanceof Error && !(error instanceof MetaGraphError) && !(error instanceof HTTPError) && /could not be saved/u.test(error.message))
    assert.equal(await db.prepare("SELECT accessToken FROM account WHERE id = 'ig-account'").first('accessToken'), 'ig-token')
    await run('DROP TRIGGER ignore_token_save')
    assert.equal((await loadInstagramInsights(env, 'org-a', range)).status, 'connected')
    assert.equal((await linkedAccountAccessToken(env, 'ig-account')).accessToken, 'renewed-token')
  } finally {
    restore()
    await runtime.dispose()
  }
})

test('Facebook video: a Reel is published by finishing its upload session, any other video by its upload; Meta\u2019s answer is the publication and no video is flipped to published', async () => {
  const { runtime, db, env, cardless, meta, asset, restore } = await setUp()
  try {
    await asset('reel', 'video/mp4', 'video', { width: 720, height: 1280, duration: 12 })
    await asset('wide', 'video/mp4', 'video', { width: 1920, height: 1080, duration: 20 })
    const create = (key: string, post: Record<string, unknown>) => createPost(db, cardless, 'org-a', { post, idempotencyKey: key }, 'owner')
    const publication = (postId: string) => db.prepare('SELECT state, provider_post_id, provider_permalink, provider_handles_json, error_code FROM post_publications WHERE post_id = ? AND channel = ?').bind(postId, 'facebook')
      .first<{ state: string; provider_post_id: string | null; provider_permalink: string | null; provider_handles_json: string; error_code: string | null }>()
    const starts = () => meta.sent(request => request.path.endsWith(`${PAGE}/video_reels`) && request.body.upload_phase === 'start').length

    // A 9:16 video is a Reel: start, Facebook fetches the file, finish as PUBLISHED with the caption; the finish's post is the publication.
    const reel = await create('key-fb-reel', { body: 'Robatayaki tonight', media: [{ asset_id: 'reel', slot: 'cover' }] })
    const published = await publishPost(env, 'org-a', reel.post.id, { expectedUpdatedAt: reel.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.equal(published.outcomes[0]!.status, 'published', JSON.stringify(published.outcomes))
    assert.equal(starts(), 1)
    assert.deepEqual(meta.sent(request => request.host === 'rupload.facebook.com').map(request => [request.path, request.headers.file_url, request.headers.authorization]),
      [['/video-upload/v25.0/reel-1', 'https://imagedelivery.example.test/hash/reel/public', 'OAuth page-token']])
    assert.deepEqual(meta.sent(request => request.path.endsWith(`${PAGE}/video_reels`) && request.body.upload_phase === 'finish').map(request => [request.body.video_id, request.body.video_state, request.body.description]),
      [['reel-1', 'PUBLISHED', 'Robatayaki tonight']])
    assert.deepEqual(await publication(reel.post.id), { state: 'published', provider_post_id: `${PAGE}_reel-1`, provider_permalink: null, provider_handles_json: JSON.stringify({ video_id: 'reel-1' }), error_code: null })
    assert.equal(meta.fbPosts.get(`${PAGE}_reel-1`)?.published, true)
    // A repeat is a receipt, not another Reel.
    assert.equal((await publishPost(env, 'org-a', reel.post.id, { expectedUpdatedAt: reel.post.updated_at, targets: [targets.facebook()] }, 'owner')).outcomes[0]!.status, 'already_published')
    assert.equal(starts(), 1)

    // Any other video is published by its upload; the video Facebook accepted is the publication.
    const wide = await create('key-fb-wide', { body: 'Kitchen tour', media: [{ asset_id: 'wide', slot: 'cover' }] })
    const uploaded = await publishPost(env, 'org-a', wide.post.id, { expectedUpdatedAt: wide.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.equal(uploaded.outcomes[0]!.status, 'published', JSON.stringify(uploaded.outcomes))
    assert.deepEqual(meta.sent(request => request.path.endsWith(`${PAGE}/videos`)).map(request => [request.body.file_url, request.body.published, request.body.description]),
      [['https://imagedelivery.example.test/hash/wide/public', undefined, 'Kitchen tour']])
    assert.deepEqual(await publication(wide.post.id).then(row => [row!.state, row!.provider_post_id]), ['published', 'video-2'])

    // A Reel upload Facebook does not answer is a failure that says so; the retry runs its own session, and the abandoned one was never public.
    const retried = await create('key-fb-reel-retry', { body: 'Second reel', media: [{ asset_id: 'reel', slot: 'cover' }] })
    meta.fault('dropped', request => request.host === 'rupload.facebook.com')
    const unanswered = await publishPost(env, 'org-a', retried.post.id, { expectedUpdatedAt: retried.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.deepEqual([unanswered.outcomes[0]!.status, unanswered.outcomes[0]!.code], ['failed', 'provider_unreachable'])
    assert.equal((await publication(retried.post.id))!.state, 'failed')
    const resumed = await publishPost(env, 'org-a', retried.post.id, { expectedUpdatedAt: retried.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.equal(resumed.outcomes[0]!.status, 'published', JSON.stringify(resumed.outcomes))
    assert.equal(starts(), 3)
    assert.equal((await publication(retried.post.id))!.provider_post_id, `${PAGE}_reel-4`)

    // Meta refusing the finish is a definite non-publication.
    const refused = await create('key-fb-reel-refused', { body: 'Third reel', media: [{ asset_id: 'reel', slot: 'cover' }] })
    meta.fault('reject', request => request.path.endsWith(`${PAGE}/video_reels`) && request.body.upload_phase === 'finish')
    const rejected = await publishPost(env, 'org-a', refused.post.id, { expectedUpdatedAt: refused.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.deepEqual([rejected.outcomes[0]!.status, rejected.outcomes[0]!.code], ['failed', 'provider_rejected'], JSON.stringify(rejected.outcomes))

    // Neither path ever asks Facebook to flip a video to published.
    assert.equal(meta.sent(request => request.method === 'POST' && request.host === 'graph.facebook.com' && /\/(reel|video)-\d+$/.test(request.path)).length, 0)

    // Reconciliation reads the Page post the finish named, and the video an upload named.
    const reconciledReel = await reconcilePostPublication(env, 'org-a', (await db.prepare('SELECT id FROM post_publications WHERE post_id = ?').bind(reel.post.id).first<{ id: string }>())!.id, null)
    assert.equal(reconciledReel.state, 'published')
    for (const video of meta.fbVideos.values()) video.ready = -1
    const reconciledWide = await reconcilePostPublication(env, 'org-a', (await db.prepare('SELECT id FROM post_publications WHERE post_id = ?').bind(wide.post.id).first<{ id: string }>())!.id, null)
    assert.equal(reconciledWide.state, 'published')
  } finally {
    restore()
    await runtime.dispose()
  }
})
