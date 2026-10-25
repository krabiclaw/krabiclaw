// Serves R2 objects for media.krabiclaw.com.
// Must run before tenant-resolution (filename prefix "00." ensures alphabetical priority).
// Handles range requests so video seeking works in browsers.

import { defineHandler } from 'nitro';
import type { getHeader} from 'nitro/h3';
import {  sendStream, setHeader, setResponseStatus } from 'nitro/h3';
import { cloudflareEnv } from '~/server/utils/api-response'
import { isNonProductionHost } from '~/server/utils/tenant-hosts'

const MEDIA_HOST = 'media.krabiclaw.com'
const WORKER_MEDIA_PREFIX = '/__media/'

// Non-production environments have no separate media.krabiclaw.com host, so
// their canonical public media URLs use /__media on the app origin. The host
// boundary is the authorization boundary here: staging and local hosts may
// serve public media, while production tenant/platform
// hosts cannot use this path and continue through media.krabiclaw.com.
function isWorkerMediaPathAllowed(event: Parameters<typeof getHeader>[0]): boolean {
  if (import.meta.dev) return true
  const hostname = ((event.req.headers.get('host')) || '').split(':')[0] ?? ''
  return isNonProductionHost(hostname)
}

const WORKER_MEDIA_ISOLATION_HEADERS = {
  'content-security-policy': "sandbox; default-src 'none'",
  'x-content-type-options': 'nosniff',
}

function isolateWorkerMediaResponse(event: Parameters<typeof getHeader>[0]): void {
  for (const [name, value] of Object.entries(WORKER_MEDIA_ISOLATION_HEADERS)) setHeader(event, name, value)
}

// This host serves R2 objects and nothing else, so every answer it gives is a
// bare response. Throwing here instead sent the request into Nuxt's error
// pipeline, which renders /__nuxt_error through an internal self-fetch — and a
// nested self-fetch inherits no Cloudflare bindings, so this same handler ran
// again with no MEDIA_BUCKET and answered 503. That is how a missing
// robots.txt reached the client as "Media storage unavailable" instead of 404.
function mediaResponse(
  isolated: boolean,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, {
    status,
    headers: { ...(isolated ? WORKER_MEDIA_ISOLATION_HEADERS : {}), ...headers },
  })
}

export default defineHandler(async (event) => {
  const host = ((event.req.headers.get('host')) || '').split(':')[0]
  const url = event.url
  const isMediaHost = host === MEDIA_HOST
  const isWorkerMediaPath = url.pathname.startsWith(WORKER_MEDIA_PREFIX) && isWorkerMediaPathAllowed(event)
  if (!isMediaHost && !isWorkerMediaPath) return
  if (isWorkerMediaPath) isolateWorkerMediaResponse(event)

  const env = cloudflareEnv(event)
  const bucket = env.MEDIA_BUCKET
  if (!bucket) return mediaResponse(isWorkerMediaPath, 503)

  const key = isWorkerMediaPath
    ? url.pathname.slice(WORKER_MEDIA_PREFIX.length)
    : url.pathname.replace(/^\/+/, '')
  if (!key) return mediaResponse(isWorkerMediaPath, 404)

  const rangeHeader = (event.req.headers.get('range'))

  if (rangeHeader) {
    let head: Awaited<ReturnType<typeof bucket.head>>
    try {
      head = await bucket.head(key)
    } catch {
      return mediaResponse(isWorkerMediaPath, 502)
    }
    if (!head) return mediaResponse(isWorkerMediaPath, 404)

    const totalSize = head.size
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/)
    // A missing object and an unsatisfiable range are answers, not R2 faults,
    // so they keep the status this block chose rather than becoming a 502.
    if (!rangeMatch) return mediaResponse(isWorkerMediaPath, 416, { 'content-range': `bytes */${totalSize}` })

    const start = parseInt(rangeMatch[1] ?? '0', 10)
    // An end past the object is satisfiable and means its last byte (RFC 9110 §14.1.2).
    const end = rangeMatch[2] ? Math.min(parseInt(rangeMatch[2], 10), totalSize - 1) : totalSize - 1

    if (start >= totalSize || start > end || start < 0) {
      return mediaResponse(isWorkerMediaPath, 416, { 'content-range': `bytes */${totalSize}` })
    }

    const length = end - start + 1

    let obj: Awaited<ReturnType<typeof bucket.get>>
    try {
      obj = await bucket.get(key, { range: { offset: start, length } })
    } catch {
      return mediaResponse(isWorkerMediaPath, 502)
    }
    if (!obj) return mediaResponse(isWorkerMediaPath, 404)

    setResponseStatus(event, 206)
    setHeader(event, 'content-type', obj.httpMetadata?.contentType ?? 'application/octet-stream')
    setHeader(event, 'content-range', `bytes ${start}-${end}/${totalSize}`)
    setHeader(event, 'content-length', String(length))
    setHeader(event, 'accept-ranges', 'bytes')
    setHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
    return sendStream(event, obj.body)
  }

  let obj: Awaited<ReturnType<typeof bucket.get>>
  try {
    obj = await bucket.get(key)
  } catch {
    return mediaResponse(isWorkerMediaPath, 502)
  }
  if (!obj) return mediaResponse(isWorkerMediaPath, 404)

  setHeader(event, 'content-type', obj.httpMetadata?.contentType ?? 'application/octet-stream')
  setHeader(event, 'content-length', String(obj.size))
  setHeader(event, 'accept-ranges', 'bytes')
  setHeader(event, 'etag', obj.etag)
  setHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
  return sendStream(event, obj.body)
})
