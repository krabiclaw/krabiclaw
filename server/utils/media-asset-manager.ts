import { HTTPError } from 'nitro';
import { deleteImage } from './cloudflare-images'
import { deleteFromR2 } from './cloudflare-r2'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { organizationEventQuery } from '~/server/utils/organization-events'
import {
  isSingleMediaPlacement,
  isSupportedMediaPlacement,
  isMediaPlacementOwnerType,
  LOGO_SLOTS,
  parseLogoPresentation,
  MAX_ORDERED_MEDIA_ASSETS,
  type LogoPresentation,
  type MediaCategory,
  type MediaPlacementOwnerType,
} from '~/shared/media-placement-contract'

export { isSingleMediaPlacement, isSupportedMediaPlacement, MAX_ORDERED_MEDIA_ASSETS } from '~/shared/media-placement-contract'

type SqlBindValue = string | number | boolean | null
type MediaProviderEnv = Parameters<typeof deleteImage>[0]

interface MediaStorageReferenceState {
  r2ReferencedElsewhere: boolean
  cloudflareImageReferencedElsewhere: boolean
}

export interface MediaAsset {
  id: string
  organization_id: string
  kind: 'image' | 'video' | 'file'
  provider: 'cloudflare_images' | 'cloudflare_r2' | 'static'
  source: 'uploaded' | 'generated' | 'external'
  generation_key: string | null
  cloudflare_image_id: string | null
  r2_key: string | null
  public_url: string | null
  thumbnail_url: string | null
  mime_type: string | null
  file_name: string | null
  file_size: number | null
  width: number | null
  height: number | null
  duration: number | null
  alt_text: string | null
  category: MediaCategory | null
  status: 'pending' | 'active' | 'deleted' | 'failed'
  placement_updated_at?: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

interface ResolvedMediaAssetBase {
  asset_id: string
  public_url: string
  mime_type: string | null
  width: number | null
  height: number | null
  duration: number | null
  alt_text: string | null
  provider: string
  status: 'active'
}

export type ResolvedMediaAsset = ResolvedMediaAssetBase & (
  | { kind: 'image'; thumbnail_url: string | null }
  | { kind: 'video'; thumbnail_url: string }
  | { kind: 'file'; thumbnail_url: null }
)

// `file_name` rides along because it is what names an asset that has no alt
// text. A surface holding a placement can label it exactly as the media
// endpoint would, instead of asking for the same asset again to learn its name.
export type StoredMediaPlacementItem = ResolvedMediaAsset & Pick<MediaAsset, 'source' | 'generation_key' | 'updated_at' | 'file_name'> & {
  placement_id: string
  owner_type: MediaPlacementOwnerType
  owner_id: string
  slot: string
  sort_order: number
  presentation: LogoPresentation | null
}

export interface MediaAssetRefInput {
  asset_id: string
}

export function parseMediaAssetRefs(value: unknown): MediaAssetRefInput[] {
  if (!Array.isArray(value)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'media must be an array of { asset_id } items' })
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HTTPError({ statusCode: 400, statusMessage: 'media must be an array of { asset_id } items' })
    }
    const assetId = (item as Record<string, unknown>).asset_id
    if (typeof assetId !== 'string' || !assetId.trim()) {
      throw new HTTPError({ statusCode: 400, statusMessage: 'media must be an array of { asset_id } items' })
    }
    return { asset_id: assetId.trim() }
  })
}

export type CreateInput = Pick<MediaAsset, 'id' | 'organization_id' | 'organization_id' | 'kind' | 'provider' | 'source'> &
  Partial<Omit<MediaAsset, 'id' | 'organization_id' | 'organization_id' | 'kind' | 'provider' | 'source' | 'created_at' | 'updated_at'>>

export interface MediaPlacementInsertInput {
  id?: string
  organizationId: string
  ownerType: string
  ownerId: string
  slot: string
  assetId: string
  sortOrder: number
  status?: 'pending' | 'active' | 'rejected'
  /** A logo placement's shape and focal point; only logo slots carry one. */
  presentation?: LogoPresentation | null
  createdAt?: string
  updatedAt?: string
}

const OWNER_TABLES = {
  organization: 'organization', business_location: 'business_locations', product: 'products',
  collection: 'collections',
  content_document: 'content_documents', review: 'reviews',
  review_request: 'review_requests',
  content_block: 'content_blocks',
  activity_entry: 'activity_entries',
  team_message: 'team_messages',
} as const satisfies Record<MediaPlacementOwnerType, string>

