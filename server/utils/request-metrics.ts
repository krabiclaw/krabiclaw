import type { H3Event } from 'nitro';
import type { HTTPEvent } from 'nitro/h3';
import {  getResponseHeader, setHeader } from 'nitro/h3';
import { errorChainForTelemetry } from '~/shared/error-telemetry'

export interface RequestDataMetrics {
  requestId: string
  statementCount: number
  batchRoundTrips: number
  rowsRead: number
  rowsWritten: number
  d1DurationMs: number
  d1SqlDurationMs: number
  d1MetaCount: number
  d1Colos: Set<string>
  startedAt: number
  phases: Record<string, number>
  resources: Map<string, number>
  finalized: boolean
  // A telemetry write that failed. It never replaces the operation's own
  // outcome; the request's [data-request] record reports it.
  telemetryErrors: string[]
}

const metricsByEvent = new WeakMap<object, RequestDataMetrics>()
const databaseByEvent = new WeakMap<object, D1Database>()
const databaseTargets = new WeakMap<D1Database, D1Database>()
const statementTargets = new WeakMap<object, { target: object; query: string }>()
const SLOW_D1_QUERY_MS = 1000

type D1MetaSummary = {
  duration?: number
  rows_read?: number
  rows_written?: number
  served_by_region?: string
  served_by_colo?: string
  served_by_primary?: boolean
  total_attempts?: number
  timings?: { sql_duration_ms?: number }
}

export function getRequestDataMetrics(event: HTTPEvent): RequestDataMetrics {
  let metrics = metricsByEvent.get(event)
  if (!metrics) {
    metrics = {
      requestId: (event.req.headers.get('x-request-id')) || crypto.randomUUID(),
      statementCount: 0,
      batchRoundTrips: 0,
      rowsRead: 0,
      rowsWritten: 0,
      d1DurationMs: 0,
      d1SqlDurationMs: 0,
      d1MetaCount: 0,
      d1Colos: new Set(),
      startedAt: performance.now(),
      phases: {},
      resources: new Map(),
      finalized: false,
      telemetryErrors: [],
    }
    metricsByEvent.set(event, metrics)
  }
  return metrics
}

