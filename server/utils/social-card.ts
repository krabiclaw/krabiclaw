import { execute, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import {
  buildSingleMediaPlacementQueries,
  deleteMediaAsset,
  mediaPlacementsQuery,
  groupMediaPlacements,
  type StoredMediaPlacementItem,
} from '~/server/utils/media-asset-manager'
import { uploadResolvedMediaToAssetStore, type UploadResolvedMediaInput } from '~/server/utils/media-upload'
import { cloudflareImagesConfigured } from '~/server/utils/cloudflare-images'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { renderOgImagePng } from '~/server/utils/og-image/render'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  truncateForSeo,
  type SocialCardRenderPayload,
  type SocialTemplate,
} from '~/utils/social-metadata'
import { resolvePublicSite } from '~/utils/site-routing'
import { mediaStillUrl, resolveOwnerPicture } from '~/shared/media-placement-contract'
import { platformHomeSocialCardCopy } from '~/server/utils/platform-home-social-card'
import { publicLocationProtectedSql } from '~/server/utils/public-location-privacy'
import { publicLocationIsProtected } from '~/shared/location-sharing'
import type { OrganizationSocialCardRefresh } from '~/utils/social-card-refresh'

export function hashSocialCardGenerationInput(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)))
}

const SOCIAL_CARD_OWNERS = {
  organization: { table: 'organization', tenant: 'o.id', filter: "o.status = 'active'" },
  business_location: { table: 'business_locations', tenant: 'o.organization_id', filter: "o.status = 'active'" },
  product: { table: 'products', tenant: 'o.organization_id', filter: 'o.active = 1' },
  content_document: { table: 'content_documents', tenant: 'o.organization_id', filter: "o.kind IN ('page','article','social_post') AND EXISTS (SELECT 1 FROM content_documents root WHERE root.id = COALESCE(o.root_id, o.id) AND (root.kind = 'page' OR root.status = 'published')) AND (o.kind != 'page' OR o.path != '/')" },
  review: { table: 'reviews', tenant: 'o.organization_id', filter: "o.status = 'approved' AND o.organization_id IS NOT NULL" },
} satisfies Record<string, { table: string; tenant: string; filter: string }>

/**
 * The placement writes that change a card: the slot `resolveOwnerPicture`
 * reads for that owner. A gallery write cannot change what the card draws.
 */
const CARD_PICTURE_SLOT = {
  business_location: 'hero',
  product: 'image',
  content_document: 'cover',
  review: 'portrait',
} as const

export type SocialCardOwner = { owner_type: keyof typeof SOCIAL_CARD_OWNERS; owner_id: string }

export async function listSocialCardOwners(db: DbClient, input: { organizationId?: string; after?: string | null; limit?: number } = {}) {
  const owners: (SocialCardOwner & { cursor: string })[] = []
  for (const [ownerType, source] of Object.entries(SOCIAL_CARD_OWNERS).sort(([left], [right]) => left < right ? -1 : 1)) {
    const remaining = input.limit === undefined ? -1 : input.limit - owners.length
    if (remaining === 0) break
    const filter = ownerType === 'organization' && input.organizationId ? '1' : source.filter
    owners.push(...await queryAll<SocialCardOwner & { cursor: string }>(db, `SELECT '${ownerType}' AS owner_type, o.id AS owner_id, '${ownerType}:' || o.id AS cursor
      FROM ${source.table} o WHERE ${filter}
        AND (? IS NULL OR ${source.tenant} = ?) AND (? IS NULL OR '${ownerType}:' || o.id > ?)
      ORDER BY o.id LIMIT ?`, [input.organizationId ?? null, input.organizationId ?? null, input.after ?? null, input.after ?? null, remaining]))
  }
  return owners
}

export type SocialCardRefreshResult =
  | { kind: 'generated'; owner: SocialCardOwner; asset_id: string; public_url: string; generation_key: string }
  | { kind: 'reused'; owner: SocialCardOwner; asset_id: string; public_url: string; generation_key: string }
  | { kind: 'skipped'; owner: SocialCardOwner; reason: 'no_source' | 'owner_not_found' | 'missing_content' | 'images_unavailable' | 'private_location' }
  | { kind: 'failed'; owner: SocialCardOwner; error: string }

interface OwnerRecord {
  organization_id: string
  title: string | null
  description: string | null
  label: string | null
  location: string | null
  is_stay_location?: number
}