export function mediaPlacementOwnerQuery(input: {
  ownerType: string; ownerId: string; organizationId: string
}): BatchQuery {
  if (!isMediaPlacementOwnerType(input.ownerType)) throw new HTTPError({ statusCode: 400, statusMessage: 'Unsupported media owner' })
  const params = [input.ownerId, input.organizationId]
  if (input.ownerType === 'content_block') return {
    query: `SELECT root.location_id FROM content_blocks cb JOIN content_documents owner ON owner.id = cb.document_id
      JOIN content_documents root ON root.id = COALESCE(owner.root_id, owner.id)
      WHERE cb.id = ? AND owner.organization_id = ?`, params,
  }
  if (input.ownerType === 'content_document') return {
    query: `SELECT root.location_id FROM content_documents owner
      JOIN content_documents root ON root.id = COALESCE(owner.root_id, owner.id)
      WHERE owner.id = ? AND owner.organization_id = ?`, params,
  }
  // A message belongs to the organization through the thread it was said in.
  if (input.ownerType === 'activity_entry') return {
    query: `SELECT r.location_id FROM activity_entries e JOIN requests r ON r.id = e.request_id
      WHERE e.id = ? AND r.organization_id = ?`, params,
  }
  // A product is organization-owned and is public through its publication.
  // Its locations are a many relationship (product_locations), so there is no
  // single location to narrow authorization by.
  if (input.ownerType === 'product') return {
    query: `SELECT NULL AS location_id FROM products p
      JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
      WHERE p.id = ? AND p.organization_id = ?`, params,
  }
  const table = OWNER_TABLES[input.ownerType]
  const location = input.ownerType === 'business_location' ? 'id'
    : ['review', 'review_request', 'collection'].includes(input.ownerType) ? 'location_id' : 'NULL'
  return {
    query: `SELECT ${location} AS location_id FROM ${table} WHERE id = ? AND ${input.ownerType === 'organization' ? 'id' : 'organization_id'} = ?`, params,
  }
}

export function buildMediaPlacementInsertQuery(input: MediaPlacementInsertInput): BatchQuery {
  if (!isSupportedMediaPlacement({ owner_type: input.ownerType, slot: input.slot })) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Media placement owner and slot are not supported' })
  }
  if (input.presentation && !(input.ownerType === 'organization' && (LOGO_SLOTS as readonly string[]).includes(input.slot))) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Only the organization logo placements take a presentation' })
  }
  const createdAt = input.createdAt ?? new Date().toISOString()
  const owner = mediaPlacementOwnerQuery(input)
  return {
    query: `INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status, presentation_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CASE WHEN EXISTS (${owner.query})
        AND EXISTS (SELECT 1 FROM media_assets WHERE id = ? AND organization_id = ? AND (status = 'active' OR (status = 'pending' AND ? = 'review_request' AND ? = 'pending')))
        THEN ? ELSE NULL END, ?, ?, ?, ?, ?)`,
    params: [input.id ?? crypto.randomUUID(), input.organizationId, input.ownerType, input.ownerId, input.slot,
      ...owner.params!, input.assetId, input.organizationId, input.ownerType, input.status ?? 'active',
      input.assetId,
      input.sortOrder, input.status ?? 'active', input.presentation ? JSON.stringify(input.presentation) : null, createdAt, input.updatedAt ?? createdAt],
  }
}

// A bare "delete everything, insert the given array" is only ever safe for a single-value slot (cardinality <= 1, so there is nothing
// to resurrect) or for seeding an ordered collection at true creation time
// (nothing existed before, so nothing can be stale). Any update path on an
// existing ordered collection must go through attachMediaPlacement /
// removeMediaPlacement / reorderMediaPlacements in media-placement.ts
// instead — a client holding a stale read of the list otherwise silently
// resurrects assets someone else already removed. See setSingleMediaPlacement
// and insertInitialMediaPlacements below, and arrangeProductPhotos in
// media-placement.ts, which guards the membership it read in the same batch,
// for the sanctioned callers.
export function buildMediaPlacementReplacementQueries(input: {
  organizationId: string
  placement: { owner_type: string; owner_id: string; slot: string }
  media: Array<{ asset_id: string; presentation?: LogoPresentation | null }>
  now?: string
}): BatchQuery[] {
  if (!isSupportedMediaPlacement(input.placement)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Media placement owner and slot are not supported' })
  }
  const now = input.now ?? new Date().toISOString()
  return [
    {
      query: 'DELETE FROM media_placements WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND slot = ?',
      params: [input.organizationId, input.placement.owner_type, input.placement.owner_id, input.placement.slot],
    },
    ...input.media.map((asset, sortOrder) => buildMediaPlacementInsertQuery({
      organizationId: input.organizationId,
      ownerType: input.placement.owner_type,
      ownerId: input.placement.owner_id,
      slot: input.placement.slot,
      assetId: asset.asset_id,
      sortOrder,
      presentation: asset.presentation,
      createdAt: now,
      updatedAt: now,
    })),
  ]
}

