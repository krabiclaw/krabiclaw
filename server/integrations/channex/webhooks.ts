import { channexList, channexRequest, type ChannexEnv } from './client'
import { ChannexDataError, object, resource, string, type Resource } from './data'
import { CHANNEX_WEBHOOK_CALLER } from '~/server/utils/internal-secret'
import { BLAWBY_FREE_SITE_HOST, LEGACY_FREE_SITE_HOST, LEGACY_STAGING_PLATFORM_HOST, STAGING_PLATFORM_HOST } from '~/server/utils/tenant-hosts'

/**
 * Blawby's webhook in a Channex account (docs.channex.io webhook-collection):
 * Channex POSTs these events to /api/integrations/channex/webhook with the
 * environment's CHANNEX_WEBHOOK_SECRET in x-channex-webhook-secret, and with
 * send_data so a booking event names its revision. A webhook is global (every
 * property in the account) or belongs to one property; for the same property
 * Channex delivers only to the property's own.
 */

/** The events the webhook handler takes; every other event is answered `ignored`. */
export const CHANNEX_WEBHOOK_EVENTS = ['booking', 'non_acked_booking', 'message', 'message_thread_booking_assigned', 'inquiry', 'alteration_request'] as const

export interface WebhookTarget {
  /** The environment's origin; the callback is its Channex webhook route. */
  origin: string
  /** The value Channex must send in x-channex-webhook-secret. */
  secret: string
  /** One property's webhook, or null for the account's global one. */
  propertyId: string | null
}

export type WebhookResult = { action: 'unchanged' | 'created' | 'updated' | 'would_create' | 'would_update'; id: string | null; differences: string[] }

function desired(target: WebhookTarget) {
  return {
    callback_url: `${target.origin.replace(/\/$/, '')}/api/integrations/channex/webhook`,
    event_mask: CHANNEX_WEBHOOK_EVENTS.join(';'),
    property_id: target.propertyId,
    is_global: target.propertyId === null,
    headers: { [CHANNEX_WEBHOOK_CALLER.header]: target.secret },
    request_params: {},
    is_active: true,
    send_data: true,
  }
}

function propertyOf(webhook: Resource): string | null {
  const property = webhook.relationships?.property
  return property === undefined ? null : string(object(object(property, 'property').data, 'property.data').id, 'webhook property id')
}

/** What differs between a webhook Channex has and the one Blawby needs, by field; the secret is never echoed. */
function differences(webhook: Resource, want: ReturnType<typeof desired>): string[] {
  const has = webhook.attributes
  const found: string[] = []
  if (has.callback_url !== want.callback_url) found.push('callback_url uses the legacy Blawby platform host')
  const events = typeof has.event_mask === 'string' ? has.event_mask.split(';').filter(Boolean).sort() : null
  if (JSON.stringify(events) !== JSON.stringify([...CHANNEX_WEBHOOK_EVENTS].sort())) found.push(`event_mask is ${JSON.stringify(has.event_mask)}, needs ${JSON.stringify(want.event_mask)}`)
  const headers = has.headers === null ? {} : object(has.headers, 'webhook.headers')
  if (headers[CHANNEX_WEBHOOK_CALLER.header] !== want.headers[CHANNEX_WEBHOOK_CALLER.header]) found.push(`${CHANNEX_WEBHOOK_CALLER.header} does not match CHANNEX_WEBHOOK_SECRET`)
  const extra = Object.keys(headers).filter(name => name !== CHANNEX_WEBHOOK_CALLER.header)
  if (extra.length) found.push(`sends other headers: ${extra.join(', ')}`)
  if (has.request_params !== null && Object.keys(object(has.request_params, 'webhook.request_params')).length) found.push(`adds request_params ${JSON.stringify(has.request_params)}`)
  if (has.is_active !== true) found.push('is not active')
  if (has.send_data !== true) found.push('does not send event data')
  return found
}

/**
 * Reconcile one property or global webhook, including a callback on the
 * previous platform host. Applying a hostname change updates the existing
 * webhook ID. Two candidates in the same scope are refused.
 */
export async function ensureChannexWebhook(env: ChannexEnv, target: WebhookTarget, apply: boolean): Promise<WebhookResult> {
  const want = desired(target)
  const callbacks = new Set([want.callback_url])
  const oldCallback = new URL(want.callback_url)
  if (oldCallback.protocol === 'https:' && !oldCallback.port) {
    if (oldCallback.hostname === BLAWBY_FREE_SITE_HOST) {
      oldCallback.hostname = LEGACY_FREE_SITE_HOST
      callbacks.add(oldCallback.href)
    } else if (oldCallback.hostname === STAGING_PLATFORM_HOST) {
      oldCallback.hostname = LEGACY_STAGING_PLATFORM_HOST
      callbacks.add(oldCallback.href)
    }
  }
  const find = async () => {
    const matches = (await channexList(env, '/webhooks', 'webhook'))
      .filter(webhook => typeof webhook.attributes.callback_url === 'string'
        && callbacks.has(webhook.attributes.callback_url)
        && propertyOf(webhook) === target.propertyId
        && (webhook.attributes.is_global === true) === want.is_global)
    if (matches.length > 1) throw new ChannexDataError(`Channex has ${matches.length} webhooks for ${want.callback_url} (${target.propertyId ?? 'global'}): ${matches.map(webhook => webhook.id).join(', ')}. Delete all but one in Channex first.`)
    return matches[0]
  }
  /** A write is done when Channex's own list shows the webhook Blawby needs. */
  const confirm = async (id: string) => {
    const written = await find()
    const left = written ? differences(written, want) : ['no webhook']
    if (written?.id !== id || left.length) throw new ChannexDataError(`Channex accepted webhook ${id} but lists ${written?.id ?? 'none'} for ${want.callback_url}: ${left.join('; ')}`)
  }
  const existing = await find()
  if (!existing) {
    if (!apply) return { action: 'would_create', id: null, differences: ['no webhook'] }
    const created = resource((await channexRequest(env, '/webhooks', 'POST', { webhook: want })).data, 'webhook')
    await confirm(created.id)
    return { action: 'created', id: created.id, differences: ['no webhook'] }
  }
  const found = differences(existing, want)
  if (!found.length) return { action: 'unchanged', id: existing.id, differences: [] }
  if (!apply) return { action: 'would_update', id: existing.id, differences: found }
  await channexRequest(env, `/webhooks/${encodeURIComponent(existing.id)}`, 'PUT', { webhook: want })
  await confirm(existing.id)
  return { action: 'updated', id: existing.id, differences: found }
}
