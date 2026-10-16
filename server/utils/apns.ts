import { HTTPError } from 'nitro'

/**
 * Apple Push Notification service, token-based (.p8) provider authentication.
 *
 * https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
 * A device token belongs to the APNs environment its app build registered in,
 * so each token is sent to the host of its own environment.
 */
const APNS_ORIGINS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const

export type ApnsEnvironment = keyof typeof APNS_ORIGINS

export interface ApnsEnv {
  APNS_KEY_ID?: string
  APNS_TEAM_ID?: string
  APNS_BUNDLE_ID?: string
  APNS_PRIVATE_KEY?: string
}

export interface ApnsAlert {
  title: string
  body: string
  /** Groups the alert with others about the same conversation; absent when it belongs to none. */
  threadId: string | null
  data: Record<string, string>
}

export type ApnsSendResult =
  | { status: 'sent' }
  | {
      status: 'failed'
      httpStatus: number
      /** Apple's `reason`; null only when the response carried no Apple error body. */
      reason: string | null
      error: string
      /** Apple reported the device token is no longer valid for this topic. */
      tokenRetired: boolean
    }

const REQUIRED_CONFIG = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID', 'APNS_PRIVATE_KEY'] as const

function apnsConfig(env: ApnsEnv): Required<ApnsEnv> {
  for (const field of REQUIRED_CONFIG) {
    if (!env[field]?.trim()) {
      throw new HTTPError({ statusCode: 503, message: `${field} is not configured for APNs delivery`, data: { code: 'APNS_CONFIG_REQUIRED', field } })
    }
  }
  return env as Required<ApnsEnv>
}

/**
 * Apple refuses a provider token refreshed more than once every 20 minutes and
 * expires it after an hour, so one is reused per isolate and per key.
 */
const TOKEN_LIFETIME_MS = 45 * 60 * 1000
let cachedToken: { key: string; value: string; issuedAt: number } | null = null

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pkcs8(pem: string): ArrayBuffer {
  const match = /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----/.exec(pem)
  if (!match) {
    throw new HTTPError({ statusCode: 503, message: 'APNS_PRIVATE_KEY must be the PEM PKCS#8 key Apple issued', data: { code: 'INVALID_APNS_PRIVATE_KEY', field: 'APNS_PRIVATE_KEY' } })
  }
  const binary = atob(match[1]!.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

async function providerToken(config: Required<ApnsEnv>): Promise<string> {
  const key = `${config.APNS_TEAM_ID}:${config.APNS_KEY_ID}`
  const now = Date.now()
  if (cachedToken?.key === key && now - cachedToken.issuedAt < TOKEN_LIFETIME_MS) return cachedToken.value
  const signingKey = await crypto.subtle.importKey('pkcs8', pkcs8(config.APNS_PRIVATE_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const encode = (value: object) => base64Url(new TextEncoder().encode(JSON.stringify(value)))
  const unsigned = `${encode({ alg: 'ES256', kid: config.APNS_KEY_ID })}.${encode({ iss: config.APNS_TEAM_ID, iat: Math.floor(now / 1000) })}`
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, new TextEncoder().encode(unsigned))
  const value = `${unsigned}.${base64Url(new Uint8Array(signature))}`
  cachedToken = { key, value, issuedAt: now }
  return value
}

/** Apple's error body is `{"reason": "..."}`; anything else is reported as received. */
function apnsReason(body: string): string | null {
  return /^\s*\{[^]*"reason"\s*:\s*"([A-Za-z]+)"[^]*\}\s*$/.exec(body)?.[1] ?? null
}

/**
 * Sends one alert to one device and returns Apple's answer.
 *
 * Missing configuration and a request that never reached Apple throw; the
 * caller records either on the delivery. `apnsId` is sent as the request's
 * `apns-id`, which Apple echoes, so the delivery knows its identifier without
 * depending on the response.
 */
export async function sendApnsAlert(
  env: ApnsEnv,
  input: { deviceToken: string; environment: ApnsEnvironment; apnsId: string; alert: ApnsAlert },
): Promise<ApnsSendResult> {
  const config = apnsConfig(env)
  const response = await fetch(`${APNS_ORIGINS[input.environment]}/3/device/${input.deviceToken}`, {
    method: 'POST',
    headers: {
      'authorization': `bearer ${await providerToken(config)}`,
      'apns-id': input.apnsId,
      'apns-topic': config.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    },
    body: JSON.stringify({
      aps: {
        'alert': { title: input.alert.title, body: input.alert.body },
        'sound': 'default',
        ...(input.alert.threadId ? { 'thread-id': input.alert.threadId } : {}),
      },
      ...input.alert.data,
    }),
  })
  if (response.status === 200) return { status: 'sent' }
  const body = await response.text()
  const reason = apnsReason(body)
  // A rejected provider token stays rejected until it is reissued.
  if (response.status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')) cachedToken = null
  return {
    status: 'failed',
    httpStatus: response.status,
    reason,
    error: `APNs ${input.environment} ${response.status} ${reason ?? `unrecognized response body: ${body.slice(0, 200)}`}`,
    tokenRetired: response.status === 410 || (response.status === 400 && reason === 'BadDeviceToken'),
  }
}
