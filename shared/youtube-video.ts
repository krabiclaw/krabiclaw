/**
 * A video a site embeds is a YouTube video, named by its id.
 *
 * Authors paste whatever address their browser shows — a watch page, a
 * youtu.be share link, a Short, an embed code's src — so the id is the one
 * value every surface agrees on. The embed, the thumbnail and the watch page
 * are derived from it rather than stored, which is what lets a page's
 * structured data name a real thumbnail without the block holding a copy.
 */
const VIDEO_ID = /^[\w-]{11}$/
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'])

export function youTubeVideoId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const segments = url.pathname.split('/').filter(Boolean)
  const candidate = url.hostname === 'youtu.be'
    ? segments[0]
    : YOUTUBE_HOSTS.has(url.hostname)
      ? (segments[0] === 'watch' ? url.searchParams.get('v') : ['embed', 'shorts', 'live'].includes(segments[0] ?? '') ? segments[1] : null)
      : null
  return candidate && VIDEO_ID.test(candidate) ? candidate : null
}

export const youTubeEmbedUrl = (id: string) => `https://www.youtube-nocookie.com/embed/${id}`
export const youTubeWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`
export const youTubeThumbnailUrl = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i
const DATE_TIME_NO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/i

/**
 * An ISO 8601 date-time string with explicit timezone (e.g. YYYY-MM-DDTHH:mm:ssZ), or null.
 *
 * Google's VideoObject schema requires `uploadDate` in ISO 8601 format with an
 * explicit timezone offset. A bare date (YYYY-MM-DD) or a timestamp lacking a
 * timezone causes Search Console to flag "missing a timezone" and "Invalid datetime value".
 */
export function videoUploadDate(value: unknown): string | null {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime()) ? value.toISOString() : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  if (DATE_ONLY.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === trimmed
      ? `${trimmed}T00:00:00Z`
      : null
  }

  if (DATE_TIME_WITH_TZ.test(trimmed)) {
    const datePart = trimmed.slice(0, 10)
    const calendarCheck = new Date(`${datePart}T00:00:00Z`)
    if (Number.isNaN(calendarCheck.getTime()) || calendarCheck.toISOString().slice(0, 10) !== datePart) return null
    const parsed = new Date(trimmed)
    return !Number.isNaN(parsed.getTime()) ? trimmed : null
  }

  if (DATE_TIME_NO_TZ.test(trimmed)) {
    const datePart = trimmed.slice(0, 10)
    const calendarCheck = new Date(`${datePart}T00:00:00Z`)
    if (Number.isNaN(calendarCheck.getTime()) || calendarCheck.toISOString().slice(0, 10) !== datePart) return null
    const parsed = new Date(`${trimmed}Z`)
    return !Number.isNaN(parsed.getTime()) ? `${trimmed}Z` : null
  }

  return null
}

export interface VideoSchemaInput {
  /** A YouTube address, or the file of a video the site uploaded. */
  url: unknown
  name: unknown
  description?: unknown
  uploadDate: unknown
  /** An uploaded video's poster; a YouTube video's thumbnail comes from its id. */
  thumbnailUrl?: unknown
}

/**
 * A schema.org VideoObject, or null when the video lacks what Google requires
 * of one — a name, a thumbnail and an upload date. An incomplete object is an
 * error in Search Console, not a smaller result, so none is emitted.
 */
export function videoObjectSchema(input: VideoSchemaInput, id: string): Record<string, unknown> | null {
  const videoId = youTubeVideoId(input.url)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const uploadDate = videoUploadDate(input.uploadDate)
  const file = !videoId && typeof input.url === 'string' && /^https:\/\//.test(input.url) ? input.url : null
  const poster = typeof input.thumbnailUrl === 'string' && /^https:\/\//.test(input.thumbnailUrl) ? input.thumbnailUrl : null
  if (!name || !uploadDate || !(videoId || (file && poster))) return null
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  return {
    '@type': 'VideoObject',
    '@id': id,
    name,
    ...(description ? { description } : {}),
    uploadDate,
    ...(videoId
      ? { thumbnailUrl: youTubeThumbnailUrl(videoId), embedUrl: youTubeEmbedUrl(videoId), url: youTubeWatchUrl(videoId) }
      : { thumbnailUrl: poster, contentUrl: file }),
  }
}

/** The video a block shows, in the one shape every reader of it uses, or null for a block that shows none. */
export function blockVideo(block: { type: string; data: Record<string, unknown> }): VideoSchemaInput | null {
  if (block.type === 'video') return { url: block.data.url, name: block.data.title, description: block.data.caption, uploadDate: block.data.upload_date }
  if (block.type === 'video_feature') return { url: block.data.video_url, name: block.data.video_title || block.data.title, description: block.data.description, uploadDate: block.data.upload_date }
  return null
}

/** The page's videos as VideoObjects, numbered in page order. */
export function videoObjectNodes(blocks: ReadonlyArray<{ type: string; data: Record<string, unknown> }>, pageUrl: string) {
  return blocks
    .map(blockVideo)
    .filter((video): video is VideoSchemaInput => video !== null)
    .map((video, index) => videoObjectSchema(video, `${pageUrl}#video-${index + 1}`))
    .filter((node): node is Record<string, unknown> => node !== null)
}
