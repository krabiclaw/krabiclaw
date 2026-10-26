import { createHash } from 'node:crypto'
import { HTTPError } from 'nitro'
import { getResendClient } from '~/server/utils/resend'
import type { NotificationEmailPurpose } from '~/server/notifications/messages'

export type EmailDeliveryMode = 'provider' | 'log_only'

type EmailDeliveryEnv = {
  EMAIL_DELIVERY_MODE?: string
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
}

export type EmailSendResult =
  | { status: 'sent'; messageId: string | null }
  /** `code` is machine-readable; `error` leads with it, so a persisted delivery error carries it too. */
  | { status: 'failed'; code: string; error: string }

function failed(code: string, message: string): EmailSendResult {
  return { status: 'failed', code, error: `${code}: ${message}` }
}

/**
 * The configured email delivery mode, which every environment states explicitly
 * in wrangler.toml: production "provider", staging/E2E/local "log_only".
 *
 * A missing or unrecognised value is a configuration failure, never a mode.
 * This used to answer log_only for both, so a deployment that lost the var
 * reported every email as sent while nothing reached anyone. (Before that it
 * answered provider, and seeded fixture addresses bounced from production.)
 */
export function getEmailDeliveryMode(env: EmailDeliveryEnv): EmailDeliveryMode {
  // `nuxt dev` reads wrangler.toml's top-level [vars] — the same block
  // `wrangler deploy` (no --env) uses for production — so a local dev session
  // inherits EMAIL_DELIVERY_MODE=provider from the production config. Local
  // development is log_only by construction, not by local config.
  if (import.meta.dev) return 'log_only'
  const mode = env.EMAIL_DELIVERY_MODE
  if (mode === undefined || mode === '') {
    throw new HTTPError({ statusCode: 503, message: 'EMAIL_DELIVERY_MODE is not configured', data: { code: 'EMAIL_DELIVERY_MODE_REQUIRED', field: 'EMAIL_DELIVERY_MODE' } })
  }
  if (mode !== 'provider' && mode !== 'log_only') {
    throw new HTTPError({ statusCode: 503, message: 'EMAIL_DELIVERY_MODE must be provider or log_only', data: { code: 'INVALID_EMAIL_DELIVERY_MODE', field: 'EMAIL_DELIVERY_MODE' } })
  }
  return mode
}

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex')
}

export function shouldSendRealEmail(env: EmailDeliveryEnv): boolean {
  return getEmailDeliveryMode(env) === 'provider'
}

export function logOnlyEmailProviderId(prefix = 'email'): string {
  return `log-only:${prefix}:${crypto.randomUUID()}`
}

// RFC 2606 reserves .test/.example/.invalid (plus .localhost) as non-resolvable, always-fake
// domains for documentation/testing — a real mailbox can never exist there, so any send here
// is guaranteed to hard-bounce. A provider-mode send to one is refused with a coded failure
// rather than reported as sent: in an environment seeded with e2e/demo fixture addresses
// (e.g. user-mcp-growth@example.test) the bounce is stopped before it reaches Resend, and the
// delivery says it was refused.
const RESERVED_TEST_TLDS = new Set(['test', 'example', 'invalid', 'localhost'])

// RFC 2606 also reserves these exact second-level domains under otherwise-real TLDs
// (example.com/net/org) — these are the ones actually seen bouncing in production
// (wa-verify@example.com, verify-guest@example.com), since their TLD is "com", not "example".
const RESERVED_TEST_DOMAINS = new Set(['example.com', 'example.net', 'example.org'])

export function isReservedTestDomain(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain) return false
  if (RESERVED_TEST_DOMAINS.has(domain)) return true
  const tld = domain.split('.').pop() ?? ''
  if (RESERVED_TEST_TLDS.has(tld)) return true
  // Check for subdomains under reserved roots (e.g., mail.example.com, wa-verify.example.com)
  for (const reservedDomain of RESERVED_TEST_DOMAINS) {
    if (domain === reservedDomain || domain.endsWith(`.${reservedDomain}`)) return true
  }
  return false
}

/**
 * The From header for mail KrabiClaw sends: the configured sender, with its
 * display name replaced when the message is sent on a business's behalf.
 * EMAIL_FROM is required; there is no default sender.
 */
export function emailSender(env: Pick<EmailDeliveryEnv, 'EMAIL_FROM'>, fromName?: string): string {
  const configuredFrom = env.EMAIL_FROM?.trim()
  if (!configuredFrom) {
    throw new HTTPError({ statusCode: 503, message: 'EMAIL_FROM is not configured', data: { code: 'EMAIL_FROM_REQUIRED', field: 'EMAIL_FROM' } })
  }
  if (!fromName) return configuredFrom
  return configuredFrom.includes('<')
    ? configuredFrom.replace(/^[^<]*(?=<)/, `${fromName} `)
    : `${fromName} <${configuredFrom}>`
}

export async function sendEmail(
  env: EmailDeliveryEnv,
  input: {
    to: string
    subject: string
    text: string
    emailPurpose: NotificationEmailPurpose
    /**
     * Required. Every outbound message renders through server/emails — a send
     * that can omit the HTML body is how inbox replies ended up as bare text
     * (#969), so the type no longer allows one.
     */
    html: string
    replyTo?: string | null
    fromName?: string
    idempotencyKey?: string
    /**
     * The RFC 8058 one-click endpoint for this message's category, so a mail
     * client can unsubscribe without opening the message. It must be a route
     * that accepts POST — the header's own POST body is fixed by the RFC, so
     * the signed target travels in the URL. Transactional mail never carries
     * mailing-list headers, even when a caller supplies this URL.
     */
    unsubscribeOneClickUrl?: string | null
  },
): Promise<EmailSendResult> {
  if (!['transactional', 'subscribed', 'promotional'].includes(input.emailPurpose)) return failed('EMAIL_PURPOSE_REQUIRED', 'a valid email purpose is required')
  if (input.emailPurpose !== 'transactional' && !input.unsubscribeOneClickUrl) return failed('EMAIL_UNSUBSCRIBE_REQUIRED', 'subscribed and promotional email require one-click unsubscribe')
  if (!shouldSendRealEmail(env)) {
    return { status: 'sent', messageId: logOnlyEmailProviderId('email') }
  }
  if (isReservedTestDomain(input.to)) return failed('RESERVED_TEST_EMAIL_DOMAIN', 'the recipient is on a reserved test domain that cannot receive mail')
  if (!env.RESEND_API_KEY) return failed('RESEND_API_KEY_REQUIRED', 'RESEND_API_KEY is not configured')
  // Checked here rather than thrown from emailSender, because a caller may
  // already hold a delivery receipt that this outcome has to be written onto.
  if (!env.EMAIL_FROM?.trim()) return failed('EMAIL_FROM_REQUIRED', 'EMAIL_FROM is not configured')

  const from = emailSender(env, input.fromName)
  const resend = getResendClient(env)
  const response = await resend.emails.send({
    from,
    to: [input.to],
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject: input.subject,
    html: input.html,
    text: input.text,
    ...(input.emailPurpose !== 'transactional' && input.unsubscribeOneClickUrl
      ? {
          headers: {
            'List-Unsubscribe': `<${input.unsubscribeOneClickUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }
      : {}),
  }, input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined)
  if (!response.error) return { status: 'sent', messageId: response.data.id }
  return failed('RESEND_REJECTED', `${response.error.statusCode ?? 'no response'} ${response.error.name}: ${response.error.message}`)
}
