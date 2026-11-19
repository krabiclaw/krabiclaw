import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { captureEvents } from './support/events.ts'
import Ajv from 'ajv'
import { Miniflare } from 'miniflare'
import { H3 } from 'nitro/h3'
import { HTTPError } from 'nitro'
import { handlePostsTools, POSTS_TOOLS } from '../../server/utils/mcp-tools/posts.ts'
import type { McpExecutorContext } from '../../server/utils/mcp-tools/execution.ts'
import { isMcpRenderResponse } from '../../server/utils/mcp-render.ts'
import { createAuth, type CloudflareEnv } from '../../server/utils/auth.ts'
import { createPost, deletePost, getPost, listPublicSocialPosts, updatePost } from '../../server/utils/post-management.ts'
import { getSocialConnections, publishPost, reconcilePostPublication, type PublishTarget } from '../../server/utils/social-publication.ts'
import { listChannelPosts, getChannelPost, deleteChannelPost } from '../../server/utils/social-channel-posts.ts'
import { remainingMetaSubjectData } from '../../server/utils/integration-release.ts'
import { deleteIntegration, listIntegrations, readIntegration, storeIntegration } from '../../server/utils/organization-integrations.ts'
import { verifyMetaSignedRequest, configuredMetaApps } from '../../server/utils/meta-graph.ts'
import { attachMediaPlacement } from '../../server/utils/media-placement.ts'
import connectionAuthorization from '../../server/api/dashboard/connection-authorization.ts'
import deauthorizeCallback from '../../server/api/integrations/meta/deauthorize.post.ts'
import deleteCallback from '../../server/api/integrations/meta/data-deletion.post.ts'
import deletionStatus from '../../server/api/integrations/meta/data-deletion.get.ts'
import { PostValidationError, POST_TITLE_MAX } from '../../shared/posts.ts'
import { resolveMembership } from '../../server/utils/member-access.ts'
import { applySchema } from './support/schema.ts'

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
  igResponses = new Map<string, unknown>([['me', { user_id: IG, username: 'krabiclaw' }]])
  assignedPageResponses = new Map<string, unknown>([['', { data: [{ id: PAGE, name: 'Krabi Claw', access_token: 'page-token' }] }]])
  instagramResponseGate: ((request: SeenRequest) => Promise<void>) | null = null

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
    if (url.hostname === 'graph.instagram.com') {
      const response = this.instagram(method, url.pathname.replace('/v23.0/', ''), url.searchParams, body)
      if (this.instagramResponseGate) await this.instagramResponseGate(request)
      return response
    }
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
      if (this.publishNotReady > 0) { this.publishNotReady -= 1; return json({ error: { message: 'Media ID is not available', code: 9007, error_subcode: 2207027 } }, 400) }
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
  /** media_publish answers Meta's "media not ready" this many more times on a FINISHED container. */
  publishNotReady = 0
  expireNewContainers = false
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

async function setUp() {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'social-publication-proof', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export class Hub { fetch() { return new Response(null, { status: 204 }) } } export default { fetch() { return new Response("ok") } }' } } },
    exports: { Hub: { type: 'durable-object', storage: 'sqlite' } },
    env: { DB: { type: 'd1' }, MEDIA_BUCKET: { type: 'r2' }, IMAGES: { type: 'images' }, ORGANIZATION_CACHE: { type: 'kv' }, GUEST_INBOX_HUBS: { type: 'durable-object', worker: 'social-publication-proof', exportName: 'Hub' } },
  } }] })
  const db = await runtime.getD1Database('DB')
  await applySchema(db)
  const queue = captureEvents()
  const env = {
    ...await runtime.getBindings<CloudflareEnv>(), EVENTS: queue.binding,
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
  return { runtime, db, env, queue, cardless: cardless as unknown as CloudflareEnv, meta, run, asset, restore: () => { globalThis.fetch = realFetch } }
}

const targets = {
  website: { channel: 'organization' } as PublishTarget,
  facebook: (organization = 'org-a') => ({ channel: 'facebook', target_id: PAGE, connection_revision: `fb-rev-${organization}` }) as PublishTarget,
  instagram: (organization = 'org-a') => ({ channel: 'instagram', target_id: IG, connection_revision: `ig-rev-${organization}` }) as PublishTarget,
}

