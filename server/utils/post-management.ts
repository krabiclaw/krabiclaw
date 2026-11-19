import { getSourceLocale } from '~/server/utils/organization-locales'
import { integrationsFromRows, integrationsQuery } from '~/server/utils/organization-integrations'
import { HTTPError } from 'nitro'
import { createContentDocumentWithBlocks, documentOfRootSql, prepareContentDocumentDeletion, updateContentDocument, type ContentDocumentChanges, type ContentDocumentRow } from '~/server/utils/content/documents'
import { parsePostInput, PostValidationError, type PostCallToAction, type PostMediaRef, type PostMutation } from '~/shared/posts'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { creationDedupeKey, creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { normalizePostSlug, postPublicPath } from '~/utils/post-slugs'
import { buildMediaPlacementReplacementQueries, insertInitialMediaPlacements, groupMediaPlacements, hydrateMediaAssetRefs, mediaPlacementsQuery, type StoredMediaPlacementItem } from '~/server/utils/media-asset-manager'
import { refreshSocialCard } from '~/server/utils/social-card'
import { publicSocialMediaFromPlacements, type SocialImageSource } from '~/utils/social-metadata'
import { resourceLocationScopeSql, type ViewerTerms } from '~/server/utils/member-access'
import { loadExactPublicLocalizations, projectLocalizedMediaAlt, type ExactPublicLocalization } from '~/server/utils/public-localization'
import { listPublicLocaleRepresentations } from '~/server/utils/public-locale-representations'
import type { CloudflareEnv } from '~/server/utils/auth'
import { SOCIAL_POSTS_BLOCK_DEFAULT } from '~/utils/tenant-page-blocks'
import { createPreviewToken, PREVIEW_TOKEN_QUERY, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { mcpPageInfo, type McpPageInfo } from '~/server/utils/mcp-pagination'
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
  state: 'published' | 'failed' | 'removed'
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
  published_at: string | null
  public_path: string
  canonical_url: string | null
  /** A signed link to the draft as it will render, for review before publication. */
  preview_url: string | null
  media: PostMedia[]
  social_image: SocialImageSource | null
  publications: PostPublicationSummary[]
  author_id?: string | null
  author_name?: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

interface PostRow extends ContentDocumentRow {
  location_id: string | null
  slug: string
  title: string | null
  body: string | null
  metadata_json: string
  status: Post['status']
  visibility: Post['visibility']
  published_at: string | null
  author_id?: string | null
  author_name?: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

const POST_COLUMNS = `p.id, p.organization_id, p.location_id, p.slug, p.title, p.summary AS body, p.metadata_json, p.status, p.visibility,
  p.published_at, p.author_id, p.created_by, u.name AS author_name, p.created_at, p.updated_at, p.kind, p.row_role, p.root_id, p.locale`

export function recentPostCardsQuery(organization: string | { sql: string }): BatchQuery {
  return {
    query: `SELECT p.id, p.title, p.status, p.published_at, count(*) OVER () AS total
      FROM content_documents p
      WHERE p.kind = 'social_post' AND p.row_role = 'root' AND p.organization_id = ${typeof organization === 'string' ? '?' : organization.sql}
      ORDER BY p.updated_at DESC, p.id DESC LIMIT 3`,
    params: typeof organization === 'string' ? [organization] : [],
  }
}

function callToActionOf(metadataJson: string): PostCallToAction | null {
  const metadata = JSON.parse(metadataJson) as { call_to_action?: PostCallToAction | null }
  return metadata.call_to_action ?? null
}

function absoluteUrl(origin: string | null, path: string) {
  if (!origin) return null
  return new URL(path, origin.endsWith('/') ? origin : `${origin}/`).toString()
}

type PostOriginRow = { domain: string; subdomain: string | null; is_public: number }

function postOriginsQuery(organization: string | { sql: string }): BatchQuery {
  return {
    query: `SELECT d.domain, o.subdomain, (${publicTenantVisibilitySql('o', false)}) AS is_public
      FROM organization_domains d JOIN organization o ON o.id = d.organization_id
      WHERE d.organization_id = ${typeof organization === 'string' ? '?' : organization.sql}
        AND d.role = 'canonical' AND d.status = 'active' AND ${publicTenantVisibilitySql('o', true)}`,
    params: typeof organization === 'string' ? [organization] : [],
  }
}

function postOrigins(domain: PostOriginRow | null | undefined, env: CloudflareEnv) {
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
  updated_at: string
}

function preparePostRecords(records: BatchQuery, limit?: number) {
  const organization = { sql: '(SELECT organization_id FROM post_scope LIMIT 1)' }
  const owners = { sql: `SELECT id FROM post_scope${limit === undefined ? '' : ' LIMIT ' + limit}` }
  return {
    queries: [records, ...[
      postOriginsQuery(organization),
      mediaPlacementsQuery({ organizationId: organization, ownerType: 'content_document', owners, includeOrganizationFallback: true }),
      {
        query: `SELECT id, post_id, channel, provider_target_id, state, provider_post_id, provider_permalink,
          payload_hash, error_code, error_message, published_at, updated_at
          FROM post_publications WHERE organization_id = ${organization.sql} AND post_id IN (${owners.sql}) ORDER BY channel`,
      },
    ].map(statement => ({ query: `WITH post_scope AS (${records.query}) ${statement.query}`, params: [...(records.params ?? []), ...(statement.params ?? [])] }))],
    async read([records, domains, assets, channels]: D1Result[], env: CloudflareEnv) {
      const rows = records!.results as PostRow[]
      const page = limit === undefined ? rows : rows.slice(0, limit)
      if (!page.length) return { posts: [], count: rows.length }
      return { posts: await attachPostFields(env, page, domains!.results[0] as PostOriginRow | undefined,
        groupMediaPlacements(assets!.results), channels!.results as PublicationRow[]), count: rows.length }
    },
  }
}

async function attachPostFields(env: CloudflareEnv, rows: PostRow[], domain: PostOriginRow | undefined,
  placements: Map<string, StoredMediaPlacementItem[]>, publicationRows: PublicationRow[]): Promise<Post[]> {
  const organizationId = rows[0]!.organization_id
  const origins = postOrigins(domain, env)
  const brand = (placements.get(organizationId) ?? []).filter(item => item.owner_type === 'organization')
  const publications = new Map<string, PublicationRow[]>()
  for (const row of publicationRows) publications.set(row.post_id, [...(publications.get(row.post_id) ?? []), row])
  const previewSecret = previewSecretOf(env)
  if (rows.some(row => row.status === 'draft') && !previewSecret) throw new HTTPError({ statusCode: 500, statusMessage: 'Preview signing is not configured' })
  const previewToken = rows.some(row => row.status === 'draft') && previewSecret
    ? await createPreviewToken(previewSecret, organizationId, Date.now() + PREVIEW_TOKEN_TTL_MS)
    : null
  return await Promise.all(rows.map(async (row) => {
    const publicPath = postPublicPath(row.slug)
    const items = (placements.get(row.id) ?? []).filter(item => item.owner_type === 'content_document')
    const post = { body: row.body, call_to_action: callToActionOf(row.metadata_json), media: orderedPostMedia(items) }
    const { kind: _kind, row_role: _role, root_id: _rootId, locale: _locale, ...fields } = row
    return {
      ...fields,
      ...post,
      public_path: publicPath,
      canonical_url: row.status === 'published' ? absoluteUrl(origins.publicOrigin, publicPath) : null,
      preview_url: row.status === 'draft' && previewToken ? absoluteUrl(origins.previewOrigin, `${publicPath}?${PREVIEW_TOKEN_QUERY}=${encodeURIComponent(previewToken)}`) : null,
      social_image: publicSocialMediaFromPlacements('content_document', items, brand).social_image,
      publications: await Promise.all((publications.get(row.id) ?? []).map(async publication => ({
        id: publication.id, channel: publication.channel, target_id: publication.provider_target_id,
        state: publication.state, provider_post_id: publication.provider_post_id, public_url: publication.provider_permalink,
        code: publication.error_code, message: publication.error_message, published_at: publication.published_at,
        local_content_changed: publication.payload_hash !== await postPayloadFingerprint(post, { channel: publication.channel, target_id: publication.provider_target_id }),
      }))),
    }
  }))
}

function postRecordQuery(organization: string | { sql: string }, postId: string, viewer?: ViewerTerms): BatchQuery {
  return {
    query: `SELECT ${POST_COLUMNS} FROM content_documents p
      LEFT JOIN user u ON u.id = COALESCE(p.author_id, p.created_by)
      WHERE p.kind = 'social_post' AND p.row_role = 'root' AND p.id = ?
        AND p.organization_id = ${typeof organization === 'string' ? '?' : organization.sql}
        ${viewer ? 'AND ' + resourceLocationScopeSql(viewer, 'p') : ''} LIMIT 1`,
    params: [postId, ...(typeof organization === 'string' ? [organization] : [])],
  }
}

export function preparePost(organization: string | { sql: string }, postId: string, viewer?: ViewerTerms) {
  const plan = preparePostRecords(postRecordQuery(organization, postId, viewer))
  return { queries: plan.queries, async read(rows: D1Result[], env: CloudflareEnv) {
    return (await plan.read(rows, env)).posts[0] ?? null
  }, snapshot: readPostSnapshot }
}

function readPostSnapshot([records, , assets]: D1Result[]) {
  const document = records!.results[0] as PostRow | undefined
  if (!document) return null
  const media = groupMediaPlacements(assets!.results).get(document.id) ?? []
  return { document, media: orderedPostMedia(media) }
}

async function readPostRow(db: DbClient, organizationId: string, postId: string) {
  const { query, params } = postRecordQuery(organizationId, postId)
  return queryFirst<PostRow>(db, query, params)
}

export async function getPost(db: DbClient, env: CloudflareEnv, organizationId: string, postId: string): Promise<Post | null> {
  const plan = preparePost(organizationId, postId)
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read the post and its publication data' }), env)
}

type PostListFilter = { status?: string | null; locationId?: string | null }

function postListQuery(organizationId: string | { sql: string }, filter: PostListFilter, window: { limit: number; offset: number }): BatchQuery {
  if (filter.status && filter.status !== 'draft' && filter.status !== 'published') throw new PostValidationError('status must be draft or published')
  return { query: `SELECT ${POST_COLUMNS} FROM content_documents p
    LEFT JOIN user u ON u.id = COALESCE(p.author_id, p.created_by)
    WHERE p.kind = 'social_post' AND p.row_role = 'root' AND p.organization_id = ${typeof organizationId === 'string' ? '?' : organizationId.sql}
      ${filter.status ? 'AND p.status = ?' : ''} ${filter.locationId ? 'AND p.location_id = ?' : ''}
    ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`, params: [...(typeof organizationId === 'string' ? [organizationId] : []), ...(filter.status ? [filter.status] : []), ...(filter.locationId ? [filter.locationId] : []), window.limit + 1, window.offset] }
}

export function preparePostList(organizationId: string | { sql: string }, filter: PostListFilter, window: { limit: number; offset: number }) {
  const list = postListQuery(organizationId, filter, window)
  const owners = { sql: `SELECT id FROM (${list.query}) LIMIT ${window.limit}`, params: list.params ?? [] }
  const organization = typeof organizationId === 'string' ? '?' : organizationId.sql
  return {
    queries: [list, mediaPlacementsQuery({ organizationId, ownerType: 'content_document', owners, slot: 'cover' }), {
      query: `SELECT post_id, channel, state FROM post_publications
        WHERE organization_id = ${organization} AND state = 'published' AND post_id IN (${owners.sql}) ORDER BY post_id, channel`,
      params: [...(typeof organizationId === 'string' ? [organizationId] : []), ...owners.params],
    }],
    read([listed, covers, published]: D1Result[], resource: { resource: string }) {
      const rows = listed!.results as PostRow[]
      const media = groupMediaPlacements(covers!.results)
      const publications = new Map<string, Array<{ channel: string; state: string }>>()
      for (const { post_id, channel, state } of published!.results as { post_id: string; channel: string; state: string }[]) {
        const group = publications.get(post_id) ?? []
        group.push({ channel, state })
        publications.set(post_id, group)
      }
      const posts = rows.slice(0, window.limit).map(({ id, title, body, status, visibility, author_name, updated_at, published_at }) => ({
        id, title, body, status, visibility, author_name, updated_at, published_at,
        media: orderedPostMedia(media.get(id) ?? []), publications: publications.get(id) ?? [],
      }))
      return { posts, page_info: mcpPageInfo(window, posts.length, rows.length > window.limit, resource) }
    },
  }
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
  const plan = preparePostRecords(postListQuery(organizationId, filter, window), window.limit)
  const { posts, count } = await plan.read(await executeBatch(db, plan.queries, { operation: 'Read the posts and publications' }), env)
  return { posts, page_info: mcpPageInfo(window, posts.length, count > window.limit, resource) }
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
  const updatedAt = new Date(Math.max(Date.now(), Date.parse(post.updated_at) + 1)).toISOString()
  return [
    { query: `UPDATE content_documents SET updated_at = ? WHERE id = ? AND organization_id = ? AND kind = 'social_post' AND row_role = 'root'`,
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
  const dedupeKey = creationDedupeKey('social_post', organizationId, key)
  let data: PostMutation
  try {
    if (!key || key.length > 200) throw new PostValidationError('idempotency_key must be 1 to 200 characters')
    data = parsePostInput(input.post, 'create')
  } catch (error) {
    // Rejected input may still name a key whose earlier request committed.
    if (error instanceof PostValidationError && !await readCreationRecord(db, dedupeKey)) error.data = { mutation_applied: false }
    throw error
  }
  const requestHash = await creationRequestHash(data)
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
          status: 'draft', visibility: data.visibility ?? 'listed', createdBy, updatedBy: createdBy,
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
 * Changes what the caller names. `updated_at` is the caller's own
 * token; nothing reads a fresh one on its behalf. Editing the words, the call
 * to action or the media marks the post as authored (`manual`).
 */
export async function updatePost(
  db: DbClient,
  env: CloudflareEnv,
  organizationId: string,
  postId: string,
  input: { changes: unknown; expectedUpdatedAt: string; media?: unknown; snapshot?: NonNullable<ReturnType<typeof readPostSnapshot>> },
  updatedBy: string,
): Promise<Post | null> {
  const plan = input.snapshot ? null : preparePost(organizationId, postId)
  const snapshot = input.snapshot ?? plan!.snapshot(await executeBatch(db, plan!.queries, { operation: 'Read the post being edited' }))
  if (!snapshot) return null
  const { document: existing, media } = snapshot
  if (existing.id !== postId || existing.organization_id !== organizationId) return null
  if (existing.updated_at !== input.expectedUpdatedAt) throw new HTTPError({ statusCode: 409, statusMessage: 'The post changed since it was read; read it again' })
  const data: PostMutation = parsePostInput(input.changes, 'update')
  const requested = input.media === undefined ? undefined : parsePostInput({ media: input.media }, 'create').media!
  if (data.slug !== undefined && data.slug !== existing.slug) throw new PostValidationError('A post keeps its saved slug')
  delete data.slug
  if (!Object.keys(data).length && requested === undefined) throw new PostValidationError('Name at least one field to change')
  const changedSlots = (['cover', 'gallery'] as const).filter(slot => requested
    && JSON.stringify(requested.filter(item => item.slot === slot).map(item => item.asset_id))
      !== JSON.stringify(media.filter(item => item.slot === slot).map(item => item.asset_id)))
  const refreshCard = data.title !== undefined || data.body !== undefined || data.location_id !== undefined || changedSlots.includes('cover')
  // A field sent with its existing value does not wait on a publication.
  if (data.title !== undefined && data.title === existing.title) delete data.title
  if (data.body !== undefined && data.body === existing.body) delete data.body
  if (data.call_to_action !== undefined && JSON.stringify(data.call_to_action) === JSON.stringify(callToActionOf(existing.metadata_json))) delete data.call_to_action
  if (data.location_id === existing.location_id) delete data.location_id
  if (!Object.keys(data).length && !changedSlots.length) {
    if (refreshCard) await refreshSocialCard({ db, env, owner: { owner_type: 'content_document', owner_id: postId }, actorId: updatedBy })
    return await getPost(db, env, organizationId, postId)
  }
  if (data.location_id !== undefined) await validatePostLocation(db, organizationId, data.location_id)
  const changedMedia = requested?.filter(item => changedSlots.includes(item.slot)) ?? []
  if (changedMedia.length) await hydrateMediaAssetRefs(db, {
    organizationId, refs: changedMedia, allowedKinds: ['image', 'video'], fieldName: 'media',
  })
  const changes: ContentDocumentChanges = { updated_by: updatedBy }
  if (data.title !== undefined) changes.title = data.title
  if (data.body !== undefined) changes.summary = data.body
  if (data.visibility !== undefined) changes.visibility = data.visibility
  if (data.location_id !== undefined) changes.location_id = data.location_id
  if (data.call_to_action) changes.metadata = { call_to_action: data.call_to_action }
  await updateContentDocument(db, existing, {
    updated_at: input.expectedUpdatedAt, changes,
    additionalQueriesAfter: [
      // Removing the call to action removes the key; json_set would store a JSON null.
      ...(data.call_to_action === null ? [{ query: "UPDATE content_documents SET metadata_json = json_remove(metadata_json, '$.call_to_action') WHERE id = ? AND organization_id = ?", params: [postId, organizationId] }] : []),
      // The document revision also advances on standalone placement edits.
      ...changedSlots.flatMap(slot => buildMediaPlacementReplacementQueries({
        organizationId, placement: { owner_type: 'content_document', owner_id: postId, slot },
        media: changedMedia.filter(item => item.slot === slot),
      })),
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
  const results = await executeBatch(db, [
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
  root_slug: string
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

function preparePublicPostProjection(records: BatchQuery) {
  const organization = { sql: '(SELECT organization_id FROM post_scope LIMIT 1)' }
  const media = mediaPlacementsQuery({
    organizationId: organization, ownerType: 'content_document',
    owners: { sql: 'SELECT id FROM post_scope UNION SELECT representation_id FROM post_scope' }, includeOrganizationFallback: true,
  })
  const publications: BatchQuery = { query: `SELECT post_id, channel, provider_permalink, provider_target_id
    FROM post_publications WHERE organization_id = ${organization.sql} AND state = 'published'
      AND channel IN ('facebook', 'instagram') AND post_id IN (SELECT id FROM post_scope) ORDER BY channel` }
  return {
    queries: [records, ...[postOriginsQuery(organization), media, publications, integrationsQuery(organization)].map(statement => ({
      query: `WITH post_scope AS (${records.query}) ${statement.query}`,
      params: [...records.params ?? [], ...statement.params ?? []],
    }))],
    read([records, domains, media, publications, integrations]: D1Result[], context: {
      env: CloudflareEnv; organizationId: string; sourceLocale: string; locale: string; localizations: readonly ExactPublicLocalization[] | null,
    }) {
      const rows = records!.results as Array<PublicPostRow & { block_id?: string }>
      const hosts = postOrigins(domains!.results[0] as PostOriginRow | undefined, context.env)
      const placements = groupMediaPlacements(media!.results)
      const integrationsByProvider = new Map(integrationsFromRows(integrations!.results).map(connection => [connection.provider, connection]))
      const published = publications!.results as Array<{ post_id: string; channel: 'facebook' | 'instagram'; provider_permalink: string | null; provider_target_id: string }>
      const { sourceLocale, locale, localizations } = context
      return rows.map((row) => {
        const rootAction = callToActionOf(row.root_metadata_json)
        const localizedLabel = row.representation_id === row.id ? null : callToActionOf(row.metadata_json)?.label ?? null
        const path = (locale === sourceLocale ? '' : `/${locale}`) + postPublicPath(row.slug)
        return {
          row,
          post: {
            id: row.id,
            slug: row.slug,
            path,
            url: absoluteUrl(hosts.publicOrigin, path),
            title: row.title?.trim() ? row.title : null,
            body: row.body?.trim() ? row.body : null,
            call_to_action: rootAction ? { label: localizedLabel ?? rootAction.label, url: rootAction.url } : null,
            media: projectLocalizedMediaAlt(orderedPostMedia(placements.get(row.id) ?? []).map(item => ({
              asset_id: item.asset_id, public_url: item.public_url, thumbnail_url: item.thumbnail_url, kind: item.kind,
              alt_text: item.alt_text, width: item.width, height: item.height,
            })), localizations),
            published_at: row.published_at,
            location: row.location_id && row.location_title && row.location_slug ? { id: row.location_id, title: row.location_title, slug: row.location_slug } : null,
            publications: published.filter(item => item.post_id === row.id).map(item => ({ channel: item.channel, url: item.provider_permalink, account_name: (integrationsByProvider.get(item.channel)?.target_id === item.provider_target_id ? integrationsByProvider.get(item.channel)?.target_name : null) ?? null })),
            social_image: publicSocialMediaFromPlacements('content_document', placements.get(row.representation_id) ?? [], placements.get(context.organizationId) ?? []).social_image,
            status: row.status,
            visibility: row.visibility,
          } satisfies PublicSocialPost,
        }
      })
    },
  }
}

const publicPostSelect = (locale: string, block = false) => `SELECT ${block ? 'block.id AS block_id, ' : ''}
    root.id, root.organization_id, root.slug AS root_slug, p.id AS representation_id, COALESCE(p.slug, root.slug) AS slug, p.title, p.summary AS body,
    root.metadata_json AS root_metadata_json, p.metadata_json, root.published_at, root.status, root.visibility,
    root.location_id, bl.title AS location_title, bl.slug AS location_slug
  FROM content_documents root
  JOIN content_documents p ON ${documentOfRootSql('p', 'root')} AND p.locale = ${locale}
  LEFT JOIN business_locations bl ON bl.id = root.location_id AND bl.organization_id = root.organization_id AND bl.status = 'active'`

const listedPostSql = "root.kind = 'social_post' AND root.row_role = 'root' AND root.status = 'published' AND root.visibility = 'listed'"

export function preparePublicPostBlocks(organization: { sql: string }, document: { sql: string }, locale: { sql: string }) {
  const records = {
    query: `WITH ranked AS (
      SELECT selected.*, ROW_NUMBER() OVER (PARTITION BY block_id ORDER BY published_at DESC, id DESC) AS rank
      FROM (${publicPostSelect(locale.sql, true)}
        JOIN content_blocks block ON block.document_id = ${document.sql} AND block.type = 'social_posts'
          AND (NULLIF(json_extract(block.data_json, '$.location_id'), '') IS NULL
            OR root.location_id = json_extract(block.data_json, '$.location_id'))
        WHERE root.organization_id = ${organization.sql} AND ${listedPostSql}
      ) selected
    )
    SELECT ranked.* FROM ranked JOIN content_blocks b ON b.id = ranked.block_id
    WHERE rank <= COALESCE(json_extract(b.data_json, '$.limit'), ${SOCIAL_POSTS_BLOCK_DEFAULT}) + 1 ORDER BY block_id, rank`,
  }
  const plan = preparePublicPostProjection(records)
  return { queries: plan.queries, read(rows: D1Result[], context: Parameters<typeof plan.read>[1]) {
    const byBlock = new Map<string, PublicSocialPost[]>()
    for (const { row, post } of plan.read(rows, context)) {
      const items = byBlock.get(row.block_id!) ?? []
      items.push(post)
      byBlock.set(row.block_id!, items)
    }
    return byBlock
  } }
}

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
  const plan = preparePublicPostProjection({
    query: `${publicPostSelect('?')} WHERE root.organization_id = ? AND ${listedPostSql}
      ${input.locationId ? 'AND root.location_id = ?' : ''}
      ORDER BY root.published_at DESC, root.id DESC LIMIT ? OFFSET ?`,
    params: [input.locale, organizationId, ...(input.locationId ? [input.locationId] : []), input.window.limit + 1, input.window.offset],
  })
  const rows = await executeBatch(db, plan.queries, { operation: 'Read published posts' })
  const pageInfo = (count: number, more: boolean) => mcpPageInfo(input.window, count, more, { resource: input.resource })
  if (!rows[0]!.results.length) return { posts: [], page_info: pageInfo(0, false) }
  const sourceLocale = await getSourceLocale(db, organizationId)
  const localizations = input.locale === sourceLocale ? null : await loadExactPublicLocalizations(env, db, organizationId, input.locale)
  const posts = plan.read(rows, { env, organizationId, sourceLocale, locale: input.locale, localizations }).slice(0, input.window.limit).map(item => item.post)
  return { posts, page_info: pageInfo(posts.length, rows[0]!.results.length > input.window.limit) }
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
  const plan = preparePublicPostProjection({
    query: `${publicPostSelect('?')} WHERE root.kind = 'social_post' AND root.row_role = 'root' AND root.organization_id = ?
      AND ${locale === sourceLocale ? 'root.slug = ?' : "p.row_role = 'representation' AND p.path = ?"}
      ${previewAuthorized ? '' : "AND root.status = 'published'"} LIMIT 1`,
    params: [locale, organizationId, locale === sourceLocale ? slug : postPublicPath(slug)],
  })
  const rows = await executeBatch(db, plan.queries, { operation: 'Read published post' })
  if (!rows[0]!.results.length) return null
  const localizations = locale === sourceLocale ? null : await loadExactPublicLocalizations(env, db, organizationId, locale)
  const { row, post } = plan.read(rows, { env, organizationId, sourceLocale, locale, localizations })[0]!
  const locale_representations = await listPublicLocaleRepresentations(env, db, {
    organizationId, sourcePath: postPublicPath(row.root_slug), documentId: row.id,
  })
  return { ...post, locale_representations }
}