// For a single-value slot only (logo, cover, hero, featured, thumbnail, ...).
// Cardinality is always <= 1, so a plain replace is the correct semantic —
// there is no ordering and nothing to resurrect. Throws if placement is an
// ordered collection; use attach/remove/reorder for those instead.
export function buildSingleMediaPlacementQueries(input: {
  organizationId: string
  placement: { owner_type: string; owner_id: string; slot: string }
  media: Array<{ asset_id: string; presentation?: LogoPresentation | null }>
  now?: string
}): BatchQuery[] {
  if (!isSingleMediaPlacement(input.placement)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'This placement is an ordered collection; use attach/remove/reorder instead of a full replace' })
  }
  if (input.media.length > 1) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'This media placement accepts at most one asset' })
  }
  return buildMediaPlacementReplacementQueries(input)
}

// For seeding an ordered collection's initial members in the SAME atomic
// batch that creates the owning row. Safe only when the owner cannot already
// exist (a brand-new id, inserted in this same batch) — never call this from
// an update path, and never let a retry of a create request turn into an
// update of an existing owner's placements. Use attach/remove/reorder for
// every other write to an ordered collection.
export function insertInitialMediaPlacements(input: {
  organizationId: string
  placement: { owner_type: string; owner_id: string; slot: string }
  media: Array<{ asset_id: string; presentation?: LogoPresentation | null }>
  now?: string
}): BatchQuery[] {
  return buildMediaPlacementReplacementQueries(input)
}

// media_placements.owner_id is polymorphic with no owner foreign key, so every
// path that deletes an owning row (a post, a Product, a review, ...) must
// explicitly clear its placements first or they orphan permanently. Route
// every such deletion through this builder instead of hand-writing the DELETE
// each time.
export function buildDeleteOwnerPlacementsQuery(input: {
  ownerType: string
  ownerId: string
  organizationId?: string
}): BatchQuery {
  const conditions = ['owner_type = ?']
  const params: string[] = [input.ownerType]
  if (input.organizationId) {
    conditions.push('organization_id = ?')
    params.push(input.organizationId)
  }
  
  conditions.push('owner_id = ?')
  params.push(input.ownerId)
  return {
    query: `DELETE FROM media_placements WHERE ${conditions.join(' AND ')}`,
    params,
  }
}

/** Run after a Product's complete photo mutation, never between slot replacements. */
export function pruneStayPhotoRoomMembershipsQuery(organizationId: string, productId: string): BatchQuery {
  return {
    query: `DELETE FROM product_stay_photo_room_memberships
      WHERE organization_id = ? AND product_id = ? AND NOT EXISTS (
        SELECT 1 FROM media_placements mp JOIN media_assets ma
          ON ma.organization_id = mp.organization_id AND ma.id = mp.asset_id AND ma.status = 'active'
        WHERE mp.organization_id = product_stay_photo_room_memberships.organization_id
          AND mp.owner_type = 'product' AND mp.owner_id = product_stay_photo_room_memberships.product_id
          AND mp.asset_id = product_stay_photo_room_memberships.asset_id
          AND mp.slot IN ('image', 'gallery') AND mp.status = 'active'
      )`,
    params: [organizationId, productId],
  }
}

/** Run after the complete proposed state, before any provider storage deletion. */
export function stayAccessibilityEvidenceGuardQueries(organizationId: string, scope: { productId: string } | { assetId: string }): BatchQuery[] {
  return ['product_stay_room_accessibility', 'product_stay_accessibility'].map(table => {
    const room = table === 'product_stay_room_accessibility'
    const ownerMatch = room ? 'AND proof.room_id = a.room_id' : ''
    const evidence = `SELECT 1 FROM ${table}_photos proof
      WHERE proof.organization_id = a.organization_id AND proof.product_id = a.product_id ${ownerMatch} AND proof.feature_code = a.feature_code`
    const scoped = 'productId' in scope ? 'a.product_id = ?' : `EXISTS (${evidence} AND proof.asset_id = ?)`
    const owner = room
      ? "SELECT 1 FROM product_stay_photo_rooms room WHERE room.organization_id = a.organization_id AND room.product_id = a.product_id AND room.id = a.room_id AND room.type = 'bedroom'"
      : "SELECT 1 FROM products p JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id WHERE p.organization_id = a.organization_id AND p.id = a.product_id AND p.kind = 'stay'"
    return {
    query: `UPDATE ${table} AS a SET available = NULL WHERE a.organization_id = ? AND ${scoped} AND (
      NOT EXISTS (${owner})
      OR (a.available = 1 AND NOT EXISTS (${evidence})) OR (a.available = 0 AND EXISTS (${evidence}))
      OR EXISTS (${evidence} AND NOT EXISTS (
        SELECT 1 FROM media_assets ma JOIN media_placements mp ON mp.organization_id = ma.organization_id AND mp.asset_id = ma.id
        WHERE ma.organization_id = proof.organization_id AND ma.id = proof.asset_id AND ma.status = 'active' AND ma.kind = 'image'
          AND ma.generation_key IS NULL AND length(trim(ma.public_url)) > 0
          AND mp.owner_type = 'product' AND mp.owner_id = proof.product_id AND mp.slot IN ('image', 'gallery') AND mp.status = 'active'))
    )`,
    params: [organizationId, 'productId' in scope ? scope.productId : scope.assetId],
    }
  })
}

