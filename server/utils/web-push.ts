import { HTTPError } from 'nitro'
import { buildPushPayload } from '@block65/webcrypto-web-push'
import { platformOrigin } from '~/server/utils/dashboard-notification-links'

/**
 * Web Push to a browser's subscription: RFC 8030 delivery, RFC 8291 payload
 * encryption (aes128gcm) and RFC 8292 VAPID signing.
 *
 * The VAPID public key is the one the browser subscribed with, so it is the
 * same public runtime value the dashboard reads; the private key is a secret.
 */
export interface WebPushEnv {
  NUXT_PUBLIC_PLATFORM_DOMAIN?: string
  NUXT_PUBLIC_VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
}

/** What the service worker shows, and the dashboard link a click opens. */
export interface WebPushAlert {
  title: string
  body: string
  url: string
  /** Replaces an earlier notification about the same conversation; absent when it belongs to none. */
  tag: string | null
}

export type WebPushSendResult =
  | { status: 'sent'; messageId: string | null }
  | {
      status: 'failed'
      httpStatus: number
      error: string
      /** The push service reported the subscription expired or was removed (404, 410). */
      subscriptionGone: boolean
    }

function vapidKeys(env: WebPushEnv) {
  for (const field of ['NUXT_PUBLIC_VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] as const) {
    if (!env[field]?.trim()) {
      throw new HTTPError({ statusCode: 503, message: `${field} is not configured for web push delivery`, data: { code: 'VAPID_CONFIG_REQUIRED', field } })
    }
  }
  return { subject: platformOrigin(env), publicKey: env.NUXT_PUBLIC_VAPID_PUBLIC_KEY!.trim(), privateKey: env.VAPID_PRIVATE_KEY!.trim() }
}

/**
 * Sends one alert to one subscription and returns the push service's answer.
 * Missing configuration and a request that never reached the push service
 * throw; the caller records either on the delivery.
 */
export async function sendWebPush(
  env: WebPushEnv,
  input: { subscription: { endpoint: string; p256dh: string; auth: string }; alert: WebPushAlert },
): Promise<WebPushSendResult> {
  const request = await buildPushPayload(
    { data: { ...input.alert }, options: { ttl: 24 * 60 * 60, urgency: 'high' } },
    { endpoint: input.subscription.endpoint, expirationTime: null, keys: { p256dh: input.subscription.p256dh, auth: input.subscription.auth } },
    vapidKeys(env),
  )
  const response = await fetch(input.subscription.endpoint, { method: 'POST', headers: request.headers, body: request.body })
  // RFC 8030 §5: 201 Created, with the push message's resource in Location.
  if (response.ok) return { status: 'sent', messageId: response.headers.get('location') }
  const body = await response.text()
  return {
    status: 'failed',
    httpStatus: response.status,
    error: `Web push ${new URL(input.subscription.endpoint).host} ${response.status} ${body.slice(0, 200) || response.statusText}`,
    subscriptionGone: response.status === 404 || response.status === 410,
  }
}
