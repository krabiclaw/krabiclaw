// Meta Cloud API — WhatsApp Business send-only notifications.
// All messages use pre-approved templates (WhatsApp requires this for business-initiated messages).
// Phone numbers stored and sent in E.164 format (+66946230215).

import { logOnlyWhatsAppMessageId, shouldSendRealWhatsApp } from './whatsapp-delivery'
import { hasOrganizationEntitlement } from './billing'
import type { CloudflareEnv } from './auth'
import { parsePhoneOrThrow } from '~/utils/phone'

function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return '***';
  if (phone.length < 8) return phone.slice(0, 2) + '*'.repeat(phone.length - 2);
  return phone.slice(0, 3) + '*'.repeat(phone.length - 7) + phone.slice(-4);
}

const GRAPH_API_VERSION = 'v25.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

interface WhatsAppEnv {
  WHATSAPP_PHONE_NUMBER_ID?: string
  WHATSAPP_ACCESS_TOKEN?: string
  MAX_WHATSAPP_MEDIA_BYTES?: string
  WHATSAPP_DELIVERY_MODE?: string
}

const DEFAULT_MAX_WHATSAPP_MEDIA_BYTES = 20 * 1024 * 1024

interface MetaGraphErrorPayload {
  message?: string
}

interface MetaGraphMessagePayload {
  id?: string
}

interface MetaGraphResponse {
  error?: MetaGraphErrorPayload
  messages?: MetaGraphMessagePayload[]
}

interface MetaMediaResponse {
  url?: string
  mime_type?: string
  sha256?: string
  file_size?: number
  id?: string
  error?: MetaGraphErrorPayload
}

export type WhatsAppTemplate =
  | 'new_review'
  | 'new_contact_msg'
  | 'guest_thread_reply_whatsapp'
  | 'new_reservation'
  | 'reservation_cancelled'
  | 'booking_change_update'
  | 'domain_update'
  | 'otp_code'

interface TemplateHeaderComponent {
  type: 'header'
  parameters: Array<{ type: 'text'; text: string }>
}

interface TemplateBodyComponent {
  type: 'body'
  parameters: Array<{ type: 'text'; text: string }>
}

interface TemplateButtonComponent {
  type: 'button'
  sub_type: 'url'
  index: string
  parameters: Array<{ type: 'text'; text: string }>
}

type TemplateComponent = TemplateHeaderComponent | TemplateBodyComponent | TemplateButtonComponent

/**
 * Why an alert could not be built as an approved template. Either a slot's
 * required fact is absent (WHATSAPP_TEMPLATE_FACT_MISSING, naming the slot), or
 * the facts present call for a variant Meta has not approved yet
 * (WHATSAPP_TEMPLATE_NOT_APPROVED, naming that variant). Either way nothing is
 * sent and the refusal is the delivery's recorded reason.
 */
export class WhatsAppTemplateRefusal extends Error {
  readonly code: 'WHATSAPP_TEMPLATE_FACT_MISSING' | 'WHATSAPP_TEMPLATE_NOT_APPROVED'
  readonly template: string
  readonly field: string | null
  constructor(code: WhatsAppTemplateRefusal['code'], template: string, field: string | null) {
    super(code === 'WHATSAPP_TEMPLATE_FACT_MISSING' ? `${code}: ${template} requires ${field}` : `${code}: ${template}`)
    this.code = code
    this.template = template
    this.field = field
  }
}

/**
 * Each Meta template, slot by slot. Every slot is required: Meta rejects an
 * empty parameter, and a slot is never filled with text standing in for a fact
 * the event does not have.
 *
 * `optional` names the slots whose fact an event may genuinely lack. Each
 * combination of absent optional facts is its own Meta template, named
 * `<name>_no_<absent slots>`, with those slots removed; the facts present
 * choose it. A variant is refused with WHATSAPP_TEMPLATE_NOT_APPROVED until Meta has
 * approved it and it is listed in APPROVED_VARIANTS.
 *
 * A URL button is approved as a fixed "https://krabiclaw.com/dashboard/{{1}}"
 * prefix plus one variable, so `button` names the var holding the full
 * dashboard URL and the slot takes the part after `/dashboard/`. `otp_code`
 * repeats its code in the button instead.
 */
