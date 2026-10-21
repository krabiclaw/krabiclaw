
import { robotsDirective, type RobotsVisibility } from '~/shared/robots-directive'
import { mediaStillUrl, resolveOwnerPicture, type MediaPlacementOwnerType } from '~/shared/media-placement-contract'

/**
 * Shared global OG/social SEO contract (#259).
 *
 * This is the single normalized payload every page — KrabiClaw's own and every
 * customer site's — feeds into `composeSocialMetadata()` to get a
 * complete, guaranteed set of `<title>`, meta description, canonical link, Open Graph,
 * and Twitter tags. Routes/composables provide data to this contract; they must not
 * assemble independent tag sets or image URLs themselves.
 *
 * `useSocialMetadata` is the only adapter over this contract and resolves both
 * platform and tenant origins before applying the normalized tags.
 */

/** Registered render templates. Keep in sync with server/utils/og-image/renderers/index.ts. */
export type SocialTemplate = 'platform' | 'tenant'

export type SocialPageType = 'website' | 'article' | 'profile'

/** Matches useSeoMeta's ogImageType/twitterImage MIME union. */
export type SocialImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif'

export interface SocialImageSource {
  url: string
  kind?: 'image' | 'video'
  thumbnailUrl?: string | null
  width?: number
  height?: number
  type?: SocialImageMimeType
  alt?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSocialImageSource(value: unknown): SocialImageSource | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value) || typeof value.url !== 'string' || !value.url.trim()) {
    throw new Error('Social image source requires a URL')
  }
  if (value.kind !== undefined && value.kind !== 'image' && value.kind !== 'video') {
    throw new Error('Social image source kind must be image or video')
  }
  if (value.thumbnailUrl !== undefined && value.thumbnailUrl !== null && typeof value.thumbnailUrl !== 'string') {
    throw new Error('Social image thumbnail URL must be a string or null')
  }
  if (value.width !== undefined && (typeof value.width !== 'number' || !Number.isFinite(value.width))) {
    throw new Error('Social image width must be a finite number')
  }
  if (value.height !== undefined && (typeof value.height !== 'number' || !Number.isFinite(value.height))) {
    throw new Error('Social image height must be a finite number')
  }
  if (value.type !== undefined && value.type !== 'image/jpeg' && value.type !== 'image/png' && value.type !== 'image/gif') {
    throw new Error('Social image MIME type is invalid')
  }
  if (value.alt !== undefined && typeof value.alt !== 'string') {
    throw new Error('Social image alt text must be a string')
  }
  return {
    url: value.url,
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.thumbnailUrl === undefined ? {} : { thumbnailUrl: value.thumbnailUrl }),
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
    ...(value.type === undefined ? {} : { type: value.type }),
    ...(value.alt === undefined ? {} : { alt: value.alt }),
  }
}

export interface SocialMediaSource {
  slot?: string
  kind?: string | null
  public_url?: string | null
  thumbnail_url?: string | null
  mime_type?: string | null
  width?: number | null
  height?: number | null
}

function isSocialImageMimeType(value: string | null | undefined): value is SocialImageMimeType {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/gif'
}

function firstNonBlank(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.trim()
    if (normalized) return normalized
  }
  return null
}

export function resolveSocialImageUrl(source: SocialMediaSource | null | undefined): string | null {
  if (source?.kind === 'video' && !firstNonBlank(source.thumbnail_url)) {
    throw new Error('Video media requires a thumbnail URL')
  }
  return firstNonBlank(mediaStillUrl(source))
}

function toSocialImageSource(source: SocialMediaSource | null | undefined): SocialImageSource | null {
  const url = resolveSocialImageUrl(source)
  if (!url || !source) return null
  if (source.slot === 'social_card') return { url, width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, type: 'image/png' }
  // Any other picture states what the asset records about itself. A video's
  // still is its poster, whose size and type the video's record does not hold.
  const own = source.kind === 'image'
  return {
    url,
    width: own && source.width ? source.width : undefined,
    height: own && source.height ? source.height : undefined,
    type: own && isSocialImageMimeType(source.mime_type) ? source.mime_type : undefined,
  }
}

/**
 * A resource's og:image is its own generated `social_card`. Until one exists
 * it is the picture `resolveOwnerPicture` gives that owner — the same one the
 * card will draw — and with neither there is no image tag at all.
 */
export function resolveSocialImageFromMedia(
  ownerType: MediaPlacementOwnerType,
  ownerMedia: readonly SocialMediaSource[],
  organizationMedia: readonly SocialMediaSource[],
): SocialImageSource | null {
  return toSocialImageSource(ownerMedia.find(item => item.slot === 'social_card')
    ?? resolveOwnerPicture(ownerType, ownerMedia, organizationMedia))
}

export interface PublicSocialMedia<T extends SocialMediaSource = SocialMediaSource> {
  media: T[]
  social_image: SocialImageSource | null
}