/** A failed evidence predicate aborts its whole D1 batch through this required column. */
export function stayAccessibilityEvidenceWriteError(error: unknown): unknown {
  if (/NOT NULL constraint failed: product_stay_(?:room_)?accessibility\.available/.test(error instanceof Error ? error.message : String(error))) {
    return new HTTPError({ statusCode: 409, statusMessage: 'A photo is required by accessibility information. Replace its evidence or clear the feature answer before removing the photo.', data: { code: 'ACCESSIBILITY_EVIDENCE_REQUIRED', field: 'photo_ids' }, cause: error })
  }
  return error
}

export function toResolvedMediaAsset(row: MediaAsset): ResolvedMediaAsset {
  if (!row.public_url) {
    throw new HTTPError({ statusCode: 400, statusMessage: `Media asset ${row.id} does not have a public URL` })
  }
  if (row.status !== 'active') {
    throw new HTTPError({ statusCode: 400, statusMessage: `Media asset ${row.id} is not active` })
  }
  if (row.kind === 'video' && !row.thumbnail_url?.trim()) {
    throw new HTTPError({ statusCode: 500, statusMessage: `Active video asset ${row.id} does not have a thumbnail` })
  }

  const base = {
    asset_id: row.id,
    public_url: row.public_url,
    mime_type: row.mime_type,
    width: row.width,
    height: row.height,
    duration: row.duration,
    alt_text: row.alt_text,
    provider: row.provider,
    status: 'active' as const,
  }
  if (row.kind === 'video') {
    return { ...base, kind: 'video', thumbnail_url: row.thumbnail_url! }
  }
  if (row.kind === 'image') return { ...base, kind: 'image', thumbnail_url: row.thumbnail_url }
  return { ...base, kind: 'file', thumbnail_url: null }
}

type MediaPlacementRow = MediaAsset & {
  placement_id: string
  owner_type: MediaPlacementOwnerType
  owner_id: string
  slot: string
  sort_order: number
  presentation_json: string | null
}

export async function readMediaPlacements(db: DbClient, input: {
  organizationId: string
  ownerType: MediaPlacementOwnerType
  ownerIds: string[]
  slot?: string
  includePendingSocialCard?: boolean
}): Promise<Map<string, StoredMediaPlacementItem[]>> {
  const ownerIds = [...new Set(input.ownerIds)].filter(Boolean)
  const result = new Map(ownerIds.map(id => [id, [] as StoredMediaPlacementItem[]]))
  if (!ownerIds.length) return result
  const rows = await queryAll<MediaPlacementRow>(db, `
    SELECT mp.id AS placement_id, mp.owner_type, mp.owner_id, mp.slot, mp.sort_order, mp.presentation_json,
           ma.*
      FROM media_placements mp
      JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id
     WHERE mp.organization_id = ? AND mp.owner_type = ?
       AND mp.owner_id IN (SELECT value FROM json_each(?))
       ${input.slot ? 'AND mp.slot = ?' : ''}
       AND (mp.status = 'active' ${input.includePendingSocialCard ? "OR (mp.slot = 'social_card' AND mp.status = 'pending')" : ''}) AND ma.status = 'active'
     ORDER BY mp.owner_id, mp.slot, mp.sort_order
  `, [input.organizationId, input.ownerType, d1JsonStringSet(ownerIds), ...(input.slot ? [input.slot] : [])])
  for (const row of rows) {
    result.get(row.owner_id)?.push({
      ...toResolvedMediaAsset(row),
      source: row.source,
      generation_key: row.generation_key,
      updated_at: row.updated_at,
      file_name: row.file_name,
      placement_id: row.placement_id,
      owner_type: row.owner_type,
      owner_id: row.owner_id,
      slot: row.slot,
      sort_order: row.sort_order,
      presentation: row.presentation_json ? parseLogoPresentation(JSON.parse(row.presentation_json)) : null,
    })
  }
  return result
}