interface TemplateSpec {
  name: string
  header?: Array<[field: string, maxLen: number]>
  body: Array<[field: string, maxLen: number]>
  optional?: string[]
  button: { dashboardUrl: string } | { text: string }
}

const CONTACT_ALERT: Omit<TemplateSpec, 'name'> = {
  body: [['guest_name', 120], ['email', 120], ['subject', 40], ['message_preview', 100]],
  button: { dashboardUrl: 'reply_path' },
}

// Meta template names must match exactly what was approved in Business Manager.
const TEMPLATES: Record<WhatsAppTemplate, TemplateSpec> = {
  booking_change_update: {
    name: 'booking_change_update',
    body: [['booking_type', 120], ['guest_name', 120], ['status', 120], ['location', 120], ['date', 120], ['time', 120], ['guests', 120], ['message', 250]],
    optional: ['date', 'time'],
    button: { dashboardUrl: 'reply_path' },
  },
  new_review: { name: 'new_review', header: [['organization_name', 60]], body: [['rating', 120], ['excerpt', 300]], button: { dashboardUrl: 'reviews_url' } },
  new_contact_msg: { name: 'new_contact_msg', ...CONTACT_ALERT },
  // A guest reply is sent through the approved new_contact_msg template; a guest who wrote in without an email has none to show.
  guest_thread_reply_whatsapp: { name: 'new_contact_msg', ...CONTACT_ALERT, optional: ['email'] },
  new_reservation: {
    name: 'new_reservation',
    body: [['guest_name', 120], ['date', 40], ['time', 40], ['guests', 24], ['phone', 40], ['email', 100], ['context', 100], ['requests', 100]],
    optional: ['phone', 'context', 'requests'],
    button: { dashboardUrl: 'reply_path' },
  },
  reservation_cancelled: {
    name: 'reservation_cancelled',
    body: [['guest_name', 120], ['date', 40], ['time', 40], ['guests', 24], ['phone', 40], ['context', 100], ['requests', 100]],
    optional: ['phone', 'requests'],
    button: { dashboardUrl: 'reply_path' },
  },
  domain_update: { name: 'domain_update', header: [['domain', 60]], body: [['status', 40]], button: { dashboardUrl: 'dashboard_url' } },
  otp_code: { name: 'otp_code', body: [['code', 12]], button: { text: 'code' } },
}

/** Variants Meta has approved, by name. Add one here only once Business Manager shows it approved. */
const APPROVED_VARIANTS = new Set<string>([
  'booking_change_update_no_date',
  'booking_change_update_no_time',
  'booking_change_update_no_date_time',
  'new_contact_msg_no_email',
  'new_reservation_no_context',
  'new_reservation_no_context_requests',
  'new_reservation_no_phone',
  'new_reservation_no_requests',
  'new_reservation_no_phone_context',
  'new_reservation_no_phone_context_requests',
  'new_reservation_no_phone_requests',
  'reservation_cancelled_no_phone',
  'reservation_cancelled_no_phone_requests',
  'reservation_cancelled_no_requests',
])

export function buildWhatsAppTemplatePayload(template: WhatsAppTemplate, vars: Record<string, string>) {
  const spec = TEMPLATES[template]
  const value = (field: string) => String(vars[field] ?? '').replace(/\s+/g, ' ').trim()
  const absent = new Set((spec.optional ?? []).filter(field => !value(field)))
  const name = absent.size ? `${spec.name}_no_${[...absent].join('_')}` : spec.name
  const text = (field: string, maxLen: number) => {
    if (!value(field)) throw new WhatsAppTemplateRefusal('WHATSAPP_TEMPLATE_FACT_MISSING', name, field)
    return { type: 'text' as const, text: value(field).slice(0, maxLen) }
  }
  const marker = '/dashboard/'
  const button = (() => {
    if ('text' in spec.button) return text(spec.button.text, 12)
    const url = value(spec.button.dashboardUrl)
    const index = url.indexOf(marker)
    if (index < 0 || index + marker.length === url.length) throw new WhatsAppTemplateRefusal('WHATSAPP_TEMPLATE_FACT_MISSING', name, spec.button.dashboardUrl)
    return { type: 'text' as const, text: url.slice(index + marker.length) }
  })()
  const components: TemplateComponent[] = [
    ...(spec.header ? [{ type: 'header' as const, parameters: spec.header.map(([field, maxLen]) => text(field, maxLen)) }] : []),
    { type: 'body', parameters: spec.body.filter(([field]) => !absent.has(field)).map(([field, maxLen]) => text(field, maxLen)) },
    { type: 'button', sub_type: 'url', index: '0', parameters: [button] },
  ]
  if (absent.size && !APPROVED_VARIANTS.has(name)) throw new WhatsAppTemplateRefusal('WHATSAPP_TEMPLATE_NOT_APPROVED', name, null)
  return { name, language: { code: 'en_US' }, components }
}

