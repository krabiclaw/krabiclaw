/**
 * An article's cover is its leading image block: the `image` block at position 0
 * of the document, whose asset sits in the block's own `media` placement.
 *
 * There is no second place to put a post's photo. The featured placement that
 * used to live on the document itself was the same picture under a second name,
 * and a post that held the asset in both printed it twice. Readers that need
 * the cover — hero, list cards, share metadata, social cards — all derive it
 * from the same leading block through these two fragments.
 */

export interface CoverMedia {
  asset_id: string
  public_url: string | null
  thumbnail_url: string | null
  kind: string | null
  alt_text: string | null
  width: number | null
  height: number | null
}

/** Columns for `attachCoverMedia`; pair with `coverJoinSql` on the same document alias. */
export const COVER_SELECT =
  `cover_placement.asset_id AS cover_asset_id, cover_asset.public_url AS cover_public_url, cover_asset.thumbnail_url AS cover_thumbnail_url,
      cover_asset.kind AS cover_kind, cover_asset.alt_text AS cover_alt_text, cover_asset.width AS cover_width, cover_asset.height AS cover_height`

/**
 * Joins the leading image block and its active asset for the document aliased
 * `document`. One block, by construction: the join is on the block's id, chosen
 * by a subquery, so a document whose rows disagree about position 0 still
 * yields one row rather than one per block.
 */
export function coverJoinSql(document: string) {
  return `LEFT JOIN content_blocks cover_block ON cover_block.id = (
      SELECT lead.id FROM content_blocks lead
       WHERE lead.document_id = ${document}.id AND lead.parent_block_id IS NULL AND lead.position = 0 AND lead.type = 'image'
       ORDER BY lead.created_at, lead.id LIMIT 1)
    LEFT JOIN media_placements cover_placement ON cover_placement.owner_type = 'content_block' AND cover_placement.owner_id = cover_block.id AND cover_placement.slot = 'media' AND cover_placement.sort_order = 0 AND cover_placement.status = 'active'
    LEFT JOIN media_assets cover_asset ON cover_asset.id = cover_placement.asset_id AND cover_asset.status = 'active'`
}

type CoverColumns = {
  cover_asset_id?: unknown
  cover_public_url?: unknown
  cover_thumbnail_url?: unknown
  cover_kind?: unknown
  cover_alt_text?: unknown
  cover_width?: unknown
  cover_height?: unknown
}

const text = (value: unknown) => typeof value === 'string' ? value : null
const size = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Lifts the `cover_*` columns selected by `COVER_SELECT` into one `cover` value, or `null` when the post has no leading image. */
export function attachCoverMedia<T extends CoverColumns>(record: T): T & { cover: CoverMedia | null } {
  const {
    cover_asset_id: assetId, cover_public_url: publicUrl, cover_thumbnail_url: thumbnailUrl,
    cover_kind: kind, cover_alt_text: altText, cover_width: width, cover_height: height,
    ...rest
  } = record
  return {
    ...(rest as T),
    cover: typeof assetId === 'string' && assetId
      ? { asset_id: assetId, public_url: text(publicUrl), thumbnail_url: text(thumbnailUrl), kind: text(kind), alt_text: text(altText), width: size(width), height: size(height) }
      : null,
  }
}
