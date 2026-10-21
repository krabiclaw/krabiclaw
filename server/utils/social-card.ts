import { executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import {
  buildSingleMediaPlacementQueries,
  deleteMediaAsset,
  readMediaPlacements,
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
import { resolvePublicTemplate } from '~/utils/template-registry'
import { mediaStillUrl, resolveOwnerPicture, type MediaPlacementOwnerType } from '~/shared/media-placement-contract'
import { platformHomeSocialCardCopy } from '~/server/utils/platform-home-social-card'
import { publicLocationProtectedSql } from '~/server/utils/public-location-privacy'
import { publicLocationIsProtected } from '~/shared/location-sharing'

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
    owners.push(...await queryAll<SocialCardOwner & { cursor: string }>(db, `SELECT '${ownerType}' AS owner_type, o.id AS owner_id, '${ownerType}:' || o.id AS cursor
      FROM ${source.table} o WHERE ${source.filter}
        AND (? IS NULL OR ${source.tenant} = ?) AND (? IS NULL OR '${ownerType}:' || o.id > ?)
      ORDER BY o.id LIMIT ?`, [input.organizationId ?? null, input.organizationId ?? null, input.after ?? null, input.after ?? null, remaining]))
  }
  return owners
}

export type SocialCardRefreshResult =
  | { kind: 'generated'; owner: SocialCardOwner; assetId: string; publicUrl: string; generationKey: string }
  | { kind: 'reused'; owner: SocialCardOwner; assetId: string; publicUrl: string; generationKey: string }
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
type SocialCardEnv = UploadResolvedMediaInput['env'] & { IMAGES?: ImagesBinding; NUXT_PUBLIC_PLATFORM_DOMAIN?: string }

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

async function loadOwner(db: DbClient, owner: SocialCardOwner): Promise<OwnerRecord | null> {
  switch (owner.owner_type) {
    case 'organization': {
      const record = await queryFirst<OwnerRecord>(db, `SELECT id AS organization_id,
        COALESCE(NULLIF(trim(seo_title), ''), NULLIF(trim(name), '')) AS title,
        COALESCE(NULLIF(trim(seo_description), ''), NULLIF(trim(brand_description), '')) AS description,
        NULL AS label, NULL AS location FROM organization WHERE id = ? LIMIT 1`, [owner.owner_id]) ?? null
      if (!record || owner.owner_id !== 'platform') return record
      // Home shares the organization's generated card. Read its authored hero
      // instead of producing a name-only card from empty organization SEO fields.
      const hero = await queryFirst<{ data_json: string }>(db, `SELECT cb.data_json
        FROM content_documents d JOIN content_blocks cb ON cb.document_id = d.id
        WHERE d.organization_id = ? AND d.kind = 'page' AND d.row_role = 'root'
          AND d.path = '/' AND cb.type = 'hero' AND cb.parent_block_id IS NULL
        ORDER BY cb.position LIMIT 1`, [owner.owner_id])
      const copy = hero ? platformHomeSocialCardCopy(JSON.parse(hero.data_json)) : null
      return copy ? { ...record, title: copy.title, description: copy.description ?? record.description } : record
    }
    case 'business_location':
      return await queryFirst<OwnerRecord>(db, `SELECT organization_id,
        COALESCE(NULLIF(trim(seo_title), ''), title) AS title,
        COALESCE(NULLIF(trim(seo_description), ''), NULLIF(trim(short_description), ''), NULLIF(trim(description), '')) AS description,
        'Location' AS label, COALESCE(address ->> '$.sublocality', address ->> '$.locality') AS location,
        ${publicLocationProtectedSql('bl')} AS is_stay_location FROM business_locations bl WHERE id = ? LIMIT 1`, [owner.owner_id]) ?? null
    case 'product':
      return await queryFirst<OwnerRecord>(db, `SELECT p.organization_id,
        p.name AS title,
        NULLIF(trim(p.description), '') AS description,
        'Product' AS label, NULL AS location
        FROM products p
        JOIN product_publications pub ON pub.product_id = p.id
          AND pub.organization_id = p.organization_id AND pub.published = 1
        WHERE p.id = ? LIMIT 1`, [owner.owner_id]) ?? null
    case 'content_document':
      return await queryFirst<OwnerRecord>(db, `SELECT d.organization_id,
        COALESCE(NULLIF(trim(d.title), ''), NULLIF(trim(substr(d.summary, 1, 80)), '')) AS title,
        NULLIF(trim(d.summary), '') AS description,
        CASE d.kind WHEN 'article' THEN 'Article' WHEN 'social_post' THEN 'Update' END AS label,
        bl.title AS location
        FROM content_documents d JOIN content_documents root ON root.id = COALESCE(d.root_id, d.id)
        LEFT JOIN business_locations bl ON bl.id = root.location_id
        WHERE d.id = ? AND d.kind IN ('page','article','social_post') LIMIT 1`, [owner.owner_id]) ?? null
    case 'review':
      return await queryFirst<OwnerRecord>(db, `SELECT organization_id,
        COALESCE(NULLIF(trim(title), ''), 'Review by ' || COALESCE(NULLIF(trim(author_name), ''), 'a customer')) AS title,
        NULLIF(trim(content), '') AS description, 'Review' AS label, NULL AS location
        FROM reviews WHERE id = ? AND organization_id IS NOT NULL LIMIT 1`, [owner.owner_id]) ?? null
  }
}

