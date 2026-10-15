import type { H3Event } from 'nitro';

import type { CloudflareEnv } from '~/server/utils/auth'

// Shared constant-time secret comparison for internal, secret-gated routes
// (server/api/internal/*). Extracted so multiple internal routes can reuse the
// same check instead of duplicating the timing-safe comparison logic.
export async function secretsMatch(expectedSecret: string, providedSecret: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (_expectedDigest: BufferSource, _providedDigest: BufferSource) => boolean
  }
  const [expectedDigest, providedDigest] = await Promise.all([
    subtle.digest('SHA-256', encoder.encode(expectedSecret)),
    subtle.digest('SHA-256', encoder.encode(providedSecret)),
  ])

  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(expectedDigest, providedDigest)
  }

  const left = new Uint8Array(expectedDigest)
  const right = new Uint8Array(providedDigest)
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return diff === 0
}

export type InternalRequestValidation =
  | { ok: true }
  | { ok: false, status: 401 | 500, error: string }

/** A secret-gated internal caller: the environment secret it holds and the one header it sends it in. */
export const SEARCH_INTERNAL_CALLER = { secret: 'PLATFORM_SEARCH_REINDEX_SECRET', header: 'x-krabiclaw-search-secret' } as const
export const LODGING_INTERNAL_CALLER = { secret: 'LODGING_SERVICE_SECRET', header: 'x-krabiclaw-lodging-secret' } as const
export const CHANNEX_WEBHOOK_CALLER = { secret: 'CHANNEX_WEBHOOK_SECRET', header: 'x-channex-webhook-secret' } as const

// Shared auth flow for every secret-gated internal route: a misconfigured secret
// is a 500, a mismatch a 401. The secret travels only in the caller's own
// header; Authorization belongs to user sessions and is never read here.
export async function validateInternalRequest(
  event: H3Event,
  env: CloudflareEnv,
  caller: typeof SEARCH_INTERNAL_CALLER | typeof LODGING_INTERNAL_CALLER | typeof CHANNEX_WEBHOOK_CALLER,
): Promise<InternalRequestValidation> {
  const configured = env[caller.secret]
  const expectedSecret = typeof configured === 'string' ? configured.trim() : ''
  if (!expectedSecret) {
    return { ok: false, status: 500, error: `${caller.secret} is not configured` }
  }

  const providedSecret = event.req.headers.get(caller.header) ?? ''

  if (!(await secretsMatch(expectedSecret, providedSecret))) {
    return { ok: false, status: 401, error: 'Unauthorized' }
  }

  return { ok: true }
}