export function safeRoute(event: H3Event): string {
  const route = event.url.pathname + event.url.search

  try {
    return new URL(route, 'http://internal').pathname
  } catch {
    return route.split(/[?#]/, 1)[0] || '/'
  }
}

export function recordRequestPhase(event: H3Event, phase: string, startedAt: number) {
  const metrics = getRequestDataMetrics(event)
  metrics.phases[phase] = (metrics.phases[phase] ?? 0) + performance.now() - startedAt
}

function recordResult(metrics: RequestDataMetrics, value: unknown): D1MetaSummary[] {
  const summaries: D1MetaSummary[] = []
  const results = Array.isArray(value) ? value : [value]
  for (const result of results) {
    if (!result || typeof result !== 'object' || !('meta' in result)) continue
    const meta = (result as { meta?: D1MetaSummary }).meta
    metrics.rowsRead += Number(meta?.rows_read) || 0
    metrics.rowsWritten += Number(meta?.rows_written) || 0
    if (meta) {
      summaries.push(meta)
      metrics.d1MetaCount += 1
      metrics.d1SqlDurationMs += Number(meta.timings?.sql_duration_ms ?? meta.duration) || 0
      if (meta.served_by_colo) metrics.d1Colos.add(meta.served_by_colo)
    }
  }
  return summaries
}

function queryIdentity(query: string) {
  const normalized = query.replace(/\s+/g, ' ').trim()
  const operation = normalized.match(/^([a-z]+)/i)?.[1]?.toUpperCase() ?? 'UNKNOWN'
  const tableMatch = operation === 'INSERT'
    ? normalized.match(/\bINTO\s+["`[]?([\w-]+)/i)
    : operation === 'UPDATE'
      ? normalized.match(/^UPDATE\s+["`[]?([\w-]+)/i)
      : normalized.match(/\bFROM\s+["`[]?([\w-]+)/i)
  return { normalized, operation, table: tableMatch?.[1] ?? null }
}

async function queryFingerprint(normalizedQuery: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizedQuery))
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function logD1Query(
  level: 'error' | 'warn',
  event: H3Event,
  query: string,
  statementMethod: string,
  durationMs: number,
  error?: unknown,
  meta: D1MetaSummary[] = [],
) {
  const metrics = getRequestDataMetrics(event)
  try {
    const identity = queryIdentity(query)
    const firstMeta = meta[0]
    console[level]('[d1-query]', JSON.stringify({
      event: error ? 'd1_query_failed' : 'd1_query_slow',
      request_id: metrics.requestId,
      ray_id: (event.req.headers.get('cf-ray')) ?? null,
      route: safeRoute(event),
      statement_method: statementMethod,
      operation: identity.operation,
      table: identity.table,
      query_fingerprint: await queryFingerprint(identity.normalized),
      duration_ms: Number(durationMs.toFixed(2)),
      d1_meta: firstMeta
        ? {
            duration_ms: firstMeta.duration ?? null,
            sql_duration_ms: firstMeta.timings?.sql_duration_ms ?? null,
            rows_read: firstMeta.rows_read ?? null,
            rows_written: firstMeta.rows_written ?? null,
            served_by_region: firstMeta.served_by_region ?? null,
            served_by_colo: firstMeta.served_by_colo ?? null,
            served_by_primary: firstMeta.served_by_primary ?? null,
            total_attempts: firstMeta.total_attempts ?? null,
          }
        : null,
      error_chain: error ? errorChainForTelemetry(error) : null,
    }))
  } catch (telemetryError) {
    metrics.telemetryErrors.push(telemetryError instanceof Error ? telemetryError.message : String(telemetryError))
  }
}

function wrapStatement(statement: object, metrics: RequestDataMetrics, event: H3Event, query: string): object {
  const proxy = new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property === 'bind' && typeof value === 'function') {
        return (...args: unknown[]) => wrapStatement(value.apply(target, args) as object, metrics, event, query)
      }
      if (['first', 'all', 'run', 'raw'].includes(String(property)) && typeof value === 'function') {
        return async (...args: unknown[]) => {
          metrics.statementCount += 1
          const startedAt = performance.now()
          let queryDurationMs = 0
          try {
            const result = await value.apply(target, args)
            queryDurationMs = performance.now() - startedAt
            const meta = recordResult(metrics, result)
            if (queryDurationMs >= SLOW_D1_QUERY_MS) {
              await logD1Query('warn', event, query, String(property), queryDurationMs, undefined, meta)
            }
            return result
          } catch (error) {
            queryDurationMs = performance.now() - startedAt
            await logD1Query('error', event, query, String(property), queryDurationMs, error)
            throw error
          } finally {
            metrics.d1DurationMs += queryDurationMs
          }
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  statementTargets.set(proxy, { target: statement, query })
  return proxy
}

// `database` is what queries run through (a per-request D1 session); `primary` is the
// raw binding handed back by unwrapInstrumentedD1 to code that must not share the
// session, such as Better Auth's adapter.
export function instrumentD1(event: H3Event, database: D1Database | D1DatabaseSession, primary: D1Database): D1Database {
  const existing = databaseByEvent.get(event)
  if (existing) return existing
  const metrics = getRequestDataMetrics(event)
  const proxy = new Proxy(database as D1Database, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property === 'prepare' && typeof value === 'function') {
        return (...args: unknown[]) => wrapStatement(
          value.apply(target, args) as object,
          metrics,
          event,
          typeof args[0] === 'string' ? args[0] : 'unknown',
        )
      }
      if (property === 'batch' && typeof value === 'function') {
        return async (statements: object[]) => {
          metrics.statementCount += statements.length
          metrics.batchRoundTrips += 1
          const startedAt = performance.now()
          let batchDurationMs = 0
          try {
            const originals = statements.map(statement => statementTargets.get(statement)?.target ?? statement)
            const result = await value.call(target, originals)
            batchDurationMs = performance.now() - startedAt
            recordResult(metrics, result)
            return result
          } catch (error) {
            batchDurationMs = performance.now() - startedAt
            try {
              console.error('[d1-query]', JSON.stringify({
                event: 'd1_batch_failed',
                request_id: metrics.requestId,
                ray_id: (event.req.headers.get('cf-ray')) ?? null,
                route: safeRoute(event),
                statement_count: statements.length,
                statements: statements.map((statement) => {
                  const query = statementTargets.get(statement)?.query ?? 'unknown'
                  const { operation, table } = queryIdentity(query)
                  return { operation, table }
                }),
                duration_ms: Number(batchDurationMs.toFixed(2)),
                error_chain: errorChainForTelemetry(error),
              }))
            } catch (telemetryError) {
              metrics.telemetryErrors.push(telemetryError instanceof Error ? telemetryError.message : String(telemetryError))
            }
            throw error
          } finally {
            metrics.d1DurationMs += batchDurationMs
          }
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as D1Database
  databaseByEvent.set(event, proxy)
  databaseTargets.set(proxy, primary)
  return proxy
}

export function unwrapInstrumentedD1(database: D1Database): D1Database {
  return databaseTargets.get(database) ?? database
}

export function finalizeRequestMetrics(
  event: H3Event,
  resource: string,
  payload: unknown,
  cacheStatus?: string,
) {
  const metrics = getRequestDataMetrics(event)
  const resolvedCacheStatus =
    cacheStatus
    ?? String(getResponseHeader(event, 'x-bootstrap-cache') ?? 'BYPASS')
  const serializeStartedAt = performance.now()
  const responseBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength
  const serializeDuration = performance.now() - serializeStartedAt
  metrics.resources.set(resource, responseBytes)
  metrics.phases.serialize = (metrics.phases.serialize ?? 0) + serializeDuration
  metrics.finalized = true
  applyMetricHeaders(event, metrics, resolvedCacheStatus)
  return payload
}

export function finalizeTrackedRequestMetrics(event: H3Event, responseBody: unknown) {
  const metrics = metricsByEvent.get(event)
  if (!metrics || metrics.finalized) return

  if (metrics.resources.size === 0 && responseBody !== undefined) {
    const serialized = typeof responseBody === 'string'
      ? responseBody
      : JSON.stringify(responseBody)
    metrics.resources.set(event.path, new TextEncoder().encode(serialized).byteLength)
  }

  metrics.finalized = true
  const response = (event as H3Event & {
    node?: { res?: { headersSent?: boolean; writableEnded?: boolean } }
  }).node?.res
  if (response?.headersSent || response?.writableEnded) {
    return
  }
  applyMetricHeaders(
    event,
    metrics,
    String(getResponseHeader(event, 'x-bootstrap-cache') ?? 'BYPASS'),
  )
}

function applyMetricHeaders(
  event: H3Event,
  metrics: RequestDataMetrics,
  cacheStatus: string,
) {
  const responseBytes = [...metrics.resources.values()].reduce((total, bytes) => total + bytes, 0)
  const totalDuration = performance.now() - metrics.startedAt
  setHeader(event, 'x-request-id', metrics.requestId)
  setHeader(event, 'x-data-cache', cacheStatus)
  setHeader(event, 'x-attempt-count', '1')
  setHeader(event, 'x-d1-query-count', String(metrics.statementCount))
  setHeader(event, 'x-d1-batch-count', String(metrics.batchRoundTrips))
  setHeader(event, 'x-d1-rows-read', String(metrics.rowsRead))
  setHeader(event, 'x-d1-rows-written', String(metrics.rowsWritten))
  setHeader(event, 'x-d1-duration-ms', metrics.d1DurationMs.toFixed(2))
  setHeader(event, 'x-response-bytes', String(responseBytes))
  setHeader(event, 'x-total-duration-ms', totalDuration.toFixed(2))
  const phaseTimings = Object.entries(metrics.phases).map(
    ([name, duration]) => `${name};dur=${duration.toFixed(2)}`,
  )
  setHeader(event, 'server-timing', [
    ...phaseTimings,
    `d1;dur=${metrics.d1DurationMs.toFixed(2)}`,
    `total;dur=${totalDuration.toFixed(2)}`,
  ].join(', '))
}

export async function flushRequestMetrics(event: HTTPEvent, response: Response) {
  const metrics = metricsByEvent.get(event)
  if (!metrics) return

  // h3 holds the response until this hook settles, and an event stream such as
  // MCP's subscriptions/listen never ends: reading it held the stream from the
  // client until the isolate died. Its size does not exist yet, so none is logged.
  const streamed = response.headers.get('content-type')?.includes('text/event-stream') ?? false
  if (metrics.resources.size === 0 && response.status !== 101 && !streamed) {
    const serialized = await response.clone().text()
    metrics.resources.set(new URL(event.req.url).pathname, new TextEncoder().encode(serialized).byteLength)
  }
  if (!metrics.finalized) {
    metrics.finalized = true
  }
  const cacheStatus = String(response.headers.get('x-bootstrap-cache') ?? 'BYPASS')
  const responseBytes = streamed ? null : [...metrics.resources.values()].reduce((total, bytes) => total + bytes, 0)
  const status = response.status
  const errorCode = status >= 400 ? `HTTP_${status}` : null
  const totalDuration = performance.now() - metrics.startedAt
  // These headers decorate a response that has already succeeded, so a response
  // whose headers are immutable must not be turned into a failure over them. The
  // reason goes into the one metrics line below rather than a console.warn of its
  // own, so the record of the request says it is missing its headers and why.
  let metricHeadersError: string | null = null
  if (response.status !== 101 && !response.headers.has('x-d1-query-count')) {
    try {
      response.headers.set('x-request-id', metrics.requestId)
      response.headers.set('x-d1-query-count', String(metrics.statementCount))
      response.headers.set('x-d1-batch-count', String(metrics.batchRoundTrips))
      response.headers.set('x-d1-duration-ms', metrics.d1DurationMs.toFixed(2))
      response.headers.set('x-total-duration-ms', totalDuration.toFixed(2))
    } catch (error) {
      metricHeadersError = error instanceof Error ? error.message : String(error)
    }
  }
  console.info('[data-request]', JSON.stringify({
    metricHeadersError,
    telemetryErrors: metrics.telemetryErrors,
    requestId: metrics.requestId,
    rayId: event.req.headers.get('cf-ray'),
    phases: Object.fromEntries(Object.entries(metrics.phases).map(([name, duration]) => [name, Number(duration.toFixed(2))])),
    d1SqlDurationMs: Number(metrics.d1SqlDurationMs.toFixed(2)),
    d1MetaCount: metrics.d1MetaCount,
    d1Colos: [...metrics.d1Colos],
    resource: [...metrics.resources.keys()].join(',') || new URL(event.req.url).pathname,
    cacheStatus,
    attemptCount: 1,
    statementCount: metrics.statementCount,
    batchRoundTrips: metrics.batchRoundTrips,
    rowsRead: metrics.rowsRead,
    rowsWritten: metrics.rowsWritten,
    d1DurationMs: Number(metrics.d1DurationMs.toFixed(2)),
    responseBytes,
    totalDurationMs: Number(totalDuration.toFixed(2)),
    status,
    errorCode,
  }))
}