async function loadOrganization(db: DbClient, organizationId: string): Promise<OrganizationRecord | null> {
  return await queryFirst<OrganizationRecord>(db, `SELECT s.id, s.name, s.brand_description,
    s.theme_id, s.vertical
    FROM organization s WHERE s.id = ? LIMIT 1`, [organizationId]) ?? null
}

/**
 * A page's or an article's picture is its first top-level block carrying a
 * `media` placement. Block type is not the test, because the block that leads
 * differs per template; carrying a picture is what they have in common. A
 * social post keeps its picture in its own `cover` and has no blocks.
 */
async function loadLeadingPictureBlockId(db: DbClient, owner: SocialCardOwner): Promise<string | null> {
  if (owner.owner_type !== 'content_document') return null
  const block = await queryFirst<{ id: string }>(db, `SELECT cb.id FROM content_blocks cb
    JOIN media_placements mp ON mp.owner_type = 'content_block' AND mp.owner_id = cb.id
      AND mp.slot = 'media' AND mp.status = 'active'
    JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active'
    WHERE cb.document_id = ? AND cb.parent_block_id IS NULL
    ORDER BY cb.position LIMIT 1`, [owner.owner_id])
  return block?.id ?? null
}

async function readOwnerPlacements(db: DbClient, organizationId: string, ownerType: MediaPlacementOwnerType, ownerId: string, includePendingSocialCard = false) {
  return (await readMediaPlacements(db, { organizationId, ownerType, ownerIds: [ownerId], includePendingSocialCard })).get(ownerId) ?? []
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
  return resolvePublicTemplate({ themeId: organization.theme_id, vertical: organization.vertical }).slug
}

