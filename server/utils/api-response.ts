import { HTTPError } from 'nitro';
import type { H3Event } from 'nitro';
import {  getRequestHost, readBody  } from 'nitro/h3';
import { createDb, type AppDb } from '~/server/db'
import type { CloudflareEnv } from './auth'
import { isNonProductionHost } from '~/server/utils/tenant-hosts'
import { getRequestDataMetrics, instrumentD1 } from '~/server/utils/request-metrics'

export const jsonResponse = (body: ApiValue, init: ResponseInit = {}) => {
  const mergedHeaders = new Headers(init.headers)
  mergedHeaders.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(body), {
    ...init,
    headers: mergedHeaders,
  })
}

export async function readRequiredBody<T>(event: H3Event): Promise<T> {
  const body = await readBody<T>(event)
  if (body === undefined) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Request body is required' })
  }
  return body as T
}

export type StrictBodyFieldType = 'string' | 'nullable-string' | 'number' | 'boolean' | 'unknown'

function matchesStrictBodyField(value: unknown, type: StrictBodyFieldType): boolean {
  if (type === 'unknown') return true
  if (type === 'nullable-string') return value === null || typeof value === 'string'
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === 'boolean'
}

export async function readStrictBody<T>(event: H3Event, fields: Readonly<Record<string, StrictBodyFieldType>>): Promise<T> {
  const body = await readRequiredBody<Record<string, unknown>>(event)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Request body must be an object' })
  }
  const allowed = new Set(Object.keys(fields))
  const unknown = Object.keys(body).filter(key => !allowed.has(key)).sort()
  if (unknown.length) {
    throw new HTTPError({
      statusCode: 400,
      statusMessage: `Unknown request field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
    })
  }
  for (const [field, value] of Object.entries(body)) {
    if (!matchesStrictBodyField(value, fields[field]!)) {
      throw new HTTPError({ statusCode: 400, statusMessage: `Invalid type for request field: ${field}` })
    }
  }
  return body as T
}

export const textResponse = (
  body: string,
  init: ResponseInit = {},
  contentType = 'text/plain; charset=utf-8',
) => {
  const mergedHeaders = new Headers(init.headers)
  mergedHeaders.set('content-type', contentType)
  return new Response(body, {
    ...init,
    headers: mergedHeaders,
  })
}

export const apiErrorResponse = (
  event: H3Event,
  status: number,
  code: string,
  message: string,
) => {
  const requestId = getRequestDataMetrics(event).requestId
  return jsonResponse({
    error: { code, message, requestId },
  }, {
    status,
    headers: { 'x-request-id': requestId },
  })
}

export const cleanString = (value: ApiValue, maxLength: number) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''

// A generic `catch (error) { return 500 }` block silently swallows a
// new HTTPError() thrown earlier in the same try (e.g. an authorization check
// from server/utils/member-access.ts) into a wrong, generic 500. Call this
// first in every such catch block so an intentional statusCode (401/403/404/...)
// propagates instead of being masked.
export function rethrowHttpError(error: unknown): void {
  if (
    error
    && typeof error === 'object'
    && 'statusCode' in error
    && typeof (error as { statusCode?: unknown }).statusCode === 'number'
  ) {
    throw error
  }
}

// A nested internal self-fetch (event.$fetch/useRequestFetch inside SSR) is a
// synthetic event that Nitro dispatches locally without re-attaching
// event.req.runtime.cloudflare — that's the direct, reliable signal to detect it,
// rather than inferring it from an absent cf-ray header. Middleware that does
// real work (DB pragmas, tenant resolution) should guard on this before doing
// anything, not just when deciding a log level.
export const isInternalSelfFetch = (event: H3Event): boolean =>
  !event.req.runtime?.cloudflare?.env

export const cloudflareEnv = (event: H3Event): CloudflareEnv => {
  const processEnv: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env
  const rawRuntimeEnv = event.req.runtime?.cloudflare?.env as Record<string, unknown> | undefined
  const runtimeEnv = (() => {
    const env = rawRuntimeEnv
    const requiredBindings = ['DB', 'MEDIA_BUCKET', 'ORGANIZATION_CACHE', 'AI'] as const
    const missing = requiredBindings.filter((key) => !env?.[key])

    if (missing.length > 0) {
      const cfRay = (event.req.headers.get('cf-ray'))
      const host = (event.req.headers.get('host')) ?? 'no-host'
      const path = event.path ?? 'no-path'
      const isRealInboundRequest = !isInternalSelfFetch(event)
      const logMessage =
        `[cloudflareEnv] Missing bindings: ${missing.join(', ')} ` +
        `for ${host}${path} (cf-ray: ${cfRay ?? 'no-cf-ray'}). In local dev, run via wrangler dev/yarn dev. ` +
        (isRealInboundRequest
          ? 'In production this means the Workers runtime did not attach bindings to this request — escalate to Cloudflare support with the cf-ray above if it recurs on real traffic.'
          : 'No cf-ray present — this looks like a nested internal self-fetch (event.$fetch/useRequestFetch), which does not inherit Cloudflare bindings. Fetch the data directly instead of self-fetching if this is unexpected.')

      if (isRealInboundRequest) {
        console.error(logMessage)
      } else {
        console.warn(logMessage)
      }

      if (rawRuntimeEnv?.CI === 'true' && isRealInboundRequest) {
        throw new HTTPError({
          statusCode: 503,
          statusMessage: `Cloudflare bindings missing: ${missing.join(', ')}`
        })
      }
    }

    return env ?? {}
  })()
  const effectiveEnv: Record<string, unknown> = { ...processEnv, ...runtimeEnv }
  const emailDeliveryMode = typeof effectiveEnv.EMAIL_DELIVERY_MODE === 'string' ? effectiveEnv.EMAIL_DELIVERY_MODE : undefined
  const whatsappDeliveryMode = typeof effectiveEnv.WHATSAPP_DELIVERY_MODE === 'string' ? effectiveEnv.WHATSAPP_DELIVERY_MODE : undefined

  const rawD1 = runtimeEnv.DB as D1Database | undefined
  // One D1 session per request, anchored on the primary. The first statement reads the
  // primary's current version; later reads may be served by a read replica that has
  // caught up to that bookmark, and writes always go to the primary. That keeps
  // read-your-writes across requests while a Worker running far from the primary stops
  // paying a cross-region round trip for every SELECT. Without read replication enabled
  // on the database, the session is served by the primary and behaves as before.
  // Locally the bindings are not objects in this process: Miniflare hands out
  // proxy stubs into the workerd runtime beside it, and refuses to use one whose
  // runtime has gone. Holding the stub is fine — the checks above only test that
  // one is present — so the failure surfaces here, at the first property read on
  // it. When workerd dies, this process keeps serving with stubs pointing at
  // nothing and every request fails here for the rest of its life, naming
  // whichever route ran next. That reads like a bug in that route rather than a
  // dead runtime, and reloading never clears it because the stub outlives the
  // reload, so say what happened and what fixes it.
  let d1: D1Database | undefined
  try {
    d1 = rawD1 ? instrumentD1(event, rawD1.withSession('first-primary'), rawD1) : undefined
  } catch (error) {
    if (error instanceof Error && error.message.includes('poisoned stub')) {
      throw new HTTPError({
        statusCode: 503,
        statusMessage: 'The local Worker runtime backing this dev server is gone, so its Cloudflare bindings cannot be reached. '
          + 'Restart the dev server; this does not recover on its own. '
          + 'A machine-wide kill such as `pkill -f workerd` does this to every dev server on the machine, not just your own — stop one by its port instead.',
      })
    }
    throw error
  }
  const db = d1 ? createDb(d1) : undefined

  // Apply E2E delivery-mode overrides only for approved dev/E2E requests
  const devMode = import.meta.dev
  const e2eOverride = effectiveEnv.E2E_ALLOW_DEV_ROUTES === 'true'
  const allowDevRoute = devMode || e2eOverride
  let e2eDeliveryOverrides: Record<string, string> = {}

  if (allowDevRoute && !devMode && e2eOverride) {
    const expectedSecret = String(effectiveEnv.E2E_DEV_ROUTE_SECRET ?? '')
    const providedSecret = (event.req.headers.get('x-dev-route-secret')) || ''
    const secretValid = expectedSecret && providedSecret && expectedSecret === providedSecret
    const hostname = (getRequestHost(event, { xForwardedHost: true }) || '').split(':')[0] || ''
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1'
    const isPreview = isNonProductionHost(hostname)
    const hostAllowed = isLocalHost || isPreview

    if (secretValid && hostAllowed) {
      e2eDeliveryOverrides = {
        ...(emailDeliveryMode !== undefined && { EMAIL_DELIVERY_MODE: emailDeliveryMode }),
        ...(whatsappDeliveryMode !== undefined && { WHATSAPP_DELIVERY_MODE: whatsappDeliveryMode }),
      }
    }
  } else if (devMode) {
    e2eDeliveryOverrides = {
      ...(emailDeliveryMode !== undefined && { EMAIL_DELIVERY_MODE: emailDeliveryMode }),
      ...(whatsappDeliveryMode !== undefined && { WHATSAPP_DELIVERY_MODE: whatsappDeliveryMode }),
    }
  }

  return {
    ...effectiveEnv,
    ...e2eDeliveryOverrides,
    DB: d1,
    db,
  } as CloudflareEnv
}

export type { AppDb }