export function publicSocialMediaFromPlacements<T extends SocialMediaSource>(
  ownerType: MediaPlacementOwnerType,
  ownerMedia: readonly T[],
  organizationMedia: readonly SocialMediaSource[],
): PublicSocialMedia<T> {
  return {
    media: ownerMedia.filter(item => item.slot !== 'social_card'),
    social_image: resolveSocialImageFromMedia(ownerType, ownerMedia, organizationMedia),
  }
}

export interface SocialBrand {
  /** og:site_name and the name rendered on generated OG image cards. */
  organizationName: string
}

export interface SocialPageMetadataInput {
  template: SocialTemplate
  pageType?: SocialPageType
  title: string
  /** Full-length description; composer truncates to platform-appropriate lengths. */
  description?: string | null
  /** Absolute or root-relative path/URL; resolved against the correct origin by the adapter. */
  canonicalUrl: string
  brand: SocialBrand
  /**
   * The page's own image. Every page states it — a page about the business
   * states the organization's — and null means no image tag at all.
   */
  socialImage: SocialImageSource | null
  author?: string | null
  /** ISO 8601 date string. Only meaningful when pageType is 'article'. */
  publishedAt?: string | null
  /**
   * What this surface is, not what a tenant chose: the directive is derived
   * from it. Unset means public, listed content. See shared/robots-directive.ts.
   */
  discoverability?: RobotsVisibility | null
}

export interface ComposedSocialTags {
  title: string
  description: string | undefined
  canonicalUrl: string
  /** The derived `<meta name="robots">` content. Always set. */
  robots: string
  ogTitle: string
  ogDescription: string | undefined
  ogType: SocialPageType
  ogUrl: string
  ogSiteName: string | undefined
  ogImage: string | undefined
  ogImageWidth: number | undefined
  ogImageHeight: number | undefined
  ogImageType: SocialImageMimeType | undefined
  ogImageAlt: string | undefined
  twitterCard: 'summary_large_image'
  twitterTitle: string
  twitterDescription: string | undefined
  twitterImage: string | undefined
  twitterImageAlt: string | undefined
  /** Only set when pageType is 'article' and the corresponding input field is present. */
  articleAuthor: string[] | undefined
  articlePublishedTime: string | undefined
}

export const OG_IMAGE_WIDTH = 1200
export const OG_IMAGE_HEIGHT = 630

const TITLE_MAX_LENGTH = 70
export const DESCRIPTION_MAX_LENGTH = 160

/** Truncate text to fit social/SERP preview limits, breaking on a word boundary. */
export function truncateForSeo(text: string | null | undefined, maxLength: number): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength - 1).replace(/\s+\S*$/, '')}…`
}

/**
 * Pure composer: turns the shared contract into the exact tag set every page must emit.
 * Does not touch Vue/Nuxt APIs — composables/useSocialMetadata.ts applies this output via
 * useHead so the same logic is testable without a component context.
 */
export function composeSocialMetadata(
  input: SocialPageMetadataInput,
  resolvedOgImage: SocialImageSource | null,
): ComposedSocialTags {
  const title = truncateForSeo(input.title, TITLE_MAX_LENGTH) || input.title
  const description = truncateForSeo(input.description, DESCRIPTION_MAX_LENGTH)
  const pageType = input.pageType || 'website'
  const alt = resolvedOgImage?.alt || (resolvedOgImage ? input.title : undefined)

  return {
    title,
    description,
    canonicalUrl: input.canonicalUrl,
    robots: robotsDirective(input.discoverability),
    ogTitle: title,
    ogDescription: description,
    ogType: pageType,
    ogUrl: input.canonicalUrl,
    ogSiteName: firstNonBlank(input.brand.organizationName) ?? undefined,
    ogImage: resolvedOgImage?.url,
    ogImageWidth: resolvedOgImage?.width,
    ogImageHeight: resolvedOgImage?.height,
    ogImageType: resolvedOgImage?.type,
    ogImageAlt: alt,
    twitterCard: 'summary_large_image',
    twitterTitle: title,
    twitterDescription: description,
    twitterImage: resolvedOgImage?.url,
    twitterImageAlt: alt,
    articleAuthor: pageType === 'article' && input.author ? [input.author] : undefined,
    articlePublishedTime: pageType === 'article' && input.publishedAt ? input.publishedAt : undefined,
  }
}


export interface SocialCardRenderPayload {
  template: SocialTemplate
  title: string
  description?: string | null
  organizationName: string
  label?: string | null
  location?: string | null
  logoUrl?: string | null
  backgroundImageUrl: string
}

/** Resolve a required page or media address against the site's canonical origin. */
export function resolveSeoUrl(value: string, origin: string) {
  const target = value.trim()
  if (!target) throw new Error('SEO URL is required')
  return new URL(target, origin).toString()
}
