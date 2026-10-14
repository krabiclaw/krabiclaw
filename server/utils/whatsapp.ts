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

function cleanTemplateText(value: string | undefined, fallback: string, maxLen = 120): string {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (raw) return raw.slice(0, maxLen)
  // Process fallback the same way so returned string respects maxLen
  const fb = String(fallback ?? '').replace(/\s+/g, ' ').trim()
  return fb.slice(0, maxLen)
}

// Dynamic URL buttons in approved Meta templates are declared as a fixed prefix +
// single {{1}} variable (e.g. "https://krabiclaw.com/dashboard/{{1}}"), so callers
// that already built a full dashboard URL only need the suffix after that prefix.
export function toDashboardButtonPath(url: string | undefined, fallback = ''): string {
  const marker = '/dashboard/'
  const idx = String(url ?? '').indexOf(marker)
  return idx >= 0 ? String(url).slice(idx + marker.length) : fallback
}

function normalizeTemplateVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(vars)) {
    out[key] = String(val ?? '').replace(/\s+/g, ' ').trim()
  }
  return out
}

// Shared by new_contact_msg and guest_thread_reply_whatsapp, which both send through the
// same approved "new_contact_msg" Meta template and only differ in fallback copy.
function buildContactAlertTemplate(
  v: Record<string, string>,
  fallbacks: { subjectFallback: string; messageFallback: string },
): { name: string; language: { code: string }; components: TemplateComponent[] } {
  return {
    name: 'new_contact_msg',
    language: { code: 'en_US' },
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.guest_name, 'Guest') },
          { type: 'text', text: cleanTemplateText(v.email, 'No email provided', 120) },
          { type: 'text', text: cleanTemplateText(v.subject, fallbacks.subjectFallback, 40) },
          { type: 'text', text: cleanTemplateText(v.message_preview, fallbacks.messageFallback, 100) },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.reply_path, '', 300) },
        ],
      },
    ],
  }
}

// Map our template names to Meta template names + variable builders.
// Meta template names must match exactly what was approved in Business Manager.
const TEMPLATES: Record<
  WhatsAppTemplate,
  (_vars: Record<string, string>) => { name: string; language: { code: string }; components: TemplateComponent[] }
> = {
  booking_change_update: (v) => ({
    name: 'booking_change_update',
    language: { code: 'en_US' },
    components: [
      { type: 'body', parameters: [
        { type: 'text', text: cleanTemplateText(v.booking_type, 'reservation') },
        { type: 'text', text: cleanTemplateText(v.guest_name, 'Guest') },
        { type: 'text', text: cleanTemplateText(v.status, 'requested') },
        { type: 'text', text: cleanTemplateText(v.location, 'Location not provided') },
        // Never the bare field name: a slot that falls back to "Date" is what
        // told guests their booking moved to "Date" at "Time".
        { type: 'text', text: cleanTemplateText(v.date, 'See dashboard') },
        { type: 'text', text: cleanTemplateText(v.time, 'See dashboard') },
        { type: 'text', text: cleanTemplateText(v.guests, '1') },
        { type: 'text', text: cleanTemplateText(v.message, 'Open the dashboard for details.', 250) },
      ] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [
        { type: 'text', text: cleanTemplateText(v.reply_path, '', 300) },
      ] },
    ],
  }),
  new_review: (v) => ({
    name: 'new_review',
    language: { code: 'en_US' },
    components: [
      {
        type: 'header',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.organization_name, '', 60) },
        ],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: v.rating ?? '5' },
          { type: 'text', text: cleanTemplateText(v.excerpt, 'Open the dashboard for the full review.', 300) },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [
          { type: 'text', text: toDashboardButtonPath(v.reviews_url) },
        ],
      },
    ],
  }),
  new_contact_msg: (v) => buildContactAlertTemplate(v, { subjectFallback: 'General', messageFallback: 'No message preview' }),
  // Reuses the approved owner contact template shape so guest reply alerts
  // stay within Meta's existing parameter contract while deep-linking into
  // the exact dashboard thread.
  guest_thread_reply_whatsapp: (v) => buildContactAlertTemplate(v, { subjectFallback: 'Guest reply', messageFallback: 'Open the dashboard for the full reply.' }),
  new_reservation: (v) => ({
    name: 'new_reservation',
    language: { code: 'en_US' },
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.guest_name, 'Guest') },
          { type: 'text', text: cleanTemplateText(v.date, 'Date pending', 40) },
          { type: 'text', text: cleanTemplateText(v.time, 'Time pending', 40) },
          { type: 'text', text: cleanTemplateText(v.guests, 'Unknown', 24) },
          { type: 'text', text: cleanTemplateText(v.phone, 'No phone provided', 40) },
          { type: 'text', text: cleanTemplateText(v.email, 'No email provided', 100) },
          { type: 'text', text: cleanTemplateText(v.context, 'Context not provided', 100) },
          { type: 'text', text: cleanTemplateText(v.requests, 'None', 100) },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.reply_path, '', 300) },
        ],
      },
    ],
  }),
  reservation_cancelled: (v) => ({
    name: 'reservation_cancelled',
    language: { code: 'en_US' },
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.guest_name, 'Guest') },
          { type: 'text', text: cleanTemplateText(v.date, 'Date pending', 40) },
          { type: 'text', text: cleanTemplateText(v.time, 'Time pending', 40) },
          { type: 'text', text: cleanTemplateText(v.guests, 'Unknown', 24) },
          { type: 'text', text: cleanTemplateText(v.phone, 'No phone provided', 40) },
          { type: 'text', text: cleanTemplateText(v.context, 'Context not provided', 100) },
          { type: 'text', text: cleanTemplateText(v.requests, 'None', 100) },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.reply_path, '', 300) },
        ],
      },
    ],
  }),
  domain_update: (v) => ({
    name: 'domain_update',
    language: { code: 'en_US' },
    components: [
      {
        type: 'header',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.domain, 'your domain', 60) },
        ],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.status, 'updated', 40) },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [
          { type: 'text', text: toDashboardButtonPath(v.dashboard_url, 'settings') },
        ],
      },
    ],
  }),
  otp_code: (v) => ({
    name: 'otp_code',
    language: { code: 'en_US' },
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.code, '', 12) },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [
          { type: 'text', text: cleanTemplateText(v.code, '', 12) },
        ],
      },
    ],
  }),
}

export function buildWhatsAppTemplatePayload(template: WhatsAppTemplate, vars: Record<string, string>) {
  return TEMPLATES[template](normalizeTemplateVars(vars))
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
  const vars = normalizeTemplateVars(opts.vars ?? {})

  if (!shouldSendRealWhatsApp(env)) {
    const messageId = logOnlyWhatsAppMessageId('notification')
    console.log('whatsapp_delivery_log_only', { attemptId, template: opts.template, to: maskPhone(normalizedPhone) })
    return { success: true, status: 'sent', messageId }
  }

  if (!phoneNumberId || !accessToken) {
    return { success: false, status: 'failed', error: 'WhatsApp env vars not configured' }
  }

  const templatePayload = buildWhatsAppTemplatePayload(opts.template, vars)

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
  const templatePayload = TEMPLATES.otp_code({ code })

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

