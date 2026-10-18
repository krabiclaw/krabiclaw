/** The channel's confirmed outcome, or an explicit reason the saved nights need review. */
export type ChannelPush = { state: 'pushed'; detail: null } | { state: 'needs_review'; detail: string }
export type SuccessfulChannelPush = Extract<ChannelPush, { state: 'pushed' }>

export function isChannelPush(value: unknown): value is ChannelPush | null {
  if (value === null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  if (!('state' in value) || !('detail' in value)) return false
  return value.state === 'pushed' ? value.detail === null
    : value.state === 'needs_review' && typeof value.detail === 'string' && Boolean(value.detail.trim())
}

/** Mutation success never carries a failed or uncertain channel delivery. */
export function isSuccessfulChannelPush(value: unknown): value is SuccessfulChannelPush | null {
  return isChannelPush(value) && (value === null || value.state === 'pushed')
}

export const CHANNEL_PUSH_SCHEMA = {
  type: ['object', 'null'],
  anyOf: [
    { type: 'null' },
    { type: 'object', properties: { state: { const: 'pushed' }, detail: { type: 'null' } }, required: ['state', 'detail'] },
  ],
} as const