interface OrganizationRecord {
  organization_id: string
  id: string
  name: string | null
  brand_description: string | null
  theme_id: string
  vertical: string
}

export type SocialCardPlacedAsset = StoredMediaPlacementItem

const SOCIAL_CARD_RENDERER_VERSION = 'social-card-v2'
export type SocialCardEnv = UploadResolvedMediaInput['env'] & { IMAGES?: ImagesBinding; NUXT_PUBLIC_PLATFORM_DOMAIN?: string }

export const SOCIAL_CARD_REFRESH_PREFIX = 'social-card-refresh:'
export const SOCIAL_CARD_REFRESH_LEASE_SECONDS = 5 * 60
type SocialCardRefreshClaim = { id: string; claimedAt: string }
type SocialCardRefreshWork = { cursor: string | null; displaced: string | null }
const SOCIAL_CARD_REFRESH_WORK_START = SOCIAL_CARD_REFRESH_PREFIX.length + 1

function socialCardRefreshReason(cursor: string | null, displaced: string | null = null) {
  return SOCIAL_CARD_REFRESH_PREFIX + JSON.stringify({ cursor, displaced })
}

function cardRefreshWork(reason: string): SocialCardRefreshWork {
  return JSON.parse(reason.slice(SOCIAL_CARD_REFRESH_PREFIX.length))
}

export function expiredSocialCardRefreshClaim(now = new Date()): string {
  return new Date(now.getTime() - SOCIAL_CARD_REFRESH_LEASE_SECONDS * 1000).toISOString()
}

function socialCardClaimGuard(claim?: SocialCardRefreshClaim): BatchQuery {
  return claim ? {
    query: "EXISTS (SELECT 1 FROM public_resource_cache_invalidations WHERE id = ? AND status = 'processing' AND processed_at = ?)",
    params: [claim.id, claim.claimedAt],
  } : { query: '1', params: [] }
}

function recordDisplacedSocialCard(claim: SocialCardRefreshClaim | undefined, assetId: string | undefined): BatchQuery[] {
  if (!claim || !assetId) return []
  return [{
    query: `UPDATE public_resource_cache_invalidations
      SET reason = ? || json_set(substr(reason, ?), '$.displaced', ?)
      WHERE id = ? AND status = 'processing' AND processed_at = ?`,
    params: [SOCIAL_CARD_REFRESH_PREFIX, SOCIAL_CARD_REFRESH_WORK_START, assetId, claim.id, claim.claimedAt],
  }]
}

// Store the unfinished cursor in the existing site-change record. The first
// statement follows the name UPDATE in the same D1 batch. A newer rename
// replaces the old cursor, so it always visits every owner for the new name.
export function queueOrganizationSocialCardRefresh(organizationId: string): { id: string; queries: BatchQuery[] } {
  const refresh = publicResourceCacheInvalidationQuery(organizationId, socialCardRefreshReason(null), { query: 'changes() = 1', params: [] })
  const id = String(refresh.params![0])
  const prefix = `${SOCIAL_CARD_REFRESH_PREFIX}%`
  return { id, queries: [refresh, {
    query: `UPDATE public_resource_cache_invalidations
      SET reason = ? || json_set(substr(reason, ?), '$.displaced', (
        SELECT json_extract(substr(old.reason, ?), '$.displaced')
        FROM public_resource_cache_invalidations old
        WHERE old.organization_id = ? AND old.reason LIKE ? AND old.rowid < public_resource_cache_invalidations.rowid
        ORDER BY old.rowid DESC LIMIT 1
      ))
      WHERE id = ?`,
    params: [SOCIAL_CARD_REFRESH_PREFIX, SOCIAL_CARD_REFRESH_WORK_START, SOCIAL_CARD_REFRESH_WORK_START, organizationId, prefix, id],
  }, {
    query: `DELETE FROM public_resource_cache_invalidations
      WHERE organization_id = ? AND reason LIKE ? AND rowid < (
        SELECT rowid FROM public_resource_cache_invalidations WHERE id = ?
      )`,
    params: [organizationId, prefix, id],
  }] }
}

type SocialCardRefreshRow = { id: string; reason: string; status: 'pending' | 'processing' | 'processed' | 'failed'; last_error: string | null }

