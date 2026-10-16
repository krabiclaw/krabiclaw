import { HTTPError } from 'nitro'

export type WhatsAppDeliveryMode = 'provider' | 'log_only'

type WhatsAppDeliveryEnv = {
  WHATSAPP_DELIVERY_MODE?: string
}

/**
 * The configured WhatsApp delivery mode, stated explicitly by every
 * environment in wrangler.toml. A missing or unrecognised value is a
 * configuration failure, never a mode — the same contract as
 * getEmailDeliveryMode in email-delivery.ts.
 */
export function getWhatsAppDeliveryMode(env: WhatsAppDeliveryEnv): WhatsAppDeliveryMode {
  // See getEmailDeliveryMode in email-delivery.ts: local development always
  // remains log-only even though the top-level Wrangler vars are for production.
  if (import.meta.dev) return 'log_only'
  const mode = env.WHATSAPP_DELIVERY_MODE
  if (mode === undefined || mode === '') {
    throw new HTTPError({ statusCode: 503, message: 'WHATSAPP_DELIVERY_MODE is not configured', data: { code: 'WHATSAPP_DELIVERY_MODE_REQUIRED', field: 'WHATSAPP_DELIVERY_MODE' } })
  }
  if (mode !== 'provider' && mode !== 'log_only') {
    throw new HTTPError({ statusCode: 503, message: 'WHATSAPP_DELIVERY_MODE must be provider or log_only', data: { code: 'INVALID_WHATSAPP_DELIVERY_MODE', field: 'WHATSAPP_DELIVERY_MODE' } })
  }
  return mode
}

export function shouldSendRealWhatsApp(env: WhatsAppDeliveryEnv): boolean {
  return getWhatsAppDeliveryMode(env) === 'provider'
}

export function logOnlyWhatsAppMessageId(prefix = 'whatsapp'): string {
  return `log-only:${prefix}:${crypto.randomUUID()}`
}
