export interface ErrorTelemetryEntry {
  name: string
  message: string
  code?: string
  status?: number
  stack?: string
  request_id?: string
  ray_id?: string
}

export const ERROR_TELEMETRY_LIMITS = { depth: 4, name: 100, message: 1000, code: 100, stack: 4000 } as const
export const BROWSER_ERROR_PATH = '/api/browser-errors'
export const BROWSER_ERROR_LIMITS = { bodyBytes: 24 * 1024, pagePath: 2048, context: 200 } as const
export const BROWSER_ERROR_SOURCES = ['app_error', 'vue_error', 'chunk_error', 'browser_error', 'unhandled_rejection'] as const
export type BrowserErrorSource = typeof BROWSER_ERROR_SOURCES[number]
export interface BrowserErrorReport {
  event_id: string
  source: BrowserErrorSource
  page_path: string
  context?: string
  error_chain: ErrorTelemetryEntry[]
}

const truncationMarker = '…[truncated]'

export function redactErrorText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\b[rs]k_(?:test|live)_[A-Za-z0-9_*]+/g, '[key redacted]')
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [redacted]')
    .replace(/\b(password|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1: [redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url redacted]')
    .replace(/\/[^\s<>"']*\?[^\s<>"']*/g, '[url redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/\nparams:[\s\S]*$/i, '\nparams: [redacted]')
  if (redacted.length <= maxLength) return redacted
  let head = redacted.slice(0, Math.max(0, maxLength - truncationMarker.length))
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  return head + truncationMarker.slice(0, Math.max(0, maxLength))
}

export function serializeBrowserErrorReport(report: BrowserErrorReport): string {
  const bounded: BrowserErrorReport = {
    ...report,
    page_path: redactErrorText(report.page_path, BROWSER_ERROR_LIMITS.pagePath),
    ...(report.context ? { context: redactErrorText(report.context, BROWSER_ERROR_LIMITS.context) } : {}),
    error_chain: report.error_chain.map(entry => ({
      ...entry,
      name: redactErrorText(entry.name, ERROR_TELEMETRY_LIMITS.name),
      message: redactErrorText(entry.message, ERROR_TELEMETRY_LIMITS.message),
      ...(entry.code ? { code: redactErrorText(entry.code, ERROR_TELEMETRY_LIMITS.code) } : {}),
      ...(entry.stack ? { stack: redactErrorText(entry.stack, ERROR_TELEMETRY_LIMITS.stack) } : {}),
    })),
  }
  const encoder = new TextEncoder()
  let body = JSON.stringify(bounded)
  while (encoder.encode(body).byteLength > BROWSER_ERROR_LIMITS.bodyBytes) {
    let largest: { entry: ErrorTelemetryEntry, field: 'message' | 'stack', bytes: number } | undefined
    for (const entry of bounded.error_chain) {
      for (const field of ['message', 'stack'] as const) {
        const value = entry[field]
        if (!value || value.length <= truncationMarker.length) continue
        const bytes = encoder.encode(JSON.stringify(value)).byteLength
        if (!largest || bytes > largest.bytes) largest = { entry, field, bytes }
      }
    }
    if (!largest) throw new Error('Browser error report metadata exceeds the body limit')
    const value = largest.entry[largest.field]!
    largest.entry[largest.field] = redactErrorText(value, Math.max(truncationMarker.length, Math.floor(value.length / 2)))
    body = JSON.stringify(bounded)
  }
  return body
}

export function errorChainForTelemetry(error: unknown): ErrorTelemetryEntry[] {
  const chain: ErrorTelemetryEntry[] = []
  const seen = new Set<unknown>()
  let current: unknown = error

  while ((chain.length === 0 || current != null) && !seen.has(current) && chain.length < ERROR_TELEMETRY_LIMITS.depth) {
    seen.add(current)
    const record = typeof current === 'object' || typeof current === 'function' ? current : null
    const statusMessage = record ? Reflect.get(record, 'statusMessage') : undefined
    const errorMessage = record ? Reflect.get(record, 'message') : undefined
    const name = record ? Reflect.get(record, 'name') : undefined
    const data = record ? Reflect.get(record, 'data') : undefined
    const code = record ? Reflect.get(record, 'code') ?? (data && typeof data === 'object' ? Reflect.get(data, 'code') : undefined) : undefined
    const status = record ? Reflect.get(record, 'status') ?? Reflect.get(record, 'statusCode') : undefined
    const stack = record ? Reflect.get(record, 'stack') : undefined
    const requestId = record ? Reflect.get(record, 'requestId') ?? Reflect.get(record, 'request_id') : undefined
    const response = record ? Reflect.get(record, 'response') : undefined
    const rayId = record ? Reflect.get(record, 'ray_id') ?? response?.headers?.get?.('cf-ray') : undefined
    const message = typeof statusMessage === 'string' && statusMessage.length > 0
      ? statusMessage
      : typeof errorMessage === 'string'
        ? errorMessage
        : record
          ? ''
          : String(current)
    const entry: ErrorTelemetryEntry = {
      name: redactErrorText(typeof name === 'string' ? name : typeof current, ERROR_TELEMETRY_LIMITS.name),
      message: redactErrorText(message, ERROR_TELEMETRY_LIMITS.message),
    }
    if (typeof code === 'string' || typeof code === 'number') {
      entry.code = redactErrorText(String(code), ERROR_TELEMETRY_LIMITS.code)
    }
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      entry.status = status
    }
    if (typeof stack === 'string') {
      entry.stack = redactErrorText(stack, ERROR_TELEMETRY_LIMITS.stack)
    }
    if (typeof requestId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(requestId)) entry.request_id = requestId
    if (typeof rayId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(rayId)) entry.ray_id = rayId
    chain.push(entry)
    current = record ? Reflect.get(record, 'cause') : undefined
  }

  return chain
}

export function describeErrorForTelemetry(error: unknown, maxLength = 1000): string {
  const messages = errorChainForTelemetry(error)
    .map(entry => entry.message)
    .filter((message, index, all) => message && all.indexOf(message) === index)
  const combined = messages.join('\nCaused by: ') || 'Unknown error'
  if (combined.length <= maxLength) return combined

  const marker = '\n…[middle truncated]…\n'
  const available = Math.max(0, maxLength - marker.length)
  const headLength = Math.ceil(available / 2)
  return combined.slice(0, headLength) + marker + combined.slice(-Math.floor(available / 2))
}
