import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { assertResourceAccess, type MemberAccessPrincipal } from '~/server/utils/member-access'
import type { CloudflareEnv } from '~/server/utils/auth'
import {
  hydrateMediaAssetRefs,
  MAX_ORDERED_MEDIA_ASSETS,
  buildSingleMediaPlacementQueries,
  buildMediaPlacementReplacementQueries,
  mediaPlacementOwnerQuery,
  isSingleMediaPlacement,
  readMediaPlacements,
  type MediaAssetRefInput,
  type StoredMediaPlacementItem,
} from '~/server/utils/media-asset-manager'
import { isEditableMediaPlacement, isEditableMediaPlacementOwnerType, type EditableMediaPlacementOwnerType, type LogoPresentation, type MediaPlacementOwnerType } from '~/shared/media-placement-contract'
import { refreshSocialCard, socialCardRefreshOwnersForPlacement } from '~/server/utils/social-card'
import { postMediaMutationQueries } from '~/server/utils/post-management'

export { EDITABLE_MEDIA_PLACEMENT_OWNERS, MEDIA_CATEGORIES, WRITABLE_MEDIA_CATEGORIES, isMediaCategory } from '~/shared/media-placement-contract'
export type { MediaCategory } from '~/shared/media-placement-contract'
export type MediaPlacementItem = StoredMediaPlacementItem

export interface MediaPlacementKey {
  owner_type: EditableMediaPlacementOwnerType
  owner_id: string
  slot: string
}

interface PlacementAuthInput {
  organizationId: string
  env: CloudflareEnv
  // Optional: the internal seeding paths have no caller to authorize. When it
  // is present it is a resolved principal, never loose role/organization fields.
  principal?: MemberAccessPrincipal
  placement: MediaPlacementKey
}

export function parseMediaPlacementKey(value: unknown): MediaPlacementKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'placement must be an object' })
  }
  const record = value as Record<string, unknown>
  const ownerType = typeof record.owner_type === 'string' ? record.owner_type.trim() : ''
  const ownerId = typeof record.owner_id === 'string' ? record.owner_id.trim() : ''
  const slot = typeof record.slot === 'string' ? record.slot.trim() : ''
  if (!isEditableMediaPlacementOwnerType(ownerType)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'placement.owner_type is invalid' })
  }
  if (!ownerId) throw new HTTPError({ statusCode: 400, statusMessage: 'placement.owner_id is required' })
  if (!slot) throw new HTTPError({ statusCode: 400, statusMessage: 'placement.slot is required' })
  if (!isEditableMediaPlacement({ owner_type: ownerType, slot })) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'placement owner_type and slot are not supported' })
  }
  return { owner_type: ownerType, owner_id: ownerId, slot }
}

export function parseMediaPlacementMoves(value: unknown): MediaPlacementMove[] {
  if (!Array.isArray(value)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'moves must be an array' })
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HTTPError({ statusCode: 400, statusMessage: 'each move must be an object' })
    }
    const record = item as Record<string, unknown>
    if (typeof record.asset_id !== 'string' || !record.asset_id.trim()) {
      throw new HTTPError({ statusCode: 400, statusMessage: 'each move requires asset_id' })
    }
    const move: MediaPlacementMove = { asset_id: record.asset_id }
    if (record.before_asset_id !== undefined) {
      if (typeof record.before_asset_id !== 'string') throw new HTTPError({ statusCode: 400, statusMessage: 'before_asset_id must be a string' })
      move.before_asset_id = record.before_asset_id
    }
    if (record.after_asset_id !== undefined) {
      if (typeof record.after_asset_id !== 'string') throw new HTTPError({ statusCode: 400, statusMessage: 'after_asset_id must be a string' })
      move.after_asset_id = record.after_asset_id
    }
    return move
  })
}

function isUniqueConstraintError(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))
}