export async function hydrateMediaAssetRefs(
  db: DbClient,
  input: {
    organizationId: string
    refs: MediaAssetRefInput[]
    allowedKinds?: Array<ResolvedMediaAsset['kind']>
    fieldName?: string
  },
): Promise<ResolvedMediaAsset[]> {
  const fieldName = input.fieldName ?? 'media'
  const ids = input.refs.map(ref => ref.asset_id?.trim()).filter(Boolean)
  if (input.refs.length > MAX_ORDERED_MEDIA_ASSETS) {
    throw new HTTPError({ statusCode: 400, statusMessage: `${fieldName} accepts at most ${MAX_ORDERED_MEDIA_ASSETS} assets` })
  }
  if (ids.length !== input.refs.length) {
    throw new HTTPError({ statusCode: 400, statusMessage: `${fieldName} items must contain asset_id` })
  }
  if (new Set(ids).size !== ids.length) {
    throw new HTTPError({ statusCode: 400, statusMessage: `${fieldName} cannot contain duplicate asset IDs` })
  }
  if (ids.length === 0) return []

  const rows = await queryAll<MediaAsset>(
    db,
    `SELECT * FROM media_assets
      WHERE organization_id = ?  AND status = 'active'
        AND generation_key IS NULL
        AND id IN (SELECT value FROM json_each(?))`,
    [input.organizationId, d1JsonStringSet(ids)],
  )
  const byId = new Map((rows ?? []).map(row => [row.id, row]))
  const missing = ids.find(id => !byId.has(id))
  if (missing) {
    throw new HTTPError({ statusCode: 400, statusMessage: `${fieldName} references an inactive, out-of-scope, or generated derivative media asset: ${missing}` })
  }

  const allowedKinds = input.allowedKinds ? new Set(input.allowedKinds) : null
  const resolved = ids.map((id) => {
    const row = byId.get(id)
    if (!row) throw new HTTPError({ statusCode: 400, statusMessage: `${fieldName} references an inactive, out-of-scope, or generated derivative media asset: ${id}` })
    const asset = toResolvedMediaAsset(row)
    if (allowedKinds && !allowedKinds.has(asset.kind)) {
      throw new HTTPError({ statusCode: 400, statusMessage: `${fieldName} asset ${id} must be ${Array.from(allowedKinds).join(' or ')}` })
    }
    return asset
  })

  return resolved
}

export async function hydrateMediaPlacementRefs(
  db: DbClient,
  input: {
    organizationId: string
    refs: Array<MediaAssetRefInput & { slot: string }>
    allowedKinds?: Array<ResolvedMediaAsset['kind']>
    fieldName?: string
  },
): Promise<void> {
  const refsBySlot = new Map<string, MediaAssetRefInput[]>()
  for (const ref of input.refs) {
    const refs = refsBySlot.get(ref.slot) ?? []
    refs.push({ asset_id: ref.asset_id })
    refsBySlot.set(ref.slot, refs)
  }
  for (const [slot, refs] of refsBySlot) {
    await hydrateMediaAssetRefs(db, {
      organizationId: input.organizationId,
      refs,
      allowedKinds: input.allowedKinds,
      fieldName: `${input.fieldName ?? 'media'}.${slot}`,
    })
  }
}