async function clearSocialCard(input: { db: DbClient; env: SocialCardEnv; owner: SocialCardOwner; actorId?: string | null }, reason: 'no_source' | 'owner_not_found' | 'missing_content' | 'private_location') {
  // Unplaced, not deleted: the card may be production's, read from a copy of
  // its rows. social-card-cleanup removes unplaced generated cards.
  const placed = await queryAll<{ organization_id: string; asset_id: string }>(input.db, "SELECT organization_id, asset_id FROM media_placements WHERE owner_type = ? AND owner_id = ? AND slot = 'social_card'", [input.owner.owner_type, input.owner.owner_id])
  if (placed.length) {
    const now = new Date().toISOString()
    await executeBatch(input.db, [
      { query: "DELETE FROM media_placements WHERE owner_type = ? AND owner_id = ? AND slot = 'social_card'", params: [input.owner.owner_type, input.owner.owner_id] },
      // Retention is counted from the moment the card lost its placement.
      ...placed.map(row => ({ query: 'UPDATE media_assets SET updated_at = ? WHERE id = ? AND organization_id = ?', params: [now, row.asset_id, row.organization_id] })),
      ...[...new Set(placed.map(row => row.organization_id))].map(organizationId => publicResourceCacheInvalidationQuery(organizationId, 'social-card-cleared')),
    ], { operation: 'clear social card placement' })
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
}): Promise<Exclude<SocialCardRefreshResult, { kind: 'failed' }>> {
  // A write that changed a card's input calls this, and a card that did not
  // regenerate fails that write: the batch paths below record the failure.
  const { db, env, owner } = input
  const ownerRecord = await loadOwner(db, owner)
  if (!ownerRecord) return await clearSocialCard(input, 'owner_not_found')
  if (owner.owner_type === 'business_location' && publicLocationIsProtected(ownerRecord.is_stay_location)) return await clearSocialCard(input, 'private_location')
  const organization = await loadOrganization(db, ownerRecord.organization_id)
  if (!organization) return await clearSocialCard(input, 'owner_not_found')
  const title = ownerRecord.title?.trim()
  const organizationName = organization.name?.trim() || null
  if (!title || !organizationName) return await clearSocialCard(input, 'missing_content')

  const [ownerMedia, organizationMedia, leadingBlockId] = await Promise.all([
    readOwnerPlacements(db, organization.id, owner.owner_type, owner.owner_id, true),
    readOwnerPlacements(db, organization.id, 'organization', organization.id),
    loadLeadingPictureBlockId(db, owner),
  ])
  const source = leadingBlockId
    ? resolveOwnerPicture('content_block', await readOwnerPlacements(db, organization.id, 'content_block', leadingBlockId), organizationMedia)
    : resolveOwnerPicture(owner.owner_type, ownerMedia, organizationMedia)
  const logo = organizationMedia.find(item => item.slot === 'logo' && mediaStillUrl(item)) ?? null
  const current = ownerMedia.find(item => item.slot === 'social_card') ?? null
  const backgroundImageUrl = mediaStillUrl(source)
  if (!source || !backgroundImageUrl) return await clearSocialCard(input, 'no_source')

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
    await executeBatch(db, [{ query: "UPDATE media_placements SET status = 'active' WHERE owner_type = ? AND owner_id = ? AND slot = 'social_card' AND asset_id = ?", params: [owner.owner_type, owner.owner_id, current.asset_id] }])
    return { kind: 'reused', owner, assetId: current.asset_id, publicUrl: current.public_url, generationKey }
  }
  // Only production can store a card. Elsewhere the rows are production's copy,
  // so the card it already has stays exactly as it is and the result says why.
  if (!cloudflareImagesConfigured(env)) return { kind: 'skipped', owner, reason: 'images_unavailable' }
  await executeBatch(db, [{ query: "UPDATE media_placements SET status = 'pending' WHERE owner_type = ? AND owner_id = ? AND slot = 'social_card'", params: [owner.owner_type, owner.owner_id] }])

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

  // The card this replaces is not deleted here: an environment regenerating
  // a card may be running on a copy of production's rows, and the previous
  // card is then production's. The superseded card is left unplaced for
  // social-card-cleanup, which runs where the Images credentials are.
  try {
    await executeBatch(db, [
      ...buildSingleMediaPlacementQueries({
        organizationId: organization.id,
        placement: { owner_type: owner.owner_type, owner_id: owner.owner_id, slot: 'social_card' },
        media: [{ asset_id: uploaded.assetId }],
      }),
      // The replaced card's retention is counted from now, when it lost its
      // placement, not from whenever the asset was last touched.
      ...(current && current.asset_id !== uploaded.assetId
        ? [{ query: 'UPDATE media_assets SET updated_at = ? WHERE id = ? AND organization_id = ?', params: [new Date().toISOString(), current.asset_id, organization.id] }]
        : []),
    ], { operation: 'replace social card placement' })
  } catch (placementError) {
    try {
      await deleteMediaAsset(db, env, uploaded.assetId, organization.id, input.actorId ?? null)
    } catch (cleanupError) {
      throw new AggregateError([placementError, cleanupError], 'Social card placement and cleanup failed', { cause: cleanupError })
    }
    throw placementError
  }

  return { kind: 'generated', owner, assetId: uploaded.assetId, publicUrl: uploaded.publicUrl, generationKey }
}

export async function regenerateOrganizationSocialCards(input: {
  db: DbClient
  env: SocialCardEnv
  organizationId: string
  actorId?: string | null
  after?: string | null
  limit?: number
}) {
  const owners = await listSocialCardOwners(input.db, { organizationId: input.organizationId, after: input.after, limit: (input.limit ?? 1) + 1 })
  const results: SocialCardRefreshResult[] = []
  const batch = owners.slice(0, input.limit ?? 1)
  for (const { owner_type, owner_id } of batch) {
    const owner = { owner_type, owner_id }
    try {
      results.push(await refreshSocialCard({ ...input, owner }))
    } catch (error) {
      results.push({ kind: 'failed', owner, error: errorMessage(error) })
    }
  }
  return { results, next_cursor: owners.length > batch.length ? batch.at(-1)!.cursor : null }
}
