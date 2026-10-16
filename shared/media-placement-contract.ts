export const MEDIA_PLACEMENT_SLOTS = {
  // `logo_dark` is the optional logo for dark grounds; a site without one shows `logo`.
  organization: ['logo', 'logo_dark', 'favicon', 'social_share', 'social_card', 'compliance_document', 'announcement'],
  business_location: ['hero', 'gallery', 'social_card'],
  product: ['image', 'gallery', 'social_card'],
  // A menu section's own picture: the intro over its dishes on the site and its tile in Catalog.
  collection: ['image'],
  content_document: ['cover', 'gallery', 'social_card'],
  content_block: [
    'media', 'gallery', 'background', 'featured', 'decoration',
    'parallax_sky', 'parallax_sky_xxs', 'parallax_sky_xs', 'parallax_sky_sm', 'parallax_sky_md', 'parallax_sky_lg',
    'parallax_clouds', 'parallax_clouds_xxs', 'parallax_clouds_xs', 'parallax_clouds_sm', 'parallax_clouds_md', 'parallax_clouds_lg',
    'parallax_mountains', 'parallax_mountains_xxs', 'parallax_mountains_xs', 'parallax_mountains_sm', 'parallax_mountains_md', 'parallax_mountains_lg',
    'parallax_far_trees', 'parallax_far_trees_xxs', 'parallax_far_trees_xs', 'parallax_far_trees_sm', 'parallax_far_trees_md', 'parallax_far_trees_lg',
    'parallax_building_trees', 'parallax_building_trees_xxs', 'parallax_building_trees_xs', 'parallax_building_trees_sm', 'parallax_building_trees_md', 'parallax_building_trees_lg',
    'parallax_foreground', 'parallax_foreground_xxs', 'parallax_foreground_xs', 'parallax_foreground_sm', 'parallax_foreground_md', 'parallax_foreground_lg',
  ],
  review: ['portrait', 'gallery', 'social_card'],
  review_request: ['gallery'],
  // The photos a message in a guest thread carries, in the order they were sent.
  activity_entry: ['attachments'],
  // The photos a message in a team conversation carries, in the order they were sent.
  team_message: ['attachments'],
} as const

export type MediaPlacementOwnerType = keyof typeof MEDIA_PLACEMENT_SLOTS

export const EDITABLE_MEDIA_PLACEMENT_OWNERS = [
  'organization', 'business_location', 'product', 'collection', 'content_document',
  'content_block', 'review_request',
] as const satisfies readonly MediaPlacementOwnerType[]

export type EditableMediaPlacementOwnerType = typeof EDITABLE_MEDIA_PLACEMENT_OWNERS[number]

export function isMediaPlacementOwnerType(value: string): value is MediaPlacementOwnerType {
  return Object.hasOwn(MEDIA_PLACEMENT_SLOTS, value)
}

export function isEditableMediaPlacementOwnerType(value: string): value is EditableMediaPlacementOwnerType {
  return EDITABLE_MEDIA_PLACEMENT_OWNERS.some(ownerType => ownerType === value)
}

export const INDEXED_MEDIA_PLACEMENT_SLOTS = [
  { ownerType: 'content_block', runtime: /^items\.\d+\.image$/, sqlGlob: 'items.[0-9]*.image' },
  // A showcase statement's three pictures.
  { ownerType: 'content_block', runtime: /^items\.\d+\.left$/, sqlGlob: 'items.[0-9]*.left' },
  { ownerType: 'content_block', runtime: /^items\.\d+\.center$/, sqlGlob: 'items.[0-9]*.center' },
  { ownerType: 'content_block', runtime: /^items\.\d+\.right$/, sqlGlob: 'items.[0-9]*.right' },
  { ownerType: 'content_block', runtime: /^images\.\d+$/, sqlGlob: 'images.[0-9]*' },
  { ownerType: 'content_block', runtime: /^features\.\d+\.icon$/, sqlGlob: 'features.[0-9]*.icon' },
  { ownerType: 'content_block', runtime: /^people\.\d+\.image$/, sqlGlob: 'people.[0-9]*.image' },
] as const satisfies ReadonlyArray<{ ownerType: MediaPlacementOwnerType; runtime: RegExp; sqlGlob: string }>

const ORDERED_PLACEMENTS = new Set([
  'business_location:gallery', 'product:gallery', 'content_document:gallery',
  'content_block:gallery', 'review:gallery', 'review_request:gallery',
  'organization:compliance_document', 'activity_entry:attachments', 'team_message:attachments',
])

/**
 * What a picture or video shows. One list, because it was previously written out
 * in four places — the column's `$type`, the media manager's own union, and the
 * MCP tool's JSON schema twice — and the column itself had no constraint at all,
 * so any string a writer invented was stored. `media_assets_category_check`
 * holds the same set in SQL, which is the database's own copy of it.
 *
 * Which of these a business is *offered* is a separate question, answered per
 * vertical in `utils/product-presentation.ts`: a law firm is not shown Food.
 */
export const MEDIA_CATEGORIES = [
  'exterior', 'interior', 'food', 'menu', 'team', 'other', 'logo', 'blog',
] as const

export type MediaCategory = typeof MEDIA_CATEGORIES[number]

/**
 * The subjects a writer may set. `logo` and `blog` are assigned by the surfaces
 * that own those pictures, never chosen as a subject.
 */
export const WRITABLE_MEDIA_CATEGORIES = [
  'exterior', 'interior', 'food', 'menu', 'team', 'other',
] as const satisfies readonly MediaCategory[]