function allowedKindsFor(placement: MediaPlacementKey): Array<'image' | 'video' | 'file'> {
  return placement.owner_type === 'organization' && placement.slot === 'compliance_document' ? ['file'] : ['image', 'video']
}

/**
 * A short post's cover and gallery are its content: changing them is refused
 * while a publication of it is in flight, advances the post's revision and
 * makes it the tenant's own, in the same batch as the placement change.
 */
async function postMediaQueries(db: DbClient, input: PlacementAuthInput): Promise<BatchQuery[]> {
  return await postMediaMutationQueries(db, { organizationId: input.organizationId, ownerType: input.placement.owner_type, ownerId: input.placement.owner_id, slot: input.placement.slot })
}

async function authorizePlacementWrite(db: DbClient, input: PlacementAuthInput): Promise<void> {
  const locationId = await requirePlacementOwner(db, input)
  if (input.placement.owner_type === 'content_document' || input.placement.owner_type === 'content_block') {
    const document = await queryFirst<{ kind: string }>(db,
      input.placement.owner_type === 'content_document'
        ? 'SELECT kind FROM content_documents WHERE id = ?'
        : 'SELECT d.kind FROM content_blocks b JOIN content_documents d ON d.id = b.document_id WHERE b.id = ?',
      [input.placement.owner_id])
    if (document?.kind === 'qa') throw new HTTPError({ statusCode: 403, statusMessage: 'Q&A is read-only' })
  }
  if (input.principal) {
    // The principal carries its own organization and site, and the write targets
    // the ones on `input`. They are the same at every call site today, and this
    // is what keeps it that way: authorizing one scope while writing to another
    // is the whole failure this check exists to prevent.
    if (
      input.principal.organizationId !== input.organizationId
      || input.principal.organizationId !== input.organizationId
    ) {
      throw new HTTPError({ statusCode: 403, statusMessage: 'Access denied' })
    }
    await assertResourceAccess(db, { ...input.principal, resourceLocationId: locationId })
  }
}

// The canonical, server-authoritative state of one owner+slot's media after
// a mutation. Every attach/remove/reorder response returns this so callers
// replace their local list wholesale rather than trying to reconcile it
// against whatever they sent — the response, not the request, is the truth.
async function canonicalPlacementState(db: DbClient, input: {
  organizationId: string
  placement: MediaPlacementKey
}) {
  const items = (await getMediaPlacements(db, {
    organizationId: input.organizationId,
    ownerType: input.placement.owner_type,
    ownerIds: [input.placement.owner_id],
    slot: input.placement.slot,
  })).get(input.placement.owner_id) ?? []
  return {
    entity: input.placement.owner_type,
    id: input.placement.owner_id,
    placement: input.placement,
    asset_ids: items.map(item => item.asset_id),
    media: items,
    cleared: items.length === 0,
  }
}

// Single-value slots (logo, cover, hero, featured, thumbnail, ...): cardinality
// is always <= 1, so a plain replace is the correct, safe semantic — there is
// no ordering and nothing to resurrect. Throws for an ordered collection; use
// attachMediaPlacement/removeMediaPlacement/reorderMediaPlacements for those.
export async function setSingleMediaPlacement(db: DbClient, input: {
  organizationId: string
  env: CloudflareEnv
  // Optional: the internal seeding paths have no caller to authorize. When it
  // is present it is a resolved principal, never loose role/organization fields.
  principal?: MemberAccessPrincipal
  placement: MediaPlacementKey
  assetId: string | null
  /** A logo placement's shape and focal point. */
  presentation?: LogoPresentation | null
}) {
  await authorizePlacementWrite(db, input)
  const postQueries = await postMediaQueries(db, input)
  const refs: MediaAssetRefInput[] = input.assetId ? [{ asset_id: input.assetId }] : []
  const media = await hydrateMediaAssetRefs(db, {
    organizationId: input.organizationId,
    refs,
    allowedKinds: allowedKindsFor(input.placement),
    fieldName: 'asset_id',
  })
  await executeBatch(db, [...postQueries, ...buildSingleMediaPlacementQueries({ ...input, media: media.map(item => ({ ...item, presentation: input.presentation })) })])
  await refreshSocialCardForPlacement(db, input)
  return canonicalPlacementState(db, input)
}

