/**
 * The short-post authoring contract, shared by MCP, the dashboard and the
 * domain: optional title, optional plain-text body (the caption, newlines kept),
 * ordered image/video media, an optional location, an optional call to action
 * the tenant wrote, and whether the post is listed.
 *
 * There is no topic discriminator. Event dates, offers and coupon terms are the
 * post's own words; bookable occurrences belong to the catalog.
 */
export class PostValidationError extends Error { statusCode = 400 }

export const POST_TITLE_MAX = 200
export const POST_BODY_MAX = 5000
export const POST_CALL_TO_ACTION_LABEL_MAX = 60

const absent = { type: 'null' } as const

export const postCallToActionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'A button the author wrote: its label and an http(s) or tel: destination. Sent to Facebook, Instagram and Discord as a separate "label: url" line under the caption; Instagram shows it as text, not a button.',
  properties: {
    label: { type: 'string', minLength: 1, maxLength: POST_CALL_TO_ACTION_LABEL_MAX },
    url: { type: 'string', description: 'https://…, http://… or tel:+…' },
  },
  required: ['label', 'url'],
} as const

export const postMediaJsonSchema = {
  type: 'array',
  description: 'Ordered media: at most one cover, then gallery items in order. Each asset appears once.',
  items: {
    type: 'object', additionalProperties: false,
    properties: { asset_id: { type: 'string', minLength: 1 }, slot: { enum: ['cover', 'gallery'] } },
    required: ['asset_id', 'slot'],
  },
} as const

export const postMutationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { anyOf: [{ type: 'string', maxLength: POST_TITLE_MAX }, absent], description: 'Optional headline. Never invented when absent.' },
    body: { anyOf: [{ type: 'string', maxLength: POST_BODY_MAX }, absent], description: 'The caption, plain text; newlines are kept.' },
    slug: { anyOf: [{ type: 'string' }, absent], description: 'Optional route segment for /posts/<slug>. Allocated from the title or body when omitted, and fixed when the post is created.' },
    location_id: { anyOf: [{ type: 'string', minLength: 1 }, absent], description: 'Scope the post to one of this organization\'s locations; omit for organization-wide.' },
    visibility: { enum: ['listed', 'unlisted'], description: 'listed shows the post in feeds; unlisted keeps it reachable by its URL only. Neither makes a draft public.' },
    call_to_action: { anyOf: [postCallToActionJsonSchema, absent] },
    media: postMediaJsonSchema,
  },
} as const

export interface PostCallToAction { label: string; url: string }
export interface PostMediaRef { asset_id: string; slot: 'cover' | 'gallery' }

export interface PostMutation {
  title?: string | null
  body?: string | null
  slug?: string | null
  location_id?: string | null
  visibility?: 'listed' | 'unlisted'
  call_to_action?: PostCallToAction | null
  media?: PostMediaRef[]
}

function fail(message: string): never {
  throw new PostValidationError(message)
}

const nullableText = (value: unknown, field: string, max: number): string | null => {
  if (value === null) return null
  if (typeof value !== 'string') fail(`${field} must be a string or null`)
  if (value.length > max) fail(`${field} is ${value.length} characters; the limit is ${max}`)
  return value
}

/** A destination a visitor can follow: http(s) on the public internet, or a phone number. */
export function parseCallToActionUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail('call_to_action.url is required')
  const url = value.trim()
  if (/^tel:/i.test(url)) {
    const number = url.slice(4).replace(/[\s().-]/g, '')
    if (!/^\+?\d{4,15}$/.test(number)) fail('call_to_action.url tel: must be a phone number')
    return `tel:${number}`
  }
  let parsed: URL
  try { parsed = new URL(url) } catch { fail('call_to_action.url must be an absolute https, http or tel: URL') }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') fail('call_to_action.url must use https, http or tel:')
  if (!parsed.hostname.includes('.')) fail('call_to_action.url must name a public host')
  return parsed.toString()
}

export function parseCallToAction(value: unknown): PostCallToAction | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('call_to_action must be an object with label and url, or null')
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find(key => key !== 'label' && key !== 'url')
  if (unknown) fail(`call_to_action: unknown field ${unknown}`)
  if (typeof record.label !== 'string' || !record.label.trim()) fail('call_to_action.label is required')
  const label = record.label.trim()
  if (label.length > POST_CALL_TO_ACTION_LABEL_MAX) fail(`call_to_action.label is ${label.length} characters; the limit is ${POST_CALL_TO_ACTION_LABEL_MAX}`)
  return { label, url: parseCallToActionUrl(record.url) }
}

/**
 * The caller's fields, validated. Only fields present are returned, so an
 * update changes what it names and nothing else.
 */
export function parsePostInput(input: unknown, operation: 'create' | 'update'): PostMutation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('post must be an object')
  const record = input as Record<string, unknown>
  const allowed = Object.keys(postMutationJsonSchema.properties).filter(key => operation === 'create' || key !== 'media')
  const unknown = Object.keys(record).find(key => record[key] !== undefined && !allowed.includes(key))
  if (unknown) fail(unknown === 'media' ? 'Change a post\'s media through its media placements' : `post: unknown field ${unknown}`)
  const result: PostMutation = {}
  if (record.title !== undefined) {
    const title = nullableText(record.title, 'title', POST_TITLE_MAX)
    result.title = title?.trim() ? title.trim() : null
  }
  if (record.body !== undefined) {
    const body = nullableText(record.body, 'body', POST_BODY_MAX)
    // Newlines are the author's; only the ends are trimmed.
    result.body = body?.trim() ? body.replace(/^\s+|\s+$/g, '') : null
  }
  if (record.slug !== undefined) result.slug = nullableText(record.slug, 'slug', 200)?.trim() || null
  if (record.location_id !== undefined) {
    if (record.location_id !== null && (typeof record.location_id !== 'string' || !record.location_id.trim())) fail('location_id must be a location id or null')
    result.location_id = record.location_id as string | null
  }
  if (record.visibility !== undefined) {
    if (record.visibility !== 'listed' && record.visibility !== 'unlisted') fail('visibility must be listed or unlisted')
    result.visibility = record.visibility
  }
  if (record.call_to_action !== undefined) result.call_to_action = parseCallToAction(record.call_to_action)
  if (record.media !== undefined) {
    if (!Array.isArray(record.media)) fail('media must be an array')
    const seen = new Set<string>()
    result.media = record.media.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`media[${index}] must be an object`)
      const entry = item as Record<string, unknown>
      if (typeof entry.asset_id !== 'string' || !entry.asset_id.trim()) fail(`media[${index}].asset_id is required`)
      if (entry.slot !== 'cover' && entry.slot !== 'gallery') fail(`media[${index}].slot must be cover or gallery`)
      if (seen.has(entry.asset_id)) fail(`media[${index}]: asset ${entry.asset_id} appears more than once`)
      seen.add(entry.asset_id)
      return { asset_id: entry.asset_id, slot: entry.slot }
    })
    if (result.media.filter(item => item.slot === 'cover').length > 1) fail('media accepts at most one cover asset')
  }
  return result
}

/** The line a provider caption carries for the author's call to action. */
export function callToActionLine(action: PostCallToAction | null): string | null {
  return action ? `${action.label}: ${action.url}` : null
}

/**
 * What Facebook, Instagram and Discord are sent as the post's text: the author's body,
 * then their call to action on its own line. Nothing is paraphrased, and
 * nothing is added when both are absent.
 */
export function providerCaption(body: string | null, action: PostCallToAction | null): string {
  return [body?.trim() ? body : null, callToActionLine(action)].filter(Boolean).join('\n\n')
}
