/**
 * The channel's outcome for saved nights: confirmed; pending, queued with the
 * reason it has not gone yet (a rate limit or an unconfirmed attempt it will
 * retry); or an explicit reason the nights need review.
 */
export type ChannelPush = { state: 'pushed'; detail: null } | { state: 'pending'; detail: string } | { state: 'needs_review'; detail: string }
export type SuccessfulChannelPush = Exclude<ChannelPush, { state: 'needs_review' }>

export function isChannelPush(value: unknown): value is ChannelPush | null {
  if (value === null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  if (!('state' in value) || !('detail' in value)) return false
  return value.state === 'pushed' ? value.detail === null
    : (value.state === 'pending' || value.state === 'needs_review') && typeof value.detail === 'string' && Boolean(value.detail.trim())
}

/** Mutation success never carries a refused channel delivery; a queued one is still on its way. */
export function isSuccessfulChannelPush(value: unknown): value is SuccessfulChannelPush | null {
  return isChannelPush(value) && (value === null || value.state !== 'needs_review')
}

export const CHANNEL_PUSH_SCHEMA = {
  type: ['object', 'null'],
  anyOf: [
    { type: 'null' },
    { type: 'object', properties: { state: { const: 'pushed' }, detail: { type: 'null' } }, required: ['state', 'detail'] },
    { type: 'object', properties: { state: { const: 'pending' }, detail: { type: 'string', minLength: 1 } }, required: ['state', 'detail'] },
  ],
} as const