test('publication: one result and one external post per target; a failure is the provider\u2019s answer and the next call publishes again', async () => {
  const { runtime, db, env, cardless, meta, run, asset, restore } = await setUp()
  try {
    await run("INSERT INTO user (id, name, email) VALUES ('publisher', 'Publisher', 'publisher@proof.example')")
    await run("INSERT INTO member (id, organizationId, userId, role) VALUES ('progress-owner', 'org-a', 'owner', 'owner')")
    const membership = await resolveMembership(env, { organizationId: 'org-a', userId: 'owner' })
    assert.ok(membership)
    const organization: McpExecutorContext['organization'] = { env: cardless, db, membership, organizationId: 'org-a', userId: 'owner', role: 'owner', isPlatformAdmin: false, scopes: [] }
    const ajv = new Ajv({ strict: false })
    const mcp = async (toolName: string, args: Record<string, unknown>) => {
      const result = await handlePostsTools({ toolName, args, organization })
      const output = isMcpRenderResponse(result) ? result.structuredContent : result
      assert(ajv.validate(POSTS_TOOLS.find(tool => tool.name === toolName)!.outputSchema, output), `${toolName} output: ${ajv.errorsText()}`)
      return output as { post?: { id: string; publications: unknown[] }; posts?: Array<{ id: string; publications: unknown[] }>; replayed?: boolean }
    }
    const publicationState = async (id: string | undefined) => await db.prepare('SELECT state FROM post_publications WHERE id = ?').bind(id).first<string>('state')
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
    await assert.rejects(create('   ', { body: 'A draft' }), { statusCode: 400, data: { mutation_applied: false } })
    await assert.rejects(create('x'.repeat(201), { body: 'A draft' }), { statusCode: 400, data: { mutation_applied: false } })
    await assert.rejects(create('invalid-payload', { title: 'x'.repeat(POST_TITLE_MAX + 1) }), { statusCode: 400, data: { mutation_applied: false } })
    await assert.rejects(create('invalid-location', { body: 'A draft', location_id: 'missing-location' }), { statusCode: 400, data: { mutation_applied: false } })
    await assert.rejects(create('invalid-photo', { body: 'A draft', media: [{ asset_id: 'missing-asset', slot: 'cover' }] }), { status: 400, data: { mutation_applied: false } })
    assert.equal(await db.prepare("SELECT count(*) FROM content_documents WHERE kind = 'social_post'").first('count(*)'), 0)
    const first = await create('key-1', { body: 'Pizza night Friday', media: [{ asset_id: 'a1', slot: 'cover' }, { asset_id: 'a2', slot: 'gallery' }], call_to_action: { label: 'Book', url: 'https://example.test/book' } })
    assert.equal(first.replayed, false)
    assert.equal(first.post.status, 'draft')
    assert.equal(first.post.slug, 'pizza-night-friday')
    assert.match(first.post.preview_url ?? '', /^https:\/\/org-a\.krabiclaw\.test\/posts\/pizza-night-friday\?preview_token=/)
    assert.equal((await create('key-1', { body: 'Pizza night Friday', media: [{ asset_id: 'a1', slot: 'cover' }, { asset_id: 'a2', slot: 'gallery' }], call_to_action: { label: 'Book', url: 'https://example.test/book' } })).post.id, first.post.id)
    await assert.rejects(create('key-1', { title: 'x'.repeat(POST_TITLE_MAX + 1) }), (error: unknown) => error instanceof PostValidationError && error.statusCode === 400 && error.data === undefined)
    await assert.rejects(create('key-1', { body: 'Something else' }), (error: unknown) => HTTPError.isError(error) && error.status === 409 && /different post/.test(error.message) && !(error.data && typeof error.data === 'object' && 'mutation_applied' in error.data))
    assert.equal(await db.prepare("SELECT count(*) FROM content_documents WHERE kind = 'social_post'").first('count(*)'), 1)
    // An empty draft exists and has a generated route, and cannot be published.
    const empty = await create('key-empty', {})
    assert.equal(empty.post.slug, `update-${empty.post.id}`)
    const emptyResult = await publishPost(env, 'org-a', empty.post.id, { expectedUpdatedAt: empty.post.updated_at, targets: [targets.website] }, 'owner')
    assert.deepEqual([emptyResult.ok, emptyResult.outcomes[0]!.code], [false, 'empty_post'])
    assert.deepEqual(await db.prepare('SELECT status, published_at FROM content_documents WHERE id = ?').bind(empty.post.id).first(), { status: 'draft', published_at: null })

    await run("UPDATE account SET accessToken = 'deadbeef' WHERE id = 'ig-account'")
    const connections = await getSocialConnections(env, 'org-a', { dashboardBase: 'https://proof.example/dashboard/org-a' })
    assert.deepEqual(connections.channels.find(item => item.channel === 'facebook')?.problems, [])
    assert.deepEqual(connections.channels.find(item => item.channel === 'instagram')?.problems.map(item => item.code), ['access_token_unavailable'])
    await run("UPDATE account SET accessToken = 'ig-token' WHERE id = 'ig-account'")

    // Website, Facebook photos and an Instagram carousel in one call.
    const result = await handlePostsTools({
      toolName: 'publish_post',
      args: { post_id: first.post.id, updated_at: first.post.updated_at, targets: [targets.website, targets.facebook(), targets.instagram()] },
      organization: { ...organization, env, userId: 'publisher' },
    })
    assert.ok(isMcpRenderResponse(result))
    const all = result.structuredContent as Awaited<ReturnType<typeof publishPost>>
    assert.equal(all.ok, true, JSON.stringify(all.outcomes))
    assert.match(result.modelText!, /\[View on Website\]\(<https:\/\/org-a\.krabiclaw\.test\/posts\/pizza-night-friday>\)/)
    assert.ok(result.modelText?.includes(`[View on Facebook](<https://www.facebook.com/${PAGE}_3>)`))
    assert.ok(result.modelText?.includes(`[View on Instagram](<https://www.instagram.com/p/${[...meta.igMedia.keys()][0]}/>)`))
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
    const stored = await db.prepare("SELECT channel, state, provider_post_id, provider_permalink FROM post_publications WHERE post_id = ? ORDER BY channel").bind(first.post.id).all()
    assert.deepEqual(stored.results.map(row => [row.channel, row.state]), [['facebook', 'published'], ['instagram', 'published']])
    const initiators = await db.prepare(`SELECT p.id, p.channel, p.state, p.initiating_activity_id, a.actor_user_id, a.payload_json
      FROM post_publications p JOIN activity_entries a ON a.id = p.initiating_activity_id AND a.organization_id = p.organization_id
      WHERE p.post_id = ? ORDER BY p.channel`).bind(first.post.id).all<{ id: string; channel: string; state: string; initiating_activity_id: string; actor_user_id: string; payload_json: string }>()
    assert.equal(initiators.results.length, 2)
    for (const row of initiators.results) {
      assert.equal(row.actor_user_id, 'publisher', 'the initiating publisher is not the post creator or linked provider-account owner')
      assert.equal(row.state, 'published')
      const event = JSON.parse(row.payload_json) as { entityId: string; metadata: { post_id: string; channel: string } }
      assert.equal(event.entityId, row.id)
      assert.equal(event.metadata.post_id, first.post.id)
      assert.equal(event.metadata.channel, row.channel)
    }

    // A repeat reads the receipts: nothing is sent again and the publication date stays.
    const requestCount = meta.requests.length
    const published = await getPost(db, env, 'org-a', first.post.id)
    const again = await publishPost(env, 'org-a', first.post.id, { expectedUpdatedAt: 'stale-token', targets: [targets.website, targets.facebook(), targets.instagram()] }, 'owner')
    assert.deepEqual(again.outcomes.map(outcome => outcome.status), ['already_published', 'already_published', 'already_published'])
    assert.equal(again.ok, true)
    assert.equal(meta.requests.filter(request => request.method !== 'GET').length, meta.requests.slice(0, requestCount).filter(request => request.method !== 'GET').length)
    assert.equal((await getPost(db, env, 'org-a', first.post.id))!.published_at, published!.published_at)
    assert.equal(await db.prepare("SELECT count(*) FROM activity_entries WHERE event_name = 'post.published'").first('count(*)'), 1)
    assert.deepEqual((await db.prepare(`SELECT p.initiating_activity_id FROM post_publications p WHERE p.post_id = ? ORDER BY p.channel`).bind(first.post.id).all()).results,
      initiators.results.map(row => ({ initiating_activity_id: row.initiating_activity_id })), 'a receipt-only retry keeps the actual initiator')
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
    assert.equal(await publicationState(rejected.outcomes[0]!.publication_id), 'failed')
    const retried = await publishPost(env, 'org-a', third.post.id, { expectedUpdatedAt: third.post.updated_at, targets: [targets.facebook()] }, 'publisher')
    assert.equal(retried.outcomes[0]!.status, 'published')
    await publishedOnMeta(third.post.id, 'facebook')
    assert.equal((await getPost(db, env, 'org-a', third.post.id))!.status, 'draft', 'external publication does not publish the website draft')
    const retryInitiator = await db.prepare(`SELECT a.actor_user_id FROM post_publications p JOIN activity_entries a ON a.id = p.initiating_activity_id
      WHERE p.post_id = ? AND p.channel = 'facebook'`).bind(third.post.id).first<{ actor_user_id: string }>()
    assert.equal(retryInitiator?.actor_user_id, 'publisher')
    assert.equal(await publicationState(retried.outcomes[0]!.publication_id), 'published')
    const attempts = await db.prepare(`SELECT actor_user_id, payload_json FROM activity_entries WHERE event_name = 'post.publication_started'
      AND json_extract(payload_json, '$.metadata.post_id') = ?`).bind(third.post.id).all<{ actor_user_id: string; payload_json: string }>()
    assert.equal(attempts.results.length, 2)
    assert.deepEqual(attempts.results.map(row => row.actor_user_id).sort(), ['owner', 'publisher'])

    // The publishing call's connection dropped before Facebook answered: failed with that answer, and the post can be edited; publishing again publishes.
    const fourth = await create('key-4', { body: 'Lost feed', media: [{ asset_id: 'a2', slot: 'cover' }] })
    meta.fault('dropped', request => request.path.endsWith(`${PAGE}/feed`))
    const lost = await publishPost(env, 'org-a', fourth.post.id, { expectedUpdatedAt: fourth.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.deepEqual([lost.ok, lost.outcomes[0]!.status, lost.outcomes[0]!.code], [false, 'failed', 'provider_unreachable'])
    assert.equal(await publicationState(lost.outcomes[0]!.publication_id), 'failed')
    const pinned = (await getPost(db, env, 'org-a', fourth.post.id))!
    const receipt = pinned.publications[0]!
    assert.deepEqual((await mcp('get_post', { post_id: pinned.id })).post?.publications, [receipt])
    assert.deepEqual((await mcp('list_posts', {})).posts?.find(post => post.id === pinned.id)?.publications, [receipt])
    const replayedDraft = await mcp('create_post', { idempotency_key: 'key-4', body: 'Lost feed', media: [{ asset_id: 'a2', slot: 'cover' }] })
    assert.equal(replayedDraft.replayed, true)
    assert.equal(replayedDraft.post?.id, pinned.id)
    assert.deepEqual(replayedDraft.post?.publications, [receipt])
    const editedLost = await updatePost(db, cardless, 'org-a', fourth.post.id, { changes: { body: 'Edited' }, expectedUpdatedAt: pinned.updated_at }, 'owner')
    assert.equal(editedLost!.body, 'Edited')
    assert.equal((await mcp('list_posts', {})).posts?.find(post => post.id === pinned.id)?.body, 'Edited')
    assert.equal((await publishPost(env, 'org-a', fourth.post.id, { expectedUpdatedAt: editedLost!.updated_at, targets: [targets.facebook()] }, 'owner')).outcomes[0]!.status, 'published')
    await publishedOnMeta(fourth.post.id, 'facebook')

    // The publishing call took effect but its answer was lost: failed until reconciliation is told the post it became, which it reads on the Page.
    const fifth = await create('key-5', { body: 'Answer lost' })
    let createdId: string | null = null
    meta.fault('dropped', request => {
      if (request.method !== 'POST' || !request.path.endsWith(`${PAGE}/feed`)) return false
      createdId = `${PAGE}_answer-lost`
      meta.fbPosts.set(createdId, { published: true, message: request.body.message, link: request.body.link, attached: [] })
      return true
    })
    const answerLost = await publishPost(env, 'org-a', fifth.post.id, { expectedUpdatedAt: fifth.post.updated_at, targets: [targets.facebook()] }, 'owner')
    assert.deepEqual([answerLost.outcomes[0]!.status, answerLost.outcomes[0]!.code], ['failed', 'provider_unreachable'])
    const fifthPublication = (await getPost(db, env, 'org-a', fifth.post.id))!.publications[0]!
    assert.equal((await reconcilePostPublication(env, 'org-a', fifthPublication.id, createdId)).state, 'published')
    await publishedOnMeta(fifth.post.id, 'facebook')

    // Meta answering media_publish "not ready" (9007/2207027) on a FINISHED container is waited out by the same call.
    meta.publishNotReady = 2
    const notReadyYet = await create('key-not-ready', { media: [{ asset_id: 'a1', slot: 'cover' }] })
    const publishesBeforeWait = meta.sent(request => request.path.endsWith('media_publish')).length
    assert.equal((await publishPost(env, 'org-a', notReadyYet.post.id, { expectedUpdatedAt: notReadyYet.post.updated_at, targets: [targets.instagram()] }, 'owner')).outcomes[0]!.status, 'published')
    assert.equal(meta.sent(request => request.path.endsWith('media_publish')).length, publishesBeforeWait + 3)
    assert.equal(meta.publishNotReady, 0)
    await publishedOnMeta(notReadyYet.post.id, 'instagram')

    // Instagram refusing media_publish is a failed publication with Meta's reason; the next call prepares new containers and publishes.
    const refusedContainer = await create('key-refused-publish', { media: [{ asset_id: 'a1', slot: 'cover' }] })
    meta.fault('reject', request => request.path.endsWith('media_publish'))
    const refusedPublish = await publishPost(env, 'org-a', refusedContainer.post.id, { expectedUpdatedAt: refusedContainer.post.updated_at, targets: [targets.instagram()] }, 'owner')
    assert.equal(refusedPublish.outcomes[0]!.code, 'provider_rejected')
    assert.equal((await publishPost(env, 'org-a', refusedContainer.post.id, { expectedUpdatedAt: refusedContainer.post.updated_at, targets: [targets.instagram()] }, 'owner')).outcomes[0]!.status, 'published')
    await publishedOnMeta(refusedContainer.post.id, 'instagram')

    // An expired container is a definite non-publication; the next call prepares new ones.
    const expiring = await create('key-expire', { media: [{ asset_id: 'a2', slot: 'cover' }] })
    meta.expireNewContainers = true
    const expired = await publishPost(env, 'org-a', expiring.post.id, { expectedUpdatedAt: expiring.post.updated_at, targets: [targets.instagram()] }, 'owner')
    assert.equal(expired.outcomes[0]!.code, 'container_expired')
    meta.expireNewContainers = false
    assert.equal((await publishPost(env, 'org-a', expiring.post.id, { expectedUpdatedAt: expiring.post.updated_at, targets: [targets.instagram()] }, 'owner')).outcomes[0]!.status, 'published')
    await publishedOnMeta(expiring.post.id, 'instagram')

    // A published post keeps one receipt per channel.
    const racing = await create('key-race', { media: [{ asset_id: 'a1', slot: 'cover' }] })
    assert.equal((await publishPost(env, 'org-a', racing.post.id, { expectedUpdatedAt: racing.post.updated_at, targets: [targets.instagram()] }, 'owner')).outcomes[0]!.status, 'published')
    assert.equal(await db.prepare('SELECT count(*) FROM post_publications WHERE post_id = ?').bind(racing.post.id).first('count(*)'), 1)

    // After publication, local edits are allowed and nothing is re-sent; the management view says the website copy changed.
    const edited = await mcp('update_post', {
      post_id: racing.post.id, body: 'Edited later', updated_at: (await getPost(db, env, 'org-a', racing.post.id))!.updated_at,
    })
    const editedPost = (await getPost(db, env, 'org-a', racing.post.id))!
    assert.equal(editedPost.body, 'Edited later')
    const editedReceipt = editedPost.publications[0]!
    assert.equal(editedReceipt.local_content_changed, true)
    assert.deepEqual(edited.post?.publications, [editedReceipt])
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

test('Better Auth returns the Instagram account it linked to the native Connections screen', async (t) => {
  const { runtime, db, env, restore } = await setUp()
  const providerFetch = globalThis.fetch
  try {
    await db.prepare("INSERT INTO member(id, organizationId, userId, role, createdAt) VALUES ('member-owner', 'org-a', 'owner', 'owner', ?)").bind(Date.now()).run()
    const session = 'instagram-native-session'
    await db.prepare('INSERT INTO session(id, token, userId, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('instagram-native', session, 'owner', Date.now() + 60_000, Date.now(), Date.now()).run()
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.hostname === 'api.instagram.com' && url.pathname === '/oauth/access_token') return Response.json({ access_token: 'fixture-short' })
      if (url.hostname === 'graph.instagram.com' && url.pathname === '/access_token') return Response.json({ access_token: 'fixture-long', expires_in: 3600 })
      if (url.hostname === 'graph.instagram.com' && url.pathname === '/v23.0/me') return Response.json({ id: 'new-instagram-subject', user_id: 'new-professional-account', username: 'native_fixture' })
      return providerFetch(input, init)
    })
    const app = new H3()
    app.all('/api/dashboard/connection-authorization', connectionAuthorization)
    const local = (input: string | URL, init?: RequestInit) => app.request(Object.assign(new Request(
      new URL(input, 'https://proof.example'), init,
    ), { runtime: { name: 'cloudflare', cloudflare: { env } } }))
    const attempt = crypto.randomUUID()
    const start = await local('/api/dashboard/connection-authorization?org=org-a', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
      body: JSON.stringify({ integration: 'instagram', attempt }),
    })
    assert.equal(start.status, 200, await start.clone().text())
    const { authorization_url } = await start.json() as { authorization_url: string }
    const authorization = await local(authorization_url)
    assert.equal(authorization.status, 302)
    const provider = new URL(authorization.headers.get('location')!)
    assert.equal(provider.hostname, 'www.instagram.com')
    const callback = new URL(provider.searchParams.get('redirect_uri')!)
    assert.equal(callback.pathname, '/api/auth/callback/instagram')
    callback.search = new URLSearchParams({ state: provider.searchParams.get('state')!, code: 'fixture-instagram-code' }).toString()
    const cookies = authorization.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ')
    const completed = await createAuth(env).handler(new Request(callback, { headers: { cookie: cookies } }))
    assert.equal(completed.status, 302)
    const result = new URL(completed.headers.get('location')!)
    assert.equal(result.host, 'connections')
    assert.equal(result.pathname, '/instagram')
    assert.equal(result.searchParams.get('attempt'), attempt)
    assert.equal(result.searchParams.get('error'), null)
    const id = result.searchParams.get('account_id')
    assert.ok(id)
    const account = await db.prepare('SELECT providerId, accountId, userId FROM account WHERE id = ?').bind(id).first()
    assert.deepEqual(account, { providerId: 'instagram', accountId: 'new-instagram-subject', userId: 'owner' })
  } finally {
    t.mock.restoreAll()
    restore()
    await runtime.dispose()
  }
})

test('a provider resource belongs to one organization, and an organization has one of each', async () => {
  const { runtime, db, restore } = await setUp()
  try {
    // An agency's login also manages its client's Page; choosing it on the agency's own site is refused.
    const conflict = (error: unknown) => error instanceof HTTPError && error.status === 409 && /already connected to another Blawby site/.test(error.message)
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


test('a website edit that lands after publish has read the draft fails the publish as stale and keeps the edit', async () => {
  const { runtime, db, env, cardless, meta, restore } = await setUp()
  try {
    // A newer website edit can win after publish has already read the draft.
    const { post: draft } = await createPost(db, cardless, 'org-a', { post: { body: 'Draft for a website update' }, idempotencyKey: 'website-race' }, 'owner')
    let interleaved = false
    const publishWrites = new WeakSet<D1PreparedStatement>()
    const editingDb = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql)
        if (!sql.startsWith("UPDATE content_documents SET status = 'published'")) return statement
        return { bind(...params: unknown[]) {
          const bound = statement.bind(...params)
          publishWrites.add(bound)
          return bound
        } }
      }
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!statements.some(statement => publishWrites.has(statement))) return target.batch(statements)
        assert.equal(interleaved, false)
        interleaved = true
        const edited = await updatePost(db, cardless, 'org-a', draft.id, { changes: { body: 'A concurrent website edit' }, expectedUpdatedAt: draft.updated_at }, 'owner')
        assert.notEqual(edited?.updated_at, draft.updated_at)
        return target.batch(statements)
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const stale = await publishPost({ ...cardless, DB: editingDb }, 'org-a', draft.id, { expectedUpdatedAt: draft.updated_at, targets: [targets.website] }, 'owner')
    assert.equal(interleaved, true)
    assert.deepEqual(stale.outcomes.map(outcome => [outcome.status, outcome.code]), [['failed', 'stale_revision']])
    const updatedDraft = await getPost(db, env, 'org-a', draft.id)
    assert.equal(updatedDraft?.status, 'draft')
    assert.equal(updatedDraft.body, 'A concurrent website edit')
    const published = await publishPost(cardless, 'org-a', draft.id, { expectedUpdatedAt: updatedDraft.updated_at, targets: [targets.website] }, 'owner')
    assert.deepEqual(published.outcomes.map(outcome => outcome.status), ['published'])
    assert.equal((await getPost(db, env, 'org-a', draft.id))?.status, 'published')
    assert.equal(meta.sent(request => request.method === 'POST').length, 0)
  } finally {
    restore()
    await runtime.dispose()
  }
})