export async function getMediaPlacements(db: DbClient, input: {
  organizationId: string
  ownerType: MediaPlacementOwnerType
  ownerIds: string[]
  slot?: string
}): Promise<Map<string, MediaPlacementItem[]>> {
  return await readMediaPlacements(db, input)
}

async function refreshSocialCardForPlacement(db: DbClient, input: {
  env: CloudflareEnv
  placement: MediaPlacementKey
}) {
  // The placement write has committed, and the card is derived from it. A card
  // that did not regenerate is the wrong image on every share of that page, which
  // is not something the console should be the only one to know.
  const owners = await socialCardRefreshOwnersForPlacement(db, input.placement)
  for (const owner of owners) await refreshSocialCard({ db, env: input.env, owner })
}

// Append a new asset atomically; an existing membership remains in its current position.
export async function attachMediaPlacement(db: DbClient, input: {
  organizationId: string
  env: CloudflareEnv
  // Optional: the internal seeding paths have no caller to authorize. When it
  // is present it is a resolved principal, never loose role/organization fields.
  principal?: MemberAccessPrincipal
  placement: MediaPlacementKey
  assetId: string
}) {
  if (isSingleMediaPlacement(input.placement)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'This placement is single-valued; use setSingleMediaPlacement instead' })
  }
  await authorizePlacementWrite(db, input)
  const postQueries = await postMediaQueries(db, input)
  const [asset] = await hydrateMediaAssetRefs(db, {
    organizationId: input.organizationId,
    refs: [{ asset_id: input.assetId }],
    allowedKinds: allowedKindsFor(input.placement),
    fieldName: 'asset_id',
  })
  if (!asset) throw new HTTPError({ statusCode: 400, statusMessage: 'asset_id is required' })
  const current = await canonicalPlacementState(db, input)
  if (current.asset_ids.includes(input.assetId)) {
    await refreshSocialCardForPlacement(db, input)
    return canonicalPlacementState(db, input)
  }
  const now = new Date().toISOString()
  const scopeParams = [input.organizationId, input.placement.owner_type, input.placement.owner_id, input.placement.slot]
  const owner = mediaPlacementOwnerQuery({ ...input, ownerType: input.placement.owner_type, ownerId: input.placement.owner_id })
  let results
  try {
    results = await executeBatch(db, [...postQueries, {
      query: `INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?,
          COALESCE((SELECT MAX(sort_order) + 1 FROM media_placements WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND slot = ?), 0),
          'active', ?, ?
        WHERE (SELECT COUNT(*) FROM media_placements WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND slot = ?) < ?
          AND EXISTS (${owner.query})
          AND EXISTS (SELECT 1 FROM media_assets WHERE id = ? AND organization_id = ? AND status = 'active')`,
      params: [
        crypto.randomUUID(), ...scopeParams, asset.asset_id,
        ...scopeParams,
        now, now,
        ...scopeParams,
        MAX_ORDERED_MEDIA_ASSETS,
        ...owner.params!,
        asset.asset_id, input.organizationId,
      ],
    }])
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const saved = await canonicalPlacementState(db, input)
      if (saved.asset_ids.includes(input.assetId)) {
        await refreshSocialCardForPlacement(db, input)
        return canonicalPlacementState(db, input)
      }
    }
    throw error
  }
  if (Number(results[postQueries.length]?.meta?.changes ?? 0) === 0) {
    const saved = await canonicalPlacementState(db, input)
    if (!saved.asset_ids.includes(input.assetId)) {
      throw new HTTPError({ statusCode: 422, statusMessage: `The owner no longer accepts media or has reached ${MAX_ORDERED_MEDIA_ASSETS} assets` })
    }
  }
  await refreshSocialCardForPlacement(db, input)
  return canonicalPlacementState(db, input)
}

