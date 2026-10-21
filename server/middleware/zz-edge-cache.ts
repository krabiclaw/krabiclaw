// KV-based SSR HTML cache — globally replicated, ~4ms read latency from any edge.
// Replaces the previous caches.default approach which was per-datacenter only.
//
// Cache key: html:<host>:<build id>:<revision>:<pathname>
// Stored in ORGANIZATION_CACHE KV namespace with CACHE_TTL_SECONDS TTL.
// Tenant resolution runs first; the committed revision fences cached HTML before Vue SSR.
// On a miss: falls through to SSR; server/plugins/edge-cache.ts populates KV.
//
// NEVER cached:
//   - /api/**, /dashboard/**, /auth/** — auth-gated
//   - Requests with session cookie — personalised
//   - Requests with the preview cookie — one owner's view of their own
//     unpublished site, which must never be read from or written to a cache
//     everyone shares
//   - Paths with query strings
//   - Non-GET requests
//   - No Host header

import { defineHandler } from 'nitro';
import { setResponseHeaders } from 'nitro/h3';
import { buildHtmlCacheKey } from '~/server/utils/edge-cache'
import { PREVIEW_COOKIE_NAME } from '~/server/utils/preview-token'

const CACHE_TTL_SECONDS = 60

const SKIP_PREFIXES = [
  '/api/', '/dashboard', '/auth/',
  '/signup', '/login', '/links', '/_nuxt/', '/assets/', '/_ipx/',
]

const SESSION_COOKIE = 'better-auth.session_token'

export default defineHandler(async (event) => {
  if (event.method !== 'GET') return
  if (SKIP_PREFIXES.some(p => event.path.startsWith(p))) return
  const requestCookies = (event.req.headers.get('cookie')) ?? ''
  if (requestCookies.includes(SESSION_COOKIE)) return
  if (requestCookies.includes(`${PREVIEW_COOKIE_NAME}=`)) return
  if (event.path.includes('?')) return

  const key = await buildHtmlCacheKey(event)
  if (!key) return

  // Access KV directly from the Cloudflare event context
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kv = (event.req.runtime?.cloudflare?.env as any)?.ORGANIZATION_CACHE as KVNamespace | undefined
  if (!kv) return

  const hit = await kv.get(key, 'text')
  if (!hit) return

  setResponseHeaders(event, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${CACHE_TTL_SECONDS}, max-age=0`,
    'x-edge-cache': 'HIT',
  })
  return hit
})