export function isMediaCategory(value: unknown): value is MediaCategory {
  return typeof value === 'string' && (MEDIA_CATEGORIES as readonly string[]).includes(value)
}

export const MAX_ORDERED_MEDIA_ASSETS = 50

export function isSupportedMediaPlacement(placement: { owner_type: string; slot: string }) {
  const slots = isMediaPlacementOwnerType(placement.owner_type)
    ? MEDIA_PLACEMENT_SLOTS[placement.owner_type]
    : undefined
  return slots?.some(slot => slot === placement.slot) === true
    || INDEXED_MEDIA_PLACEMENT_SLOTS.some(pattern => pattern.ownerType === placement.owner_type && pattern.runtime.test(placement.slot))
}

export function isEditableMediaPlacement(placement: { owner_type: string; slot: string }) {
  return placement.slot !== 'social_card'
    && isEditableMediaPlacementOwnerType(placement.owner_type)
    && isSupportedMediaPlacement(placement)
}

export function isSingleMediaPlacement(placement: { owner_type: string; slot: string }) {
  return isSupportedMediaPlacement(placement) && !ORDERED_PLACEMENTS.has(`${placement.owner_type}:${placement.slot}`)
}

/**
 * What a media record says about itself. `media_assets.kind` is the authority:
 * a video carries its file in `public_url` and a required poster in
 * `thumbnail_url`, an image carries itself in `public_url`.
 */
export interface MediaPresentation {
  kind?: string | null
  public_url?: string | null
  thumbnail_url?: string | null
}

/**
 * The still picture that stands for this media — the image itself, or a
 * video's poster. Never a video file: handing an `.mp4` to an `<img>` is the
 * defect this replaces, and it reached guests in a booking email.
 *
 * A record whose `kind` is missing or unrecognised has no still. Guessing one
 * from the URL's extension, or assuming an absent kind means "image", is how
 * the disagreement stayed hidden.
 */
export function mediaStillUrl(media: MediaPresentation | null | undefined): string | null {
  if (!media) return null
  if (media.kind === 'video') return media.thumbnail_url || null
  if (media.kind === 'image') return media.public_url || null
  return null
}

/** The file a player loads. Only a video has one. */
export function mediaPlaybackUrl(media: MediaPresentation | null | undefined): string | null {
  return media?.kind === 'video' ? media.public_url || null : null
}

/**
 * Where an owner keeps its own picture: one slot per owner type. An
 * organization has none of its own — its picture is its `social_share`.
 */
const OWNER_PICTURE_SLOT: Partial<Record<MediaPlacementOwnerType, string>> = {
  business_location: 'hero',
  product: 'image',
  content_document: 'cover',
  content_block: 'media',
  review: 'portrait',
}

export interface PlacedMedia extends MediaPresentation {
  slot?: string
}

/**
 * The picture for this owner. The social card generator, og:image, the
 * notification hero and the dashboard's agenda and booking details all ask
 * here, and nothing else decides it:
 *
 * 1. the owner's first image in its own slot, skipping videos;
 * 2. otherwise the organization's `social_share`, the image its owner chose
 *    for exactly this;
 * 3. otherwise a video's poster frame, when the owner's slot holds one — a
 *    frame is a poor picture, so it stands in only when nothing was chosen;
 * 4. otherwise nothing.
 *
 * `ownerMedia` and `organizationMedia` are placements in sort order; slots
 * other than the ones named above are ignored, so a caller may pass all of an
 * owner's placements. The result is one of the given items, so a caller that
 * needs its asset id or its still reads them off it with `mediaStillUrl`.
 */
export function resolveOwnerPicture<T extends PlacedMedia>(
  ownerType: MediaPlacementOwnerType,
  ownerMedia: readonly T[],
  organizationMedia: readonly T[],
): T | null {
  const slot = OWNER_PICTURE_SLOT[ownerType]
  const own = slot ? ownerMedia.filter(item => item.slot === slot && mediaStillUrl(item)) : []
  return own.find(item => item.kind === 'image')
    ?? organizationMedia.find(item => item.slot === 'social_share' && mediaStillUrl(item))
    ?? own[0]
    ?? null
}

/** The organization logo slots, whose placements carry a presentation. */
export const LOGO_SLOTS = ['logo', 'logo_dark'] as const
export type LogoSlot = typeof LOGO_SLOTS[number]

export const LOGO_SHAPES = ['original', 'square', 'circle'] as const
export type LogoShape = typeof LOGO_SHAPES[number]

/**
 * How a logo placement presents its asset: the whole image (`original`), or a
 * square or circle crop centred on `focus` (0-1 from the left and top). It is
 * the placement's own, so the shared asset is never altered.
 */
export interface LogoPresentation { shape: LogoShape; focus: { x: number; y: number } }

export const ORIGINAL_LOGO_PRESENTATION: LogoPresentation = { shape: 'original', focus: { x: 0.5, y: 0.5 } }

export function parseLogoPresentation(value: unknown): LogoPresentation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('presentation must be an object with shape and focus')
  const { shape, focus } = value as { shape?: unknown; focus?: unknown }
  if (!LOGO_SHAPES.includes(shape as LogoShape)) throw new Error(`presentation.shape must be one of: ${LOGO_SHAPES.join(', ')}`)
  const point = focus as { x?: unknown; y?: unknown } | undefined
  const inRange = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  if (!point || !inRange(point.x) || !inRange(point.y)) throw new Error('presentation.focus must have x and y between 0 and 1')
  return { shape: shape as LogoShape, focus: { x: point.x, y: point.y } }
}

/** A logo as a public page renders it. */
export interface SiteLogo { slot: LogoSlot; url: string; presentation: LogoPresentation }