// Detaches one asset from an ordered collection. Idempotent: removing an
// asset that's already gone (or was never attached) affects zero rows and
// is not an error — it never mutates anything else in the collection, so
// unmentioned assets keep their exact position.
export async function removeMediaPlacement(db: DbClient, input: {
  organizationId: string
  env: CloudflareEnv
  // Optional: the internal seeding paths have no caller to authorize. When it
  // is present it is a resolved principal, never loose role/organization fields.
  principal?: MemberAccessPrincipal
  placement: MediaPlacementKey
  assetId: string
}) {
  await authorizePlacementWrite(db, input)
  await executeBatch(db, [...await postMediaQueries(db, input), { query: `
    DELETE FROM media_placements
     WHERE organization_id = ?  AND owner_type = ? AND owner_id = ? AND slot = ? AND asset_id = ?
  `, params: [input.organizationId, input.placement.owner_type, input.placement.owner_id, input.placement.slot, input.assetId] }])
  await refreshSocialCardForPlacement(db, input)
  return canonicalPlacementState(db, input)
}

export interface MediaPlacementMove {
  asset_id: string
  before_asset_id?: string
  after_asset_id?: string
}

// Rewrites positions within an ordered collection without ever changing
// membership. Moves are anchored (before/after another asset already in the
// collection) rather than numeric, since a numeric index is only meaningful
// against a snapshot the caller may no longer hold; moves apply sequentially
// in the order given, each against the result of the previous one.
//
// Membership can never change here: every referenced asset (moved or anchor)
// must already be in the collection or the whole call is rejected before any
// write happens. The write itself is guarded atomically against the exact
// live membership read moments earlier — if anything attached or detached in
// between, the guard row's deliberately invalid lifecycle status fails the retained
// media_placements_status_check,
// the whole batch (including every position update) rolls back, and the
// caller gets a 409 to re-read and retry. This is stricter than checking just
// the moved assets: it also catches an unrelated concurrent attach/remove
// that this reorder's plan never accounted for.
//
// Positions are dense integers with a unique(owner, sort_order) constraint,
// so a straight per-row UPDATE to final positions can collide mid-batch
// (e.g. swapping two rows). Every affected row is first moved to a negative,
// collision-free temporary position, then to its final dense position — two
// full passes, not a partial per-row update.
export async function reorderMediaPlacements(db: DbClient, input: {
  organizationId: string
  env: CloudflareEnv
  // Optional: the internal seeding paths have no caller to authorize. When it
  // is present it is a resolved principal, never loose role/organization fields.
  principal?: MemberAccessPrincipal
  placement: MediaPlacementKey
  moves: MediaPlacementMove[]
}) {
  if (isSingleMediaPlacement(input.placement)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'This placement is single-valued and has no order' })
  }
  await authorizePlacementWrite(db, input)
  if (input.moves.length === 0) return canonicalPlacementState(db, input)

  const scopeParams = [input.organizationId, input.placement.owner_type, input.placement.owner_id, input.placement.slot]
  const currentRows = await queryAll<{ asset_id: string }>(db, `
    SELECT asset_id FROM media_placements
     WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND slot = ?
     ORDER BY sort_order ASC
  `, scopeParams)
  const currentOrder = currentRows.map(row => row.asset_id)
  const currentSet = new Set(currentOrder)

  for (const move of input.moves) {
    if (!currentSet.has(move.asset_id)) {
      throw new HTTPError({ statusCode: 409, statusMessage: `Media asset is no longer attached to this placement: ${move.asset_id}` })
    }
    if (move.before_asset_id && move.after_asset_id) {
      throw new HTTPError({ statusCode: 400, statusMessage: 'A move may specify before_asset_id or after_asset_id, not both' })
    }
    const anchor = move.before_asset_id ?? move.after_asset_id
    if (anchor && !currentSet.has(anchor)) {
      throw new HTTPError({ statusCode: 409, statusMessage: `Media asset is no longer attached to this placement: ${anchor}` })
    }
  }

  let order = [...currentOrder]
  for (const move of input.moves) {
    order = order.filter(assetId => assetId !== move.asset_id)
    if (move.before_asset_id) {
      const anchorIndex = order.indexOf(move.before_asset_id)
      order.splice(anchorIndex, 0, move.asset_id)
    } else if (move.after_asset_id) {
      const anchorIndex = order.indexOf(move.after_asset_id)
      order.splice(anchorIndex + 1, 0, move.asset_id)
    } else {
      order.push(move.asset_id)
    }
  }

  const queries: BatchQuery[] = [...await postMediaQueries(db, input), buildMembershipGuardQuery({
    organizationId: input.organizationId,
    placement: input.placement,
    expectedAssetIds: currentOrder,
  })]
  order.forEach((assetId) => {
    queries.push({
      query: `UPDATE media_placements SET sort_order = (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM media_placements WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND slot = ?) WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND slot = ? AND asset_id = ?`,
      params: [...scopeParams, ...scopeParams, assetId],
    })
  })
  order.forEach((assetId, index) => {
    queries.push({
      query: `UPDATE media_placements SET sort_order = ?, updated_at = ? WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND slot = ? AND asset_id = ?`,
      params: [index, new Date().toISOString(), ...scopeParams, assetId],
    })
  })

  try {
    await executeBatch(db, queries)
  } catch (error) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'This collection changed while reordering. Reload and try again.', cause: error })
  }
  await refreshSocialCardForPlacement(db, input)
  return canonicalPlacementState(db, input)
}

