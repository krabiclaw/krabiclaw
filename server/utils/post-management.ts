import { getSourceLocale } from '~/server/utils/organization-locales'
import { readIntegration } from '~/server/utils/organization-integrations'
import { HTTPError } from 'nitro'
import { createContentDocumentWithBlocks, documentOfRootSql, prepareContentDocumentDeletion, updateContentDocument, type ContentDocumentChanges } from '~/server/utils/content/documents'
import { parsePostInput, PostValidationError, type PostCallToAction, type PostMediaRef, type PostMutation } from '~/shared/posts'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { creationDedupeKey, creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { normalizePostSlug, postPublicPath } from '~/utils/post-slugs'
import { insertInitialMediaPlacements, hydrateMediaAssetRefs, readMediaPlacements, type StoredMediaPlacementItem } from '~/server/utils/media-asset-manager'
import { refreshSocialCard } from '~/server/utils/social-card'
import { loadPublicSocialMedia } from '~/server/utils/public-social-image'
import type { SocialImageSource } from '~/utils/social-metadata'
import { loadExactPublicLocalizations, projectLocalizedMediaAlt } from '~/server/utils/public-localization'
import { listPublicLocaleRepresentations } from '~/server/utils/public-locale-representations'
import type { CloudflareEnv } from '~/server/utils/auth'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { createPreviewToken, PREVIEW_TOKEN_QUERY, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { mcpPageInfo, type McpPageInfo } from '~/server/utils/mcp-pagination'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'

/**
 * A short post: the website document every surface reads and writes.
 *
 * MCP and the dashboard all go through these functions. A post
 * is created as a draft, is published only by `publishPost`, and has one
 * route from the moment it exists.
 */


const MAX_SLUG_ATTEMPTS = 20

export interface PostMedia {
  asset_id: string
  public_url: string
  thumbnail_url: string | null
  kind: 'image' | 'video'
  slot: 'cover' | 'gallery'
  sort_order: number
  alt_text: string | null
  width: number | null
  height: number | null
  mime_type: string | null
  duration: number | null
  /** The asset row's revision; part of what a publication fingerprints. */
  updated_at: string
}

/** What the management surfaces are told about one external publication. Never public. */
export interface PostPublicationSummary {
  id: string
  channel: 'facebook' | 'instagram' | 'discord'
  target_id: string
  state: 'preparing' | 'publishing' | 'published' | 'failed' | 'unknown' | 'removed'
  provider_post_id: string | null
  /** The provider's link: a public permalink for Meta, the message's place in Discord for people who can open that channel. */
  public_url: string | null
  code: string | null
  message: string | null
  published_at: string | null
  /** The website copy has changed since what was sent. The external post was not edited. */
  local_content_changed: boolean
}

export interface Post {
  id: string
  organization_id: string
  location_id: string | null
  slug: string
  title: string | null
  body: string | null
  call_to_action: PostCallToAction | null
  status: 'draft' | 'published'
  visibility: 'listed' | 'unlisted'
  source: 'manual' | 'template'
  published_at: string | null
  public_path: string
  canonical_url: string | null
  /** A signed link to the draft as it will render, for review before publication. */
  preview_url: string | null
  media: PostMedia[]
  social_image: SocialImageSource | null
  publications: PostPublicationSummary[]
  created_by: string | null
  created_at: string
  updated_at: string
}

interface PostRow {
  id: string
  organization_id: string
  location_id: string | null
  slug: string
  title: string | null
  body: string | null
  metadata_json: string
  status: Post['status']
  visibility: Post['visibility']
  source: Post['source']
  published_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

const POST_COLUMNS = `p.id, p.organization_id, p.location_id, p.slug, p.title, p.summary AS body, p.metadata_json, p.status, p.visibility, p.source,
  p.published_at, p.created_by, p.created_at, p.updated_at`

function callToActionOf(metadataJson: string): PostCallToAction | null {
  const metadata = JSON.parse(metadataJson) as { call_to_action?: PostCallToAction | null }
  return metadata.call_to_action ?? null
}

function absoluteUrl(origin: string | null, path: string) {
  if (!origin) return null
  return new URL(path, origin.endsWith('/') ? origin : `${origin}/`).toString()
}

async function resolveOrganizationPostOrigins(db: DbClient, env: CloudflareEnv, organizationId: string) {
  const domain = await queryFirst<{ domain: string; subdomain: string | null; is_public: number }>(db,
    `SELECT d.domain, o.subdomain, (${publicTenantVisibilitySql('o', false)}) AS is_public
     FROM organization_domains d JOIN organization o ON o.id = d.organization_id
     WHERE d.organization_id = ? AND d.role = 'canonical' AND d.status = 'active' AND ${publicTenantVisibilitySql('o', true)}`, [organizationId])
  const origin = domain ? tenantOrganizationOrigin({
    platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
    freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
    subdomain: domain.subdomain ?? '',
    canonicalDomain: domain.domain,
  }) : null
  return { publicOrigin: domain?.is_public ? origin : null, previewOrigin: origin }
}

async function validatePostLocation(db: DbClient, organizationId: string, locationId: string | null) {
  if (!locationId) return
  const location = await queryFirst<{ id: string }>(db, 'SELECT id FROM business_locations WHERE id = ? AND organization_id = ?', [locationId, organizationId])
  if (!location) throw new PostValidationError('location_id must name one of this organization\'s locations')
}

/**
 * The post's route segment: the caller's slug, or one made from its title or
 * body, or — for a post with no usable words — `update-<id>`. It is a
 * generated identifier, allocated once, never a reader's fallback.
 */
async function allocatePostSlug(db: DbClient, organizationId: string, postId: string, requested: string | null, title: string | null, body: string | null) {
  if (requested && !normalizePostSlug(requested)) throw new PostValidationError('slug must contain letters or numbers')
  const base = (requested ? normalizePostSlug(requested) : '') || normalizePostSlug(title || body?.slice(0, 80) || '') || `update-${postId}`
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`
    const existing = await queryFirst<{ id: string }>(db,
      "SELECT id FROM content_documents WHERE kind = 'social_post' AND row_role = 'root' AND organization_id = ? AND slug = ? AND id != ? LIMIT 1",
      [organizationId, slug, postId])
    if (!existing) return slug
    if (requested) throw new PostValidationError(`slug ${slug} is already used by another post`)
  }
  throw new PostValidationError(`No free slug near ${base}; pass a distinct slug`)
}

/** Cover, then gallery in order: the one order every surface and provider sees. */
export async function loadPostMedia(db: DbClient, organizationId: string, postIds: string[]): Promise<Map<string, PostMedia[]>> {
  const placements = await readMediaPlacements(db, { organizationId, ownerType: 'content_document', ownerIds: postIds })
  return new Map([...placements].map(([postId, items]) => [postId, orderedPostMedia(items)]))
}

function orderedPostMedia(items: readonly StoredMediaPlacementItem[]): PostMedia[] {
  return items
    .filter((item): item is StoredMediaPlacementItem & { kind: 'image' | 'video' } => (item.slot === 'cover' || item.slot === 'gallery') && (item.kind === 'image' || item.kind === 'video'))
    .sort((a, b) => (a.slot === b.slot ? a.sort_order - b.sort_order : a.slot === 'cover' ? -1 : 1))
    .map(item => ({
      asset_id: item.asset_id, public_url: item.public_url, thumbnail_url: item.thumbnail_url, kind: item.kind,
      slot: item.slot as 'cover' | 'gallery', sort_order: item.sort_order, alt_text: item.alt_text,
      width: item.width, height: item.height, mime_type: item.mime_type, duration: item.duration, updated_at: item.updated_at,
    }))
}

/**
 * What a publication sends, fingerprinted: the complete text and call to
 * action, the ordered media by identity and revision, and the destination.
 */
export async function postPayloadFingerprint(post: Pick<Post, 'body' | 'call_to_action' | 'media'>, destination: { channel: string; target_id: string }): Promise<string> {
  return await creationRequestHash({
    body: post.body, call_to_action: post.call_to_action,
    media: post.media.map(item => ({ asset_id: item.asset_id, revision: item.updated_at })),
    destination,
  })
}

interface PublicationRow {
  id: string
  post_id: string
  channel: PostPublicationSummary['channel']
  provider_target_id: string
  state: PostPublicationSummary['state']
  provider_post_id: string | null
  provider_permalink: string | null
  payload_hash: string
  error_code: string | null
  error_message: string | null
  published_at: string | null
}

async function loadPublicationRows(db: DbClient, organizationId: string, postIds: string[]) {
  if (!postIds.length) return new Map<string, PublicationRow[]>()
  const rows = await queryAll<PublicationRow>(db, `SELECT id, post_id, channel, provider_target_id, state, provider_post_id, provider_permalink,
      payload_hash, error_code, error_message, published_at
    FROM post_publications WHERE organization_id = ? AND post_id IN (SELECT value FROM json_each(?)) ORDER BY channel`,
  [organizationId, d1JsonStringSet(postIds)])
  const byPost = new Map<string, PublicationRow[]>()
  for (const row of rows) byPost.set(row.post_id, [...(byPost.get(row.post_id) ?? []), row])
  return byPost
}

async function attachPostFields(db: DbClient, env: CloudflareEnv, rows: PostRow[]): Promise<Post[]> {
  if (!rows.length) return []
  const organizationId = rows[0]!.organization_id
  const ids = rows.map(row => row.id)
  const [origins, media, social, publications] = await Promise.all([
    resolveOrganizationPostOrigins(db, env, organizationId),
    loadPostMedia(db, organizationId, ids),
    loadPublicSocialMedia(db, organizationId, 'content_document', ids),
    loadPublicationRows(db, organizationId, ids),
  ])
  const previewSecret = previewSecretOf(env)
  if (rows.some(row => row.status === 'draft') && !previewSecret) throw new HTTPError({ statusCode: 500, statusMessage: 'Preview signing is not configured' })
  const previewToken = rows.some(row => row.status === 'draft') && previewSecret
    ? await createPreviewToken(previewSecret, organizationId, Date.now() + PREVIEW_TOKEN_TTL_MS)
    : null
  return await Promise.all(rows.map(async (row) => {
    const publicPath = postPublicPath(row.slug)
    const post = { body: row.body, call_to_action: callToActionOf(row.metadata_json), media: media.get(row.id) ?? [] }
    return {
      ...row,
      ...post,
      public_path: publicPath,
      canonical_url: row.status === 'published' ? absoluteUrl(origins.publicOrigin, publicPath) : null,
      preview_url: row.status === 'draft' && previewToken ? absoluteUrl(origins.previewOrigin, `${publicPath}?${PREVIEW_TOKEN_QUERY}=${encodeURIComponent(previewToken)}`) : null,
      social_image: social.get(row.id)?.social_image ?? null,
      publications: await Promise.all((publications.get(row.id) ?? []).map(async publication => ({
        id: publication.id, channel: publication.channel, target_id: publication.provider_target_id,
        state: publication.state, provider_post_id: publication.provider_post_id, public_url: publication.provider_permalink,
        code: publication.error_code, message: publication.error_message, published_at: publication.published_at,
        local_content_changed: publication.payload_hash !== await postPayloadFingerprint(post, { channel: publication.channel, target_id: publication.provider_target_id }),
      }))),
    }
  }))
}

async function readPostRow(db: DbClient, organizationId: string, postId: string) {
  return await queryFirst<PostRow>(db, `SELECT ${POST_COLUMNS} FROM content_documents p
    WHERE p.kind = 'social_post' AND p.row_role = 'root' AND p.id = ? AND p.organization_id = ? LIMIT 1`, [postId, organizationId])
}

export async function getPost(db: DbClient, env: CloudflareEnv, organizationId: string, postId: string): Promise<Post | null> {
  const row = await readPostRow(db, organizationId, postId)
  if (!row) return null
  return (await attachPostFields(db, env, [row]))[0]!
}

/**
 * One page of an organization's posts, newest change first, read from the
 * database a page at a time. There is no lifetime ceiling.
 */
export async function listPosts(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
  filter: { status?: string | null; locationId?: string | null },
  window: { limit: number; offset: number },
  resource: { resource: string },
): Promise<{ posts: Post[]; page_info: McpPageInfo }> {
  if (filter.status && filter.status !== 'draft' && filter.status !== 'published') throw new PostValidationError('status must be draft or published')
  const rows = await queryAll<PostRow>(db, `SELECT ${POST_COLUMNS} FROM content_documents p
    WHERE p.kind = 'social_post' AND p.row_role = 'root' AND p.organization_id = ?
      ${filter.status ? 'AND p.status = ?' : ''} ${filter.locationId ? 'AND p.location_id = ?' : ''}
    ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`,
  [organizationId, ...(filter.status ? [filter.status] : []), ...(filter.locationId ? [filter.locationId] : []), window.limit + 1, window.offset])
  const page = rows.slice(0, window.limit)
  return { posts: await attachPostFields(db, env, page), page_info: mcpPageInfo(window, page.length, rows.length > window.limit, resource) }
}

/**
 * Refuses a content change while a publication of this post is in flight or
 * unresolved: what Meta receives, or may already have received, must be what
 * the fingerprint says. As a batch statement, so the refusal and the write are
 * one decision.
 */
export function postPublicationIdleQuery(organizationId: string, postId: string): BatchQuery {
  const now = new Date().toISOString()
  return {
    query: `INSERT INTO content_blocks (id, document_id, parent_block_id, type, position, level, data_json, created_at, updated_at)
      SELECT NULL, ?, NULL, 'markdown', 0, NULL, '{}', ?, ?
       WHERE EXISTS (SELECT 1 FROM post_publications WHERE organization_id = ? AND post_id = ? AND state IN ('preparing', 'publishing', 'unknown'))`,
    params: [postId, now, now, organizationId, postId],
  }
}

async function assertPublicationIdle(db: DbClient, organizationId: string, postId: string) {
  const active = await queryFirst<{ id: string; channel: string; state: string }>(db,
    "SELECT id, channel, state FROM post_publications WHERE organization_id = ? AND post_id = ? AND state IN ('preparing', 'publishing', 'unknown') LIMIT 1",
    [organizationId, postId])
  if (active) {
    throw new HTTPError({ statusCode: 409, statusMessage: active.state === 'unknown'
      ? `The ${active.channel} publication ${active.id} is unresolved; reconcile it before changing what it sent`
      : `The ${active.channel} publication ${active.id} is in progress; wait for it before changing what it sends` })
  }
}

/**
 * The statements a media placement change on a post's cover or gallery adds
 * to its own batch: the same active-publication refusal as a text edit, the
 * post's content revision, and the ownership change a local media edit is.
 */
export async function postMediaMutationQueries(db: DbClient, input: { organizationId: string; ownerType: string; ownerId: string; slot: string }): Promise<BatchQuery[]> {
  if (input.ownerType !== 'content_document' || (input.slot !== 'cover' && input.slot !== 'gallery')) return []
  const post = await queryFirst<{ updated_at: string }>(db,
    "SELECT updated_at FROM content_documents WHERE id = ? AND organization_id = ? AND kind = 'social_post' AND row_role = 'root'", [input.ownerId, input.organizationId])
  if (!post) return []
  await assertPublicationIdle(db, input.organizationId, input.ownerId)
  const updatedAt = new Date(Math.max(Date.now(), Date.parse(post.updated_at) + 1)).toISOString()
  return [
    postPublicationIdleQuery(input.organizationId, input.ownerId),
    { query: `UPDATE content_documents SET updated_at = ?, source = 'manual' WHERE id = ? AND organization_id = ? AND kind = 'social_post' AND row_role = 'root'`,
      params: [updatedAt, input.ownerId, input.organizationId] },
  ]
}

function isSlugConflict(error: unknown) {
  return /UNIQUE constraint failed/.test(error instanceof Error ? error.message : String(error)) && /content_documents\.(slug|organization_id)/.test(String(error))
}

/**
 * Creates a draft. Repeating the same idempotency key with the same request
 * returns the post it made; a different request under that key conflicts; a key
 * whose post was deleted answers gone and does not make it again.
 */
export async function createPost(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
  input: { post: unknown; idempotencyKey: string },
  createdBy: string,
): Promise<{ post: Post; replayed: boolean }> {
  const key = input.idempotencyKey.trim()
  if (!key || key.length > 200) throw new PostValidationError('idempotency_key must be 1 to 200 characters')
  const data = parsePostInput(input.post, 'create')
  const requestHash = await creationRequestHash(data)
  const dedupeKey = creationDedupeKey('social_post', organizationId, key)
  const replay = async () => {
    const record = await readCreationRecord(db, dedupeKey)
    if (!record) return null
    if (record.requestHash !== requestHash) throw new HTTPError({ statusCode: 409, statusMessage: 'This idempotency_key was already used for a different post' })
    const post = await getPost(db, env, organizationId, record.entityId)
    if (!post) throw new HTTPError({ statusCode: 410, statusMessage: 'The post this idempotency_key created has been deleted; it is not created again' })
    await refreshSocialCard({ db, env, owner: { owner_type: 'content_document', owner_id: post.id }, actorId: createdBy })
    const completed = await getPost(db, env, organizationId, post.id)
    if (!completed) throw new Error(`Post ${post.id} is missing after creation recovery`)
    return { post: completed, replayed: true }
  }
  const earlier = await replay()
  if (earlier) return earlier

  let writeStarted = false
  try {
    await validatePostLocation(db, organizationId, data.location_id ?? null)
    const media: PostMediaRef[] = data.media ?? []
    await hydrateMediaAssetRefs(db, { organizationId, refs: media.map(item => ({ asset_id: item.asset_id })), allowedKinds: ['image', 'video'], fieldName: 'media' })
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const cover = media.filter(item => item.slot === 'cover')
    const gallery = media.filter(item => item.slot === 'gallery')
    for (let attempt = 0; ; attempt += 1) {
      const slug = await allocatePostSlug(db, organizationId, id, data.slug ?? null, data.title ?? null, data.body ?? null)
      try {
        writeStarted = true
        await createContentDocumentWithBlocks(db, {
          id, rowRole: 'root', kind: 'social_post', locale: await getSourceLocale(db, organizationId), organizationId,
          locationId: data.location_id ?? null, slug, title: data.title ?? null, summary: data.body ?? null,
          status: 'draft', visibility: data.visibility ?? 'listed', source: 'manual', createdBy, updatedBy: createdBy,
          metadata: data.call_to_action ? { call_to_action: data.call_to_action } : {},
        }, [], { additionalQueriesAfter: [
          ...insertInitialMediaPlacements({ organizationId, placement: { owner_type: 'content_document', owner_id: id, slot: 'cover' }, media: cover, now }),
          ...insertInitialMediaPlacements({ organizationId, placement: { owner_type: 'content_document', owner_id: id, slot: 'gallery' }, media: gallery, now }),
          organizationEventQuery({
            organizationId, locationId: data.location_id ?? null, actorId: createdBy, eventType: 'post.created',
            entityType: 'post', entityId: id, metadata: { request_hash: requestHash }, dedupeKey,
          }),
        ] })
        break
      } catch (error) {
        if (isUniqueDedupeConflict(error)) {
          const concurrent = await replay()
          if (concurrent) return concurrent
        }
        if (!data.slug && attempt < 2 && isSlugConflict(error)) continue
        throw error
      }
    }
    await refreshSocialCard({ db, env, owner: { owner_type: 'content_document', owner_id: id }, actorId: createdBy })
    const created = await getPost(db, env, organizationId, id)
    if (!created) throw new Error(`Post ${id} is missing after creation`)
    return { post: created, replayed: false }
  } catch (error) {
    if (!writeStarted && error instanceof PostValidationError) {
      error.data = { mutation_applied: false }
      throw error
    }
    if (!writeStarted && HTTPError.isError(error)) throw new HTTPError({
      cause: error, body: error.body,
      data: { ...(error.data !== null && typeof error.data === 'object' && !Array.isArray(error.data) ? error.data : {}), mutation_applied: false },
    })
    throw error
  }
}

/**
 * Changes what the caller names. `expected_updated_at` is the caller's own
 * token; nothing reads a fresh one on its behalf. Editing the words, the call
 * to action or the media marks the post as authored (`manual`).
 */
export async function updatePost(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
  postId: string,
  input: { changes: unknown; expectedUpdatedAt: string },
  updatedBy: string,
): Promise<Post | null> {
  const existing = await readPostRow(db, organizationId, postId)
  if (!existing) return null
  if (existing.updated_at !== input.expectedUpdatedAt) throw new HTTPError({ statusCode: 409, statusMessage: 'The post changed since it was read; read it again' })
  const data: PostMutation = parsePostInput(input.changes, 'update')
  if (data.slug !== undefined && data.slug !== existing.slug) throw new PostValidationError('A post keeps its saved slug')
  delete data.slug
  if (!Object.keys(data).length) throw new PostValidationError('Name at least one field to change')
  const refreshCard = data.title !== undefined || data.body !== undefined || data.location_id !== undefined
  // A field sent with its existing value does not wait on a publication.
  if (data.title !== undefined && data.title === existing.title) delete data.title
  if (data.body !== undefined && data.body === existing.body) delete data.body
  if (data.call_to_action !== undefined && JSON.stringify(data.call_to_action) === JSON.stringify(callToActionOf(existing.metadata_json))) delete data.call_to_action
  if (!Object.keys(data).length) {
    if (refreshCard) await refreshSocialCard({ db, env, owner: { owner_type: 'content_document', owner_id: postId }, actorId: updatedBy })
    return await getPost(db, env, organizationId, postId)
  }
  if (data.location_id !== undefined) await validatePostLocation(db, organizationId, data.location_id)
  const contentChanged = data.title !== undefined || data.body !== undefined || data.call_to_action !== undefined
  const payloadChanged = data.body !== undefined || data.call_to_action !== undefined
  if (payloadChanged) await assertPublicationIdle(db, organizationId, postId)

  const changes: ContentDocumentChanges = { updated_by: updatedBy }
  if (data.title !== undefined) changes.title = data.title
  if (data.body !== undefined) changes.summary = data.body
  if (data.visibility !== undefined) changes.visibility = data.visibility
  if (data.location_id !== undefined) changes.location_id = data.location_id
  if (data.call_to_action) changes.metadata = { call_to_action: data.call_to_action }
  if (contentChanged) changes.source = 'manual'
  await updateContentDocument(db, postId, {
    expected_updated_at: input.expectedUpdatedAt, changes,
    additionalQueriesBefore: payloadChanged ? [postPublicationIdleQuery(organizationId, postId)] : [],
    additionalQueriesAfter: [
      // Removing the call to action removes the key; json_set would store a JSON null.
      ...(data.call_to_action === null ? [{ query: "UPDATE content_documents SET metadata_json = json_remove(metadata_json, '$.call_to_action') WHERE id = ? AND organization_id = ?", params: [postId, organizationId] }] : []),
      ...(data.visibility === undefined ? [] : [publicResourceCacheInvalidationQuery(organizationId, 'post-visibility')]),
    ],
  })
  // The card draws the title, the words and the location's name.
  if (refreshCard) {
    await refreshSocialCard({ db, env, owner: { owner_type: 'content_document', owner_id: postId }, actorId: updatedBy })
  }
  return await getPost(db, env, organizationId, postId)
}

/**
 * Deletes the website post. Its external publications are detached, not
 * erased: receipts retain what was published. The Facebook or Instagram post itself is untouched.
 */
export async function deletePost(db: DbClient, organizationId: string, postId: string, actorId: string | null): Promise<boolean> {
  const existing = await readPostRow(db, organizationId, postId)
  if (!existing) return false
  await assertPublicationIdle(db, organizationId, postId)
  const results = await executeBatch(db, [
    postPublicationIdleQuery(organizationId, postId),
    { query: 'UPDATE post_publications SET post_id = NULL, updated_at = ? WHERE organization_id = ? AND post_id = ?', params: [new Date().toISOString(), organizationId, postId] },
    organizationEventQuery({ organizationId, locationId: existing.location_id, actorId, eventType: 'post.deleted', entityType: 'post', entityId: postId }),
    ...prepareContentDocumentDeletion({ documentId: postId, organizationId }),
  ])
  return Number(results.at(-1)?.meta.changes ?? 0) > 0
}

// ── Public projection ─────────────────────────────────────────────────────

export interface PublicPostMedia {
  asset_id: string
  public_url: string
  thumbnail_url: string | null
  kind: 'image' | 'video'
  alt_text: string | null
  width: number | null
  height: number | null
}

/** A post as a visitor sees it, whichever template draws it. */
export interface PublicSocialPost {
  id: string
  slug: string
  path: string
  url: string | null
  title: string | null
  body: string | null
  call_to_action: PostCallToAction | null
  media: PublicPostMedia[]
  published_at: string | null
  location: { id: string; title: string; slug: string } | null
  /** Only confirmed external publications; a link only when the provider returned one. */
  publications: Array<{ channel: 'facebook' | 'instagram'; url: string | null; account_name: string | null }>
  social_image: SocialImageSource | null
  status: 'draft' | 'published'
  /** Whether the post is in feeds; an unlisted one answers at its own address only. */
  visibility: 'listed' | 'unlisted'
}

interface PublicPostRow {
  id: string
  representation_id: string
  slug: string
  title: string | null
  body: string | null
  root_metadata_json: string
  metadata_json: string
  published_at: string | null
  status: 'draft' | 'published'
  visibility: 'listed' | 'unlisted'
  location_id: string | null
  location_title: string | null
  location_slug: string | null
}

async function projectPublicPosts(env: CloudflareEnv, db: DbClient, organizationId: string, rows: PublicPostRow[], locale: string): Promise<PublicSocialPost[]> {
  if (!rows.length) return []
  const sourceLocale = await getSourceLocale(db, organizationId)
  const rootIds = rows.map(row => row.id)
  const [origins, media, social, publications, localizations, facebook, instagram] = await Promise.all([
    resolveOrganizationPostOrigins(db, env, organizationId),
    loadPostMedia(db, organizationId, rootIds),
    loadPublicSocialMedia(db, organizationId, 'content_document', rows.map(row => row.representation_id)),
    // A Discord channel's messages are readable only by its members, so the public page names only Meta's public posts.
    queryAll<{ post_id: string; channel: 'facebook' | 'instagram'; provider_permalink: string | null; provider_target_id: string }>(db, `SELECT post_id, channel, provider_permalink, provider_target_id
      FROM post_publications WHERE organization_id = ? AND state = 'published' AND channel IN ('facebook', 'instagram') AND post_id IN (SELECT value FROM json_each(?)) ORDER BY channel`,
    [organizationId, d1JsonStringSet(rootIds)]),
    locale === sourceLocale ? Promise.resolve(null) : loadExactPublicLocalizations(env, db, organizationId, locale),
    readIntegration(db, organizationId, 'facebook'),
    readIntegration(db, organizationId, 'instagram'),
  ])
  return rows.map((row) => {
    const rootAction = callToActionOf(row.root_metadata_json)
    const localizedLabel = row.representation_id === row.id ? null : callToActionOf(row.metadata_json)?.label ?? null
    const path = (locale === sourceLocale ? '' : `/${locale}`) + postPublicPath(row.slug)
    return {
      id: row.id,
      slug: row.slug,
      path,
      url: absoluteUrl(origins.publicOrigin, path),
      title: row.title?.trim() ? row.title : null,
      body: row.body?.trim() ? row.body : null,
      call_to_action: rootAction ? { label: localizedLabel ?? rootAction.label, url: rootAction.url } : null,
      media: projectLocalizedMediaAlt((media.get(row.id) ?? []).map(item => ({
        asset_id: item.asset_id, public_url: item.public_url, thumbnail_url: item.thumbnail_url, kind: item.kind,
        alt_text: item.alt_text, width: item.width, height: item.height,
      })), localizations),
      published_at: row.published_at,
      location: row.location_id && row.location_title && row.location_slug ? { id: row.location_id, title: row.location_title, slug: row.location_slug } : null,
      publications: publications.filter(item => item.post_id === row.id).map(item => ({ channel: item.channel, url: item.provider_permalink, account_name: [facebook, instagram].find(connection => connection?.provider === item.channel && connection.target_id === item.provider_target_id)?.target_name ?? null })),
      social_image: social.get(row.representation_id)?.social_image ?? null,
      status: row.status,
      visibility: row.visibility,
    }
  })
}

const PUBLIC_POST_SELECT = `SELECT root.id, p.id AS representation_id, COALESCE(p.slug, root.slug) AS slug, p.title, p.summary AS body,
    root.metadata_json AS root_metadata_json, p.metadata_json, root.published_at, root.status, root.visibility,
    root.location_id, bl.title AS location_title, bl.slug AS location_slug
  FROM content_documents root
  JOIN content_documents p ON ${documentOfRootSql('p', 'root')} AND p.locale = ?
  LEFT JOIN business_locations bl ON bl.id = root.location_id AND bl.organization_id = root.organization_id AND bl.status = 'active'`

/**
 * The organization's published, listed posts in one locale, newest first, a
 * page at a time. This is the feed `/posts` and every `social_posts` block read.
 */
export async function listPublicSocialPosts(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  input: { locale: string; locationId?: string | null; window: { limit: number; offset: number }; resource: string },
): Promise<{ posts: PublicSocialPost[]; page_info: McpPageInfo }> {
  const rows = await queryAll<PublicPostRow>(db, `${PUBLIC_POST_SELECT}
    WHERE root.kind = 'social_post' AND root.row_role = 'root' AND root.organization_id = ? AND root.status = 'published' AND root.visibility = 'listed'
      ${input.locationId ? 'AND root.location_id = ?' : ''}
    ORDER BY root.published_at DESC, root.id DESC LIMIT ? OFFSET ?`,
  [input.locale, organizationId, ...(input.locationId ? [input.locationId] : []), input.window.limit + 1, input.window.offset])
  const page = rows.slice(0, input.window.limit)
  return { posts: await projectPublicPosts(env, db, organizationId, page, input.locale), page_info: mcpPageInfo(input.window, page.length, rows.length > input.window.limit, { resource: input.resource }) }
}

/**
 * One post by its public route, in the locale asked for. A draft is returned
 * only to an authorized preview; unlisted posts answer at their own address.
 */
export async function getPublicSocialPost(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  slug: string,
  locale: string,
  previewAuthorized = false,
) {
  const organization = await queryFirst<{ id: string }>(db, "SELECT id FROM organization WHERE id = ? AND status = 'active' LIMIT 1", [organizationId])
  if (!organization) return null
  const sourceLocale = await getSourceLocale(db, organizationId)
  const row = await queryFirst<PublicPostRow>(db, `${PUBLIC_POST_SELECT}
    WHERE root.kind = 'social_post' AND root.row_role = 'root' AND root.organization_id = ?
      AND ${locale === sourceLocale ? 'root.slug = ?' : "p.row_role = 'representation' AND p.path = ?"}
      ${previewAuthorized ? '' : "AND root.status = 'published'"} LIMIT 1`,
  [locale, organizationId, locale === sourceLocale ? slug : postPublicPath(slug)])
  if (!row) return null
  const [post] = await projectPublicPosts(env, db, organizationId, [row], locale)
  const source = await queryFirst<{ slug: string }>(db, 'SELECT slug FROM content_documents WHERE id = ?', [row.id])
  const localeRepresentations = await listPublicLocaleRepresentations(env, db, {
    organizationId, sourcePath: postPublicPath(source!.slug), documentId: row.id,
  })
  return { ...post!, localeRepresentations }
}