export type SendWhatsAppResult =
  | { success: true; status: 'sent'; messageId: string | undefined }
  | { success: true; status: 'skipped'; reason: 'messaging_not_enabled' }
  | { success: false; status: 'failed'; error: string }

export async function sendWhatsAppNotification(
  env: CloudflareEnv & WhatsAppEnv,
  opts: {
    organizationId: string
    locationId?: string | null
    toPhone: string            // raw phone, will be normalized
    template: WhatsAppTemplate
    vars?: Record<string, string>
  }
): Promise<SendWhatsAppResult> {
  // Recheck at the provider boundary, including downgrades after recipient selection.
  if (!await hasOrganizationEntitlement(env, opts.organizationId, 'messaging')) {
    return { success: true, status: 'skipped', reason: 'messaging_not_enabled' }
  }
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = env.WHATSAPP_ACCESS_TOKEN

  const attemptId = crypto.randomUUID()
  const normalizedPhone = parsePhoneOrThrow(opts.toPhone)
  // The template is built in every delivery mode, so a missing required fact
  // or an unapproved variant fails here, recorded on the delivery as its reason.
  let templatePayload: ReturnType<typeof buildWhatsAppTemplatePayload>
  try {
    templatePayload = buildWhatsAppTemplatePayload(opts.template, opts.vars ?? {})
  } catch (error) {
    if (error instanceof WhatsAppTemplateRefusal) return { success: false, status: 'failed', error: error.message }
    throw error
  }

  if (!shouldSendRealWhatsApp(env)) {
    const messageId = logOnlyWhatsAppMessageId('notification')
    console.log('whatsapp_delivery_log_only', { attemptId, template: opts.template, to: maskPhone(normalizedPhone) })
    return { success: true, status: 'sent', messageId }
  }

  if (!phoneNumberId || !accessToken) {
    return { success: false, status: 'failed', error: 'WhatsApp env vars not configured' }
  }

  let result: SendWhatsAppResult
  try {
    const response = await fetch(
      `${GRAPH_BASE}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: normalizedPhone,
          type: 'template',
          template: templatePayload,
        }),
      }
    )

    const data: MetaGraphResponse = await response.json()

    if (!response.ok || data.error) {
      const errMsg = data.error?.message ?? `HTTP ${response.status}`
      result = { success: false, status: 'failed', error: errMsg }
    } else {
      const messageId = data.messages?.[0]?.id
      result = { success: true, status: 'sent', messageId }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Network error'
    result = { success: false, status: 'failed', error: errMsg }
  }

  return result
}

/**
 * Read the site's owner WhatsApp notification phone.
 * Returns null if not set — callers should skip sending rather than throw.
 */
/**
 * Send a WhatsApp OTP code directly via Meta API.
 * Used by Better Auth phoneNumber plugin — no DB logging needed here
 * since Better Auth's verification table tracks the code lifecycle.
 */
export async function sendWhatsAppOtp(
  env: WhatsAppEnv,
  toPhone: string,
  code: string
): Promise<void> {
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = env.WHATSAPP_ACCESS_TOKEN

  if (!shouldSendRealWhatsApp(env)) {
    console.log('whatsapp_delivery_log_only', { kind: 'otp', to: maskPhone(parsePhoneOrThrow(toPhone)) })
    return
  }

  if (!phoneNumberId || !accessToken) {
    throw new Error('WhatsApp env vars not configured')
  }

  const normalized = parsePhoneOrThrow(toPhone)
  const templatePayload = buildWhatsAppTemplatePayload('otp_code', { code })

  const response = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: normalized,
      type: 'template',
      template: templatePayload,
    }),
  })

  if (!response.ok) {
    const err: MetaGraphResponse = await response.json()
    throw new Error(err?.error?.message ?? `WhatsApp OTP send failed: HTTP ${response.status}`)
  }
}

export async function sendWhatsAppText(
  env: WhatsAppEnv,
  toPhone: string,
  body: string
): Promise<SendWhatsAppResult> {
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = env.WHATSAPP_ACCESS_TOKEN

  if (!shouldSendRealWhatsApp(env)) {
    const messageId = logOnlyWhatsAppMessageId('text')
    let normalized: string
    try {
      normalized = parsePhoneOrThrow(toPhone)
    } catch (err) {
      return { success: false, status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    console.log('whatsapp_delivery_log_only', { kind: 'text', to: maskPhone(normalized) })
    return { success: true, status: 'sent', messageId }
  }

  if (!phoneNumberId || !accessToken) {
    return { success: false, status: 'failed', error: 'WhatsApp env vars not configured' }
  }

  try {
    const normalized = parsePhoneOrThrow(toPhone)
    const response = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalized,
        type: 'text',
        text: { preview_url: true, body },
      }),
    })

    const data = await response.json() as MetaGraphResponse
    if (!response.ok || data.error) {
      return { success: false, status: 'failed', error: data.error?.message ?? `HTTP ${response.status}` }
    }

    return { success: true, status: 'sent', messageId: data.messages?.[0]?.id }
  } catch (err) {
    return { success: false, status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function fetchWhatsAppMedia(
  env: WhatsAppEnv,
  mediaId: string
): Promise<{ bytes: ArrayBuffer; mimeType: string; fileSize: number; sha256?: string }> {
  const accessToken = env.WHATSAPP_ACCESS_TOKEN
  if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN not configured')

  const configuredMaxBytes = Number(env.MAX_WHATSAPP_MEDIA_BYTES)
  const maxBytes = Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : DEFAULT_MAX_WHATSAPP_MEDIA_BYTES

  const metaResponse = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const meta = await metaResponse.json() as MetaMediaResponse
  if (!metaResponse.ok || meta.error || !meta.url || !meta.mime_type) {
    throw new Error(meta.error?.message ?? 'Failed to fetch WhatsApp media metadata')
  }
  if (typeof meta.file_size === 'number' && meta.file_size > maxBytes) {
    throw new Error(`WhatsApp media ${mediaId} exceeds max size (${meta.file_size} > ${maxBytes} bytes)`) 
  }

  const mediaResponse = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!mediaResponse.ok) {
    throw new Error(`Failed to download WhatsApp media: HTTP ${mediaResponse.status}`)
  }

  const declaredContentLength = Number(mediaResponse.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredContentLength) && declaredContentLength > maxBytes) {
    throw new Error(`WhatsApp media ${mediaId} content-length exceeds max size (${declaredContentLength} > ${maxBytes} bytes)`)
  }

  if (!mediaResponse.body) {
    throw new Error(`Failed to download WhatsApp media ${mediaId}: empty response body`)
  }

  const reader = mediaResponse.body.getReader()
  const chunks: Uint8Array[] = []
  let totalSize = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    totalSize += value.byteLength
    if (totalSize > maxBytes) {
      await reader.cancel(`WhatsApp media ${mediaId} exceeded max size while streaming`)
      throw new Error(`WhatsApp media ${mediaId} exceeds max size while streaming (${totalSize} > ${maxBytes} bytes)`)
    }
    chunks.push(value)
  }

  const merged = new Uint8Array(totalSize)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return {
    bytes: merged.buffer,
    mimeType: meta.mime_type,
    fileSize: meta.file_size ?? totalSize,
    sha256: meta.sha256,
  }
}