/**
 * A product's photos as one ordered list: its `image` (the cover every
 * surface shows first) followed by its `gallery` in order. A product with no
 * cover but a gallery lists the gallery alone.
 */
export async function readProductPhotos(db: DbClient, input: { organizationId: string; productIds: string[] }): Promise<Map<string, MediaPlacementItem[]>> {
  const placements = await getMediaPlacements(db, { organizationId: input.organizationId, ownerType: 'product', ownerIds: input.productIds })
  return new Map([...placements].map(([productId, items]) => [productId, [
    ...items.filter(item => item.slot === 'image'),
    ...items.filter(item => item.slot === 'gallery'),
  ]]))
}

/**
 * Write a product's photos as one ordered list: the first becomes its `image`
 * and the rest its `gallery`, in one batch. `from` is the list the caller read
 * and changed; when the product's photos are no longer that list, or change
 * before the batch commits, the write is refused with PHOTOS_CHANGED.
 */
export async function arrangeProductPhotos(db: DbClient, input: {
  organizationId: string
  env: CloudflareEnv
  principal: MemberAccessPrincipal
  productId: string
  from: readonly string[]
  to: readonly string[]
}): Promise<void> {
  const cover: MediaPlacementKey = { owner_type: 'product', owner_id: input.productId, slot: 'image' }
  const gallery: MediaPlacementKey = { ...cover, slot: 'gallery' }
  await authorizePlacementWrite(db, { ...input, placement: cover })
  if (input.to.length > MAX_ORDERED_MEDIA_ASSETS) {
    throw new HTTPError({ statusCode: 422, statusMessage: `A product holds at most ${MAX_ORDERED_MEDIA_ASSETS} photos`, data: { code: 'PHOTO_LIMIT', field: 'photos' } })
  }
  const current = (await readProductPhotos(db, { organizationId: input.organizationId, productIds: [input.productId] })).get(input.productId) ?? []
  const changed = () => new HTTPError({ statusCode: 409, statusMessage: 'The photos changed while saving; reload them and try again', data: { code: 'PHOTOS_CHANGED', field: 'photos' } })
  if (current.length !== input.from.length || current.some((item, index) => item.asset_id !== input.from[index])) throw changed()
  const media = await hydrateMediaAssetRefs(db, {
    organizationId: input.organizationId,
    refs: input.to.map(asset_id => ({ asset_id })),
    allowedKinds: allowedKindsFor(cover),
    fieldName: 'photos',
  })
  // The batch fails on the sort-order check unless the photos are still the
  // rows read above, slot for slot and position for position; an asset
  // deleted meanwhile fails its foreign key. Either is a change since the read.
  const expected = d1JsonStringSet(current.map(item => `${item.slot}:${item.sort_order}:${item.asset_id}`))
  // The same rows readProductPhotos lists: active placements of active assets.
  const placed = `SELECT mp.slot || ':' || mp.sort_order || ':' || mp.asset_id AS entry FROM media_placements mp
    JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id AND ma.status = 'active'
    WHERE mp.organization_id = ? AND mp.owner_type = 'product' AND mp.owner_id = ? AND mp.slot IN ('image', 'gallery') AND mp.status = 'active'`
  const now = new Date().toISOString()
  try {
    await executeBatch(db, [
      {
        query: `INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status, created_at, updated_at)
          SELECT ?, ?, 'product', ?, 'gallery', ?, -1, 'active', ?, ?
           WHERE EXISTS (${placed} EXCEPT SELECT value FROM json_each(?))
              OR EXISTS (SELECT value FROM json_each(?) EXCEPT ${placed})`,
        params: [
          crypto.randomUUID(), input.organizationId, input.productId, '__photos_guard__', now, now,
          input.organizationId, input.productId, expected,
          expected, input.organizationId, input.productId,
        ],
      },
      ...buildMediaPlacementReplacementQueries({ organizationId: input.organizationId, placement: cover, media: media.slice(0, 1), now }),
      ...buildMediaPlacementReplacementQueries({ organizationId: input.organizationId, placement: gallery, media: media.slice(1), now }),
    ], { operation: 'Arrange product photos' })
  } catch (error) {
    if (/CHECK constraint failed|FOREIGN KEY constraint failed/i.test(error instanceof Error ? error.message : String(error))) throw changed()
    throw error
  }
  await refreshSocialCardForPlacement(db, { env: input.env, placement: cover })
}