export function organizationSocialCardRefreshQuery(organizationId: string | { sql: string }): BatchQuery {
  return { query: `
    SELECT id, reason, status, last_error FROM public_resource_cache_invalidations
    WHERE organization_id = ${typeof organizationId === 'string' ? '?' : organizationId.sql} AND reason LIKE ? ORDER BY rowid DESC LIMIT 1
  `, params: [...(typeof organizationId === 'string' ? [organizationId] : []), `${SOCIAL_CARD_REFRESH_PREFIX}%`] }
}

function readOrganizationSocialCardRefresh(db: DbClient, organizationId: string) {
  const { query, params } = organizationSocialCardRefreshQuery(organizationId)
  return queryFirst<SocialCardRefreshRow>(db, query, params)
}

export async function loadOrganizationSocialCardRefresh(db: DbClient, organizationId: string): Promise<OrganizationSocialCardRefresh | null> {
  return organizationSocialCardRefresh(await readOrganizationSocialCardRefresh(db, organizationId))
}

export function organizationSocialCardRefresh(row?: SocialCardRefreshRow | null): OrganizationSocialCardRefresh | null {
  if (!row) return null
  return {
    id: row.id,
    status: row.status === 'processed' ? 'complete' : row.status === 'failed' ? 'failed' : 'pending',
    cursor: cardRefreshWork(row.reason).cursor,
    error: row.last_error,
  }
}

export async function advanceOrganizationSocialCardRefresh(input: {
  db: DbClient
  env: SocialCardEnv
  organizationId: string
  actorId?: string | null
  id?: string
  retryFailed?: boolean
}) {
  const { db, organizationId } = input
  const refresh = await readOrganizationSocialCardRefresh(db, organizationId)
  if (!refresh || refresh.status === 'processed' || (input.id && input.id !== refresh.id) || (refresh.status === 'failed' && !input.retryFailed)) {
    return { refresh: await loadOrganizationSocialCardRefresh(db, organizationId), results: [] as SocialCardRefreshResult[], next_cursor: null }
  }
  const now = new Date()
  const claim = { id: refresh.id, claimedAt: now.toISOString() }
  const work = cardRefreshWork(refresh.reason)
  const claimed = await execute(db, `
    UPDATE public_resource_cache_invalidations SET status = 'processing', processed_at = ?, last_error = NULL
    WHERE id = ? AND reason = ? AND (
      status = 'pending' OR (status = 'failed' AND ?) OR (status = 'processing' AND processed_at < ?)
    )
  `, [claim.claimedAt, claim.id, refresh.reason, input.retryFailed ? 1 : 0, expiredSocialCardRefreshClaim(now)])
  if (claimed.meta?.changes !== 1) {
    return { refresh: await loadOrganizationSocialCardRefresh(db, organizationId), results: [] as SocialCardRefreshResult[], next_cursor: null }
  }
  let results: SocialCardRefreshResult[] = []
  let next_cursor: string | null = null
  let error: string | null = null
  try {
    if (work.displaced) await deleteUnplacedCard(db, input.env, work.displaced, organizationId, input.actorId ?? null)
    const batch = await regenerateOrganizationSocialCards({ ...input, after: work.cursor, claim })
    results = batch.results
    next_cursor = batch.next_cursor
    const result = results[0]
    if (result?.kind === 'failed') error = `${result.owner.owner_type}/${result.owner.owner_id}: ${result.error}`
    if (result?.kind === 'skipped' && result.reason === 'images_unavailable') error = `${result.owner.owner_type}/${result.owner.owner_id}: image storage is unavailable`
  } catch (cause) {
    error = errorMessage(cause)
  }
  const status = error ? 'failed' : next_cursor ? 'pending' : 'processed'
  const [finished] = await executeBatch(db, [{
    query: `UPDATE public_resource_cache_invalidations
      SET status = ?, reason = COALESCE(?, reason), processed_at = ?, last_error = ?
      WHERE id = ? AND status = 'processing' AND processed_at = ?`,
    params: [status, error ? null : socialCardRefreshReason(next_cursor),
      new Date().toISOString(), error?.slice(0, 2000) ?? null, claim.id, claim.claimedAt],
    ...(status === 'pending' ? { event: { type: 'site.cache_changed' as const, organization_id: organizationId, invalidation_id: claim.id } } : {}),
  }], { operation: 'Advance social-card refresh' })
  const current = await loadOrganizationSocialCardRefresh(db, organizationId)
  if (finished?.meta.changes !== 1) return { refresh: current, results: [], next_cursor: null }
  return { refresh: current, results, next_cursor }
}

