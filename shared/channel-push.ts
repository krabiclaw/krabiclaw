/** The channel's confirmed outcome, or an explicit reason the saved nights need review. */
export type ChannelPush = { state: 'pushed'; detail: null } | { state: 'needs_review'; detail: string }

export function isChannelPush(value: unknown): value is ChannelPush | null {
  if (value === null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  if (!('state' in value) || !('detail' in value)) return false
  return value.state === 'pushed' ? value.detail === null
    : value.state === 'needs_review' && typeof value.detail === 'string' && Boolean(value.detail.trim())
}

export const CHANNEL_PUSH_SCHEMA = {
  type: ['object', 'null'],
  anyOf: [
    { type: 'null' },
    { type: 'object', properties: { state: { const: 'pushed' }, detail: { type: 'null' } }, required: ['state', 'detail'] },
    { type: 'object', properties: { state: { const: 'needs_review' }, detail: { type: 'string', minLength: 1 } }, required: ['state', 'detail'] },
  ],
} as const