function buildMembershipGuardQuery(input: {
  organizationId: string
  placement: MediaPlacementKey
  expectedAssetIds: string[]
}): BatchQuery {
  const scopeParams = [input.organizationId, input.placement.owner_type, input.placement.owner_id, input.placement.slot]
  const expectedAssetIds = d1JsonStringSet(input.expectedAssetIds)
  const values = `SELECT value AS asset_id FROM json_each(?)`
  const now = new Date().toISOString()
  return {
    query: `INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, '__reorder_guard__', 0, '__reorder_guard__', ?, ?
       WHERE EXISTS (
         SELECT asset_id FROM media_placements WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND slot = ?
         EXCEPT
         ${values}
       )
       OR EXISTS (
         ${values}
         EXCEPT
         SELECT asset_id FROM media_placements WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND slot = ?
       )`,
    params: [
      crypto.randomUUID(), input.organizationId, input.placement.owner_type, input.placement.owner_id, input.placement.slot, now, now,
      ...scopeParams, expectedAssetIds,
      expectedAssetIds, ...scopeParams,
    ],
  }
}

async function requirePlacementOwner(db: DbClient, input: {
  organizationId: string
  placement: MediaPlacementKey
}): Promise<string | null> {
  const owner = mediaPlacementOwnerQuery({ ...input, ownerType: input.placement.owner_type, ownerId: input.placement.owner_id })
  const row = await queryFirst<{ location_id: string | null }>(db, owner.query, owner.params)
  if (row) return row.location_id
  throw new HTTPError({ statusCode: 404, statusMessage: 'Media placement owner not found' })
}