export function buildMediaAssetInsertQuery(data: CreateInput, now = new Date().toISOString()): BatchQuery {
  if (data.kind === 'video' && !data.thumbnail_url?.trim()) {
    throw new Error(`Video asset ${data.id} requires a thumbnail URL`)
  }
  return {
    query: `INSERT INTO media_assets (
      id, organization_id, kind, provider, source, generation_key,
      cloudflare_image_id, r2_key,
      public_url, thumbnail_url, mime_type, file_name, file_size,
      width, height, duration, alt_text, category, status, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      data.id, data.organization_id, data.kind, data.provider, data.source,
      data.generation_key ?? null,
      data.cloudflare_image_id ?? null, data.r2_key ?? null,
      data.public_url ?? null, data.thumbnail_url ?? null,
      data.mime_type ?? null, data.file_name ?? null, data.file_size ?? null,
      data.width ?? null, data.height ?? null, data.duration ?? null,
      data.alt_text ?? null, data.category ?? null, data.status ?? 'active',
      data.created_by_user_id ?? null, now, now,
    ],
  }
}

export async function createMediaAsset(db: DbClient, data: CreateInput, creation?: { dedupeKey: string; requestHash: string }, writeGuard?: BatchQuery): Promise<void> {
  const query = buildMediaAssetInsertQuery(data)
  await executeBatch(db, [...(writeGuard ? [writeGuard] : []), query, organizationEventQuery({
    organizationId: data.organization_id,
    locationId: null,
    actorId: data.created_by_user_id ?? null,
    eventType: 'media.uploaded',
    entityType: 'media_asset',
    entityId: data.id,
    ...(creation ? { dedupeKey: creation.dedupeKey } : {}),
    metadata: {
      ...(creation ? { request_hash: creation.requestHash } : {}),
      kind: data.kind,
      provider: data.provider,
      source: data.source,
      status: data.status ?? 'active',
    },
  }), publicResourceCacheInvalidationQuery(data.organization_id, 'media-create')])
}

export async function getMediaAsset(db: DbClient, id: string, organizationId: string): Promise<MediaAsset | null> {
  return await queryFirst<MediaAsset>(
    db,
    `SELECT * FROM media_assets WHERE id = ? AND organization_id = ? LIMIT 1`,
    [id, organizationId],
  ) ?? null
}

export async function listMediaAssets(
  db: DbClient,
  organizationId: string,
  opts: { kind?: string; search?: string; ownerType?: string; ownerId?: string; slot?: string; limit?: number; offset?: number } = {}
): Promise<MediaAsset[]> {
  const conditions = [`ma.organization_id = ?`, `ma.status = 'active'`, `ma.generation_key IS NULL`]
  const params: SqlBindValue[] = [organizationId]
  // A photo sent in a conversation is the conversation's, not the website's.
  if (opts.ownerType !== 'activity_entry' && opts.ownerType !== 'team_message') {
    conditions.push(`NOT EXISTS (SELECT 1 FROM media_placements sent WHERE sent.asset_id = ma.id AND sent.organization_id = ma.organization_id AND sent.owner_type IN ('activity_entry', 'team_message'))`)
  }
  if (opts.kind) { conditions.push(`ma.kind = ?`); params.push(opts.kind) }
  if (opts.search) { conditions.push(`ma.file_name LIKE ? ESCAPE '\\'`); params.push(`%${opts.search.replace(/[\\%_]/g, '\\$&')}%`) }
  if (opts.ownerType && opts.ownerId) {
    conditions.push('mp.owner_type = ?', 'mp.owner_id = ?', `mp.status = 'active'`)
    params.push(opts.ownerType, opts.ownerId)
    if (opts.slot) { conditions.push('mp.slot = ?'); params.push(opts.slot) }
  }
  params.push(opts.limit ?? 50, opts.offset ?? 0)
  const results = await queryAll<MediaAsset>(
    db,
    `SELECT ma.id, ma.organization_id, ma.kind, ma.provider, ma.source,
            ma.cloudflare_image_id, ma.r2_key,
            ma.public_url, ma.thumbnail_url, ma.mime_type, ma.file_name, ma.file_size,
            ma.width, ma.height, ma.duration, ma.alt_text, ma.category, ma.status, ma.created_by_user_id, ma.created_at, ma.updated_at
            ${opts.ownerType && opts.ownerId ? ', mp.updated_at AS placement_updated_at' : ''}
     FROM media_assets ma
     ${opts.ownerType && opts.ownerId ? 'JOIN media_placements mp ON mp.asset_id = ma.id AND mp.organization_id = ma.organization_id' : ''}
     WHERE ${conditions.join(' AND ')} ORDER BY ${opts.ownerType && opts.ownerId ? 'mp.sort_order' : 'ma.created_at DESC'} LIMIT ? OFFSET ?`
    , params,
  )
  return results
}

export async function activateMediaAsset(
  db: DbClient,
  id: string,
  organizationId: string,
  updates: { public_url?: string | null; thumbnail_url?: string | null; cloudflare_image_id?: string | null }
): Promise<boolean> {
  const now = new Date().toISOString()
  const sets: string[] = [`status = 'active'`, `updated_at = ?`]
  const params: SqlBindValue[] = [now]
  if (updates.public_url !== undefined) { sets.push('public_url = ?'); params.push(updates.public_url) }
  if (updates.thumbnail_url !== undefined) { sets.push('thumbnail_url = ?'); params.push(updates.thumbnail_url) }
  if (updates.cloudflare_image_id !== undefined) { sets.push('cloudflare_image_id = ?'); params.push(updates.cloudflare_image_id) }
  params.push(id, organizationId)
  const [result] = await executeBatch(db, [
    { query: `UPDATE media_assets SET ${sets.join(', ')} WHERE id = ? AND status = 'pending'`, params },
    publicResourceCacheInvalidationQuery(organizationId, 'media-activate'),
  ])
  return Number(result?.meta?.changes ?? 0) > 0
}

export async function updateMediaAssetAlt(db: DbClient, id: string, organizationId: string, altText: string): Promise<boolean> {
  const [result] = await executeBatch(db, [
    { query: `UPDATE media_assets SET alt_text = ?, updated_at = ? WHERE id = ? AND organization_id = ?`, params: [altText, new Date().toISOString(), id, organizationId] },
    publicResourceCacheInvalidationQuery(organizationId, 'media-update'),
  ])
  return Number(result?.meta?.changes ?? 0) > 0
}

/**
 * An asset a Facebook, Instagram or Discord publication is sending, or may already
 * have sent, is pinned: its revision is part of what the publication
 * fingerprinted, so it is not changed or deleted until that is resolved.
 */
const PINNING_PUBLICATION = `SELECT pp.id, pp.channel FROM media_placements mp
    JOIN post_publications pp ON pp.organization_id = mp.organization_id AND pp.post_id = mp.owner_id
    WHERE mp.organization_id = ? AND mp.asset_id = ? AND mp.owner_type = 'content_document' AND mp.slot IN ('cover', 'gallery')
      AND pp.state IN ('preparing', 'publishing', 'unknown')`

/** Fails the batch it is in when a publication pinned the asset after the check above read it. */
function publicationPinGuardQuery(organizationId: string, assetId: string): BatchQuery {
  return {
    query: `INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status, created_at, updated_at)
      SELECT NULL, ?, 'content_document', NULL, 'cover', ?, 0, 'active', NULL, NULL WHERE EXISTS (${PINNING_PUBLICATION})`,
    params: [organizationId, assetId, organizationId, assetId],
  }
}

async function assertNotPinnedByPublication(db: DbClient, organizationId: string, assetId: string) {
  const pinned = await queryFirst<{ id: string; channel: string }>(db, `${PINNING_PUBLICATION} LIMIT 1`, [organizationId, assetId])
  if (pinned) throw new HTTPError({ statusCode: 409, statusMessage: `Media asset ${assetId} is part of the unresolved ${pinned.channel} publication ${pinned.id}; resolve it first`, data: { code: 'MEDIA_PINNED_BY_PUBLICATION', field: 'asset_id' } })
}

export async function updateMediaAssetMetadata(
  db: DbClient,
  id: string,
  organizationId: string,
  updates: { alt_text?: string | null; category?: MediaAsset['category'] },
  /** Update it only while it is still placed on this owner, in one of these slots. */
  placedOn?: { owner_type: string; owner_id: string; slots: string[] },
): Promise<boolean> {
  await assertNotPinnedByPublication(db, organizationId, id)
  const sets: string[] = ['updated_at = ?']
  const params: SqlBindValue[] = [new Date().toISOString()]
  if (updates.alt_text !== undefined) {
    sets.push('alt_text = ?')
    params.push(updates.alt_text)
  }
  if (updates.category !== undefined) {
    sets.push('category = ?')
    params.push(updates.category)
  }
  if (sets.length === 1) return false

  params.push(id, organizationId)
  const placement = placedOn
    ? ` AND EXISTS (SELECT 1 FROM media_placements WHERE organization_id = media_assets.organization_id AND asset_id = media_assets.id AND owner_type = ? AND owner_id = ? AND status = 'active' AND slot IN (SELECT value FROM json_each(?)))`
    : ''
  if (placedOn) params.push(placedOn.owner_type, placedOn.owner_id, d1JsonStringSet(placedOn.slots))
  const [, result] = await executeBatch(db, [
    publicationPinGuardQuery(organizationId, id),
    { query: `UPDATE media_assets SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?${placement}`, params },
    publicResourceCacheInvalidationQuery(organizationId, 'media-update'),
  ])
  return Number(result?.meta?.changes ?? 0) > 0
}

function parseReferenceFlag(value: unknown, label: string): boolean {
  if (value === 0 || value === false) return false
  if (value === 1 || value === true) return true
  throw new Error(`Invalid ${label} reference-check result`)
}

async function getMediaStorageReferenceState(
  db: DbClient,
  input: {
    assetId: string
    r2Key: string | null
    cloudflareImageId: string | null
  },
): Promise<MediaStorageReferenceState> {
  const row = await queryFirst<{
    r2_referenced_elsewhere: number | boolean
    cloudflare_image_referenced_elsewhere: number | boolean
  }>(db, `
    SELECT
      (? IS NOT NULL AND EXISTS (
        SELECT 1
          FROM media_assets AS other_r2
         WHERE other_r2.id != ?
           AND other_r2.status != 'deleted'
           AND other_r2.r2_key = ?
      )) AS r2_referenced_elsewhere,
      (? IS NOT NULL AND EXISTS (
        SELECT 1
          FROM media_assets AS other_image
         WHERE other_image.id != ?
           AND other_image.status != 'deleted'
           AND other_image.cloudflare_image_id = ?
      )) AS cloudflare_image_referenced_elsewhere
  `, [
    input.r2Key,
    input.assetId,
    input.r2Key,
    input.cloudflareImageId,
    input.assetId,
    input.cloudflareImageId,
  ])

  if (!row) throw new Error(`Media storage reference check returned no result for asset ${input.assetId}`)

  return {
    r2ReferencedElsewhere: parseReferenceFlag(row.r2_referenced_elsewhere, 'R2'),
    cloudflareImageReferencedElsewhere: parseReferenceFlag(row.cloudflare_image_referenced_elsewhere, 'Cloudflare Images'),
  }
}

/**
 * Claim the row first, then delete each owned Cloudflare object once.
 *
 * Storage used to go first, so every deletion carried a window in which the
 * bytes were gone while `media_assets.status` still read `active` — a row that
 * is served to guests and returns 404. With the row claimed first, a lost
 * race deletes nothing, and a storage failure leaves an object that no active
 * row points at. That failure is thrown, naming the objects, and deleting the
 * same asset again retries only its storage: both storage deletes are
 * idempotent, and the claim, audit event and placement changes already ran.
 */
export async function deleteMediaAsset(db: DbClient, env: MediaProviderEnv, id: string, organizationId: string, deletedByUserId: string | null): Promise<void> {
  const pendingAsset = await queryFirst<{
    id: string
    provider: MediaAsset['provider']
    cloudflare_image_id: string | null
    r2_key: string | null
    organization_id: string
    created_by_user_id: string | null
    source: string
    status: string
  }>(db, `
    SELECT id, provider, cloudflare_image_id, r2_key, organization_id, created_by_user_id, source, status
    FROM media_assets
    WHERE id = ? AND organization_id = ?
  `, [id, organizationId]) ?? null

  if (!pendingAsset) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Media asset not found' })
  }
  await assertNotPinnedByPublication(db, organizationId, id)
  const claimed = pendingAsset.status !== 'deleted'
  // A deleted row's placements went with its claim, so a retry refreshes nothing.
  const sourcePlacements = pendingAsset.source === 'generated' ? [] : await queryAll<{ owner_type: string; owner_id: string; slot: string }>(db,
    'SELECT owner_type, owner_id, slot FROM media_placements WHERE asset_id = ? AND organization_id = ?', [id, organizationId])

  const references = await getMediaStorageReferenceState(db, {
    assetId: pendingAsset.id,
    r2Key: pendingAsset.r2_key,
    cloudflareImageId: pendingAsset.cloudflare_image_id,
  })

  const deletions: Array<{ label: string; run: () => Promise<void> }> = []
  if (pendingAsset.provider === 'cloudflare_r2' && pendingAsset.r2_key && !references.r2ReferencedElsewhere) {
    const r2Key = pendingAsset.r2_key
    deletions.push({ label: `R2 object ${r2Key}`, run: () => deleteFromR2(env, r2Key) })
  }
  if (pendingAsset.cloudflare_image_id && !references.cloudflareImageReferencedElsewhere) {
    const imageId = pendingAsset.cloudflare_image_id
    deletions.push({ label: `Cloudflare image ${imageId}`, run: () => deleteImage(env, imageId) })
  }
  if (claimed) {
    const [, result] = await executeBatch(db, [publicationPinGuardQuery(organizationId, pendingAsset.id), {
      query: `UPDATE media_assets SET status = 'deleted', updated_at = ? WHERE id = ? AND organization_id = ? AND status != 'deleted'`,
      params: [new Date().toISOString(), pendingAsset.id, organizationId],
    }, organizationEventQuery({
      organizationId: pendingAsset.organization_id,
      locationId: null,
      actorId: deletedByUserId,
      eventType: 'media.deleted',
      entityType: 'media_asset',
      entityId: pendingAsset.id,
      metadata: {
        provider: pendingAsset.provider,
      },
      onlyIfPreviousChangedOneRow: true,
    }), {
      query: 'DELETE FROM media_placements WHERE organization_id = ? AND asset_id = ?',
      params: [organizationId, pendingAsset.id],
    }, {
      query: 'DELETE FROM product_stay_photo_room_memberships WHERE organization_id = ? AND asset_id = ?',
      params: [organizationId, pendingAsset.id],
    }, ...stayAccessibilityEvidenceGuardQueries(organizationId, { assetId: pendingAsset.id }), publicResourceCacheInvalidationQuery(organizationId, 'media-delete')]).catch((error: unknown) => { throw stayAccessibilityEvidenceWriteError(error) })
    if (Number(result?.meta?.changes ?? 0) !== 1) {
      throw new Error(`Media asset ${pendingAsset.id} changed during deletion`)
    }
  }

  const deletionResults = await Promise.allSettled(deletions.map(deletion => deletion.run()))
  const failures = deletionResults.flatMap((result, index) => result.status === 'rejected'
    ? [`${deletions[index]!.label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
    : [])

  if (sourcePlacements.length) {
    const { refreshSocialCard, socialCardRefreshOwnersForPlacement } = await import('~/server/utils/social-card')
    for (const placement of sourcePlacements) {
      for (const owner of await socialCardRefreshOwnersForPlacement(db, placement)) await refreshSocialCard({ db, env, owner, actorId: deletedByUserId })
    }
  }
  if (failures.length > 0) {
    throw new Error(`Media asset ${pendingAsset.id} is deleted but its storage was not: ${failures.join('; ')}`)
  }
}