export async function socialCardRefreshOwnersForPlacement(db: DbClient, placement: {
  owner_type: string
  owner_id: string
  slot: string
}): Promise<SocialCardOwner[]> {
  switch (placement.owner_type) {
    case 'organization':
      // The logo is drawn on the card and the share image is its picture.
      return placement.slot === 'logo' || placement.slot === 'social_share'
        ? [{ owner_type: 'organization', owner_id: placement.owner_id }]
        : []
    case 'content_block': {
      // Only a top-level block's own picture can be a document's leading
      // picture. The home page is not a card of its own and is not the
      // organization's either: that card draws the share image.
      if (placement.slot !== 'media') return []
      const document = await queryFirst<{ id: string }>(db, `
        SELECT d.id
          FROM content_blocks cb
          JOIN content_documents d ON d.id = cb.document_id
         WHERE cb.id = ? AND cb.parent_block_id IS NULL
           AND d.kind IN ('page','article') AND (d.kind != 'page' OR d.path != '/')
         LIMIT 1
      `, [placement.owner_id])
      return document ? [{ owner_type: 'content_document', owner_id: document.id }] : []
    }
    case 'business_location':
    case 'product':
    case 'content_document':
    case 'review':
      return CARD_PICTURE_SLOT[placement.owner_type] === placement.slot
        ? [{ owner_type: placement.owner_type, owner_id: placement.owner_id }]
        : []
    default:
      return []
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function socialCardOwnerQuery(owner: SocialCardOwner): string {
  switch (owner.owner_type) {
    case 'organization':
      return `SELECT id AS organization_id,
        COALESCE(NULLIF(trim(seo_title), ''), NULLIF(trim(name), '')) AS title,
        COALESCE(NULLIF(trim(seo_description), ''), NULLIF(trim(brand_description), '')) AS description,
        NULL AS label, NULL AS location FROM organization WHERE id = ? LIMIT 1`
    case 'business_location':
      return `SELECT organization_id,
        COALESCE(NULLIF(trim(seo_title), ''), title) AS title,
        COALESCE(NULLIF(trim(seo_description), ''), NULLIF(trim(short_description), ''), NULLIF(trim(description), '')) AS description,
        'Location' AS label, COALESCE(address ->> '$.sublocality', address ->> '$.locality') AS location,
        ${publicLocationProtectedSql('bl')} AS is_stay_location FROM business_locations bl WHERE id = ? LIMIT 1`
    case 'product':
      return `SELECT p.organization_id,
        p.name AS title,
        NULLIF(trim(p.description), '') AS description,
        'Product' AS label, NULL AS location
        FROM products p
        JOIN product_publications pub ON pub.product_id = p.id
          AND pub.organization_id = p.organization_id AND pub.published = 1
        WHERE p.id = ? LIMIT 1`
    case 'content_document':
      return `SELECT d.organization_id,
        COALESCE(NULLIF(trim(d.title), ''), NULLIF(trim(substr(d.summary, 1, 80)), '')) AS title,
        NULLIF(trim(d.summary), '') AS description,
        CASE d.kind WHEN 'article' THEN 'Article' WHEN 'social_post' THEN 'Update' END AS label,
        bl.title AS location
        FROM content_documents d JOIN content_documents root ON root.id = COALESCE(d.root_id, d.id)
        LEFT JOIN business_locations bl ON bl.id = root.location_id
        WHERE d.id = ? AND d.kind IN ('page','article','social_post') LIMIT 1`
    case 'review':
      return `SELECT organization_id,
        COALESCE(NULLIF(trim(title), ''), 'Review by ' || COALESCE(NULLIF(trim(author_name), ''), 'a customer')) AS title,
        NULLIF(trim(content), '') AS description, 'Review' AS label, NULL AS location
        FROM reviews WHERE id = ? AND organization_id IS NOT NULL LIMIT 1`
  }
}

type StoredSocialCard = { organization_id: string; asset_id: string }

async function readSocialCardSources(db: DbClient, owner: SocialCardOwner) {
  const scope = socialCardOwnerQuery(owner)
  const organizationId = { sql: '(SELECT organization_id FROM card_owner)' }
  const queries: BatchQuery[] = [
    { query: scope, params: [owner.owner_id] },
    { query: `SELECT id, name, brand_description, theme_id, vertical FROM organization WHERE id = ${organizationId.sql}` },
    mediaPlacementsQuery({ organizationId, ownerType: owner.owner_type, owners: [owner.owner_id], includePendingSocialCard: true }),
    mediaPlacementsQuery({ organizationId, ownerType: 'organization', owners: { sql: `SELECT ${organizationId.sql}` } }),
    { query: "SELECT organization_id, asset_id FROM media_placements WHERE owner_type = ? AND owner_id = ? AND slot = 'social_card'",
      params: [owner.owner_type, owner.owner_id] },
  ]
  const isDocument = owner.owner_type === 'content_document'
  const isPlatformHome = owner.owner_type === 'organization' && owner.owner_id === 'platform'
  if (isDocument) queries.push(mediaPlacementsQuery({
    organizationId,
    ownerType: 'content_block',
    owners: {
      sql: `SELECT cb.id FROM content_blocks cb
        JOIN media_placements mp ON mp.owner_type = 'content_block' AND mp.owner_id = cb.id
          AND mp.organization_id = ${organizationId.sql} AND mp.slot = 'media' AND mp.status = 'active'
        JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id AND ma.status = 'active'
        WHERE cb.document_id = ? AND cb.parent_block_id IS NULL ORDER BY cb.position LIMIT 1`,
      params: [owner.owner_id],
    },
  }))
  if (isPlatformHome) queries.push({
    query: `SELECT cb.data_json FROM content_documents d JOIN content_blocks cb ON cb.document_id = d.id
      WHERE d.organization_id = ${organizationId.sql} AND d.kind = 'page' AND d.row_role = 'root'
        AND d.path = '/' AND cb.type = 'hero' AND cb.parent_block_id IS NULL ORDER BY cb.position LIMIT 1`,
  })
  const [ownerRow, site, placements, brand, cards, extra] = await executeBatch(db, queries.map((statement, index) =>
    index === 0 || index === 4 ? statement : {
      query: `WITH card_owner AS (${scope}) ${statement.query}`, params: [owner.owner_id, ...(statement.params ?? [])],
    }), { operation: 'Read the social card and its source media' })
  const organization = site!.results[0] as OrganizationRecord | undefined
  const record = ownerRow!.results[0] as OwnerRecord | undefined
  const hero = isPlatformHome ? extra?.results[0] as { data_json: string } | undefined : undefined
  const copy = hero ? platformHomeSocialCardCopy(JSON.parse(hero.data_json)) : null
  return {
    ownerRecord: record && copy ? { ...record, title: copy.title, description: copy.description ?? record.description } : record,
    organization,
    ownerMedia: groupMediaPlacements(placements!.results).get(owner.owner_id) ?? [],
    organizationMedia: organization ? groupMediaPlacements(brand!.results).get(organization.id) ?? [] : [],
    leadingMedia: isDocument ? [...groupMediaPlacements(extra!.results).values()].flat() : [],
    cards: cards!.results as StoredSocialCard[],
  }
}

export function buildSocialCardGenerationKey(input: {
  sourceAssetId: string
  logoAssetId: string | null
  sourceUpdatedAt?: string | null
  logoUpdatedAt?: string | null
  payload: SocialCardRenderPayload
}): string {
  return hashSocialCardGenerationInput(JSON.stringify({ renderer: SOCIAL_CARD_RENDERER_VERSION, ...input }))
}

function socialTemplate(organization: OrganizationRecord): SocialTemplate {
  return resolvePublicSite({ themeId: organization.theme_id}).slug
}

/** A displaced card's image goes once nothing places it; a card another owner still shows stays. */
async function deleteUnplacedCard(db: DbClient, env: SocialCardEnv, assetId: string, organizationId: string, actorId: string | null) {
  if (await queryFirst(db, 'SELECT 1 FROM media_placements WHERE asset_id = ? LIMIT 1', [assetId])) return
  await deleteMediaAsset(db, env, assetId, organizationId, actorId)
}

async function clearSocialCard(input: { db: DbClient; env: SocialCardEnv; owner: SocialCardOwner; actorId?: string | null; claim?: SocialCardRefreshClaim }, placed: StoredSocialCard[], reason: 'no_source' | 'owner_not_found' | 'missing_content' | 'private_location') {
  // Only production stores cards, so only production deletes one; elsewhere
  // the rows are a copy of production's and the card they name is production's.
  if (placed.length) {
    const guard = socialCardClaimGuard(input.claim)
    await executeBatch(input.db, [
      { query: `DELETE FROM media_placements WHERE owner_type = ? AND owner_id = ? AND slot = 'social_card'
          AND asset_id IN (SELECT value FROM json_each(?)) AND (${guard.query})`,
        params: [input.owner.owner_type, input.owner.owner_id, JSON.stringify(placed.map(row => row.asset_id)), ...guard.params!] },
      ...recordDisplacedSocialCard(input.claim, placed[0]?.asset_id),
      ...[...new Set(placed.map(row => row.organization_id))].map(organizationId => publicResourceCacheInvalidationQuery(organizationId, 'social-card-cleared')),
    ], { operation: 'clear social card placement' })
    if (cloudflareImagesConfigured(input.env)) for (const row of placed) await deleteUnplacedCard(input.db, input.env, row.asset_id, row.organization_id, input.actorId ?? null)
  }
  const result = { kind: 'skipped' as const, owner: input.owner, reason }
  console.info('[social-card]', result)
  return result
}
export async function refreshSocialCard(input: {
  db: DbClient
  env: SocialCardEnv
  owner: SocialCardOwner
  actorId?: string | null
  claim?: SocialCardRefreshClaim
}): Promise<Exclude<SocialCardRefreshResult, { kind: 'failed' }>> {
  // A write that changed a card's input calls this, and a card that did not
  // regenerate fails that write: the batch paths below record the failure.
  const { db, env, owner } = input
  const claimGuard = socialCardClaimGuard(input.claim)
  const { ownerRecord, organization, ownerMedia, organizationMedia, leadingMedia, cards } = await readSocialCardSources(db, owner)
  if (!ownerRecord || !organization) return await clearSocialCard(input, cards, 'owner_not_found')
  if (owner.owner_type === 'business_location' && publicLocationIsProtected(ownerRecord.is_stay_location)) return await clearSocialCard(input, cards, 'private_location')
  const title = ownerRecord.title?.trim()
  const organizationName = organization.name?.trim() || null
  if (!title || !organizationName) return await clearSocialCard(input, cards, 'missing_content')

  const source = leadingMedia.length
    ? resolveOwnerPicture('content_block', leadingMedia, organizationMedia)
    : resolveOwnerPicture(owner.owner_type, ownerMedia, organizationMedia)
  const logo = organizationMedia.find(item => item.slot === 'logo' && mediaStillUrl(item)) ?? null
  const current = ownerMedia.find(item => item.slot === 'social_card') ?? null
  const backgroundImageUrl = mediaStillUrl(source)
  if (!source || !backgroundImageUrl) return await clearSocialCard(input, cards, 'no_source')

  const payload: SocialCardRenderPayload = {
    template: socialTemplate(organization),
    title,
    description: truncateForSeo(ownerRecord.description, 160),
    organizationName,
    label: ownerRecord.label,
    location: ownerRecord.location,
    logoUrl: mediaStillUrl(logo),
    backgroundImageUrl,
  }
  const generationKey = buildSocialCardGenerationKey({
    sourceAssetId: source.asset_id,
    logoAssetId: logo?.asset_id ?? null,
    sourceUpdatedAt: source.updated_at,
    logoUpdatedAt: logo?.updated_at ?? null,
    payload,
  })
  // A matching key says what the card would show, not that its image still
  // exists: one deleted out from under its row served 404 forever while every
  // reconcile reused it. The card is reused only while its image is served.
  const currentServed = current?.generation_key === generationKey && current.public_url
    ? (await fetch(current.public_url, { method: 'HEAD' })).ok
    : false
  if (currentServed && current?.public_url) {
    const reused = await execute(db, `UPDATE media_placements SET status = 'active'
      WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND slot = 'social_card' AND asset_id = ?
        AND EXISTS (SELECT 1 FROM organization WHERE id = ? AND name IS ?) AND (${claimGuard.query})`,
    [organization.id, owner.owner_type, owner.owner_id, current.asset_id, organization.id, organization.name, ...claimGuard.params!])
    if (reused.meta?.changes !== 1) throw new Error('Social-card inputs changed during refresh')
    return { kind: 'reused', owner, asset_id: current.asset_id, public_url: current.public_url, generation_key: generationKey }
  }
  // Only production can store a card. Elsewhere the rows are production's copy,
  // so the card it already has stays exactly as it is and the result says why.
  if (!cloudflareImagesConfigured(env)) return { kind: 'skipped', owner, reason: 'images_unavailable' }
  if (!env.IMAGES) throw new Error('Cloudflare Images binding is required to render social cards')
  if (!env.NUXT_PUBLIC_PLATFORM_DOMAIN) throw new Error('NUXT_PUBLIC_PLATFORM_DOMAIN is required to render social cards')
  const png = await renderOgImagePng(payload, { images: env.IMAGES, publicOrigin: env.NUXT_PUBLIC_PLATFORM_DOMAIN })
  const uploaded = await uploadResolvedMediaToAssetStore({
    db,
    env,
    organizationId: organization.id,
    userId: input.actorId ?? null,
    buffer: Uint8Array.from(png),
    contentType: 'image/png',
    filename: 'social-card.png',
    source: 'generated',
    kind: 'image',
    altText: ownerRecord.title,
    fileSize: png.byteLength,
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    generationKey,
  })

  try {
    // Fail this batch if a rename happened during the render or another
    // request has already replaced this placement. Keep the served card
    // available until the replacement is committed.
    const savedCard = mediaPlacementsQuery({
      organizationId: organization.id, ownerType: owner.owner_type, owners: [owner.owner_id], slot: 'social_card', includePendingSocialCard: true,
    })
    const writeGuard: BatchQuery = {
      query: `INSERT INTO media_placements
        (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order)
        SELECT ?, ?, ?, ?, 'social_card', ?, -1
        WHERE NOT (${claimGuard.query}) OR NOT EXISTS (SELECT 1 FROM organization WHERE id = ? AND name IS ?)
          OR (SELECT id FROM (${savedCard.query}) LIMIT 1) IS NOT ?`,
      params: [crypto.randomUUID(), organization.id, owner.owner_type, owner.owner_id, uploaded.assetId, ...claimGuard.params!,
        organization.id, organization.name, ...savedCard.params!, current?.asset_id ?? null],
    }
    await executeBatch(db, [writeGuard, ...buildSingleMediaPlacementQueries({
      organizationId: organization.id,
      placement: { owner_type: owner.owner_type, owner_id: owner.owner_id, slot: 'social_card' },
      media: [{ asset_id: uploaded.assetId }],
    }), ...recordDisplacedSocialCard(input.claim, current?.asset_id),
    publicResourceCacheInvalidationQuery(organization.id, 'social-card-replaced')], { operation: 'replace social card placement' })
  } catch (placementError) {
    try {
      await deleteMediaAsset(db, env, uploaded.assetId, organization.id, input.actorId ?? null)
    } catch (cleanupError) {
      throw new AggregateError([placementError, cleanupError], 'Social card placement and cleanup failed', { cause: cleanupError })
    }
    throw placementError
  }
  // The card this replaces has no placement left; this is production (only it
  // stores cards), so the image goes with it.
  if (current && current.asset_id !== uploaded.assetId) await deleteUnplacedCard(db, env, current.asset_id, organization.id, input.actorId ?? null)

  return { kind: 'generated', owner, asset_id: uploaded.assetId, public_url: uploaded.publicUrl, generation_key: generationKey }
}

export async function regenerateOrganizationSocialCards(input: {
  db: DbClient
  env: SocialCardEnv
  organizationId: string
  actorId?: string | null
  after?: string | null
  claim?: SocialCardRefreshClaim
}) {
  const [current, next] = await listSocialCardOwners(input.db, { organizationId: input.organizationId, after: input.after, limit: 2 })
  if (!current) return { results: [] as SocialCardRefreshResult[], next_cursor: null }
  const { owner_type, owner_id } = current
  const owner = { owner_type, owner_id }
  let result: SocialCardRefreshResult
  try {
    result = await refreshSocialCard({ ...input, owner })
  } catch (error) {
    result = { kind: 'failed', owner, error: errorMessage(error) }
  }
  return { results: [result], next_cursor: next ? current.cursor : null }
}
