export interface ErrorTelemetryEntry {
  name: string
  message: string
  code?: string
  status?: number
  stack?: string
}

const MAX_ERROR_DEPTH = 4
const MAX_ERROR_MESSAGE_LENGTH = 1000
const MAX_ERROR_STACK_LENGTH = 4000

function redactErrorText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\b[rs]k_(?:test|live)_[A-Za-z0-9_*]+/g, '[key redacted]')
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url redacted]')
    .replace(/\nparams:[\s\S]*$/i, '\nparams: [redacted]')
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength)}…[truncated]`
}

export function errorChainForTelemetry(error: unknown): ErrorTelemetryEntry[] {
  const chain: ErrorTelemetryEntry[] = []
  const seen = new Set<unknown>()
  let current: unknown = error

  while (current != null && !seen.has(current) && chain.length < MAX_ERROR_DEPTH) {
    seen.add(current)
    const record = typeof current === 'object' || typeof current === 'function' ? current : null
    const statusMessage = record ? Reflect.get(record, 'statusMessage') : undefined
    const errorMessage = record ? Reflect.get(record, 'message') : undefined
    const name = record ? Reflect.get(record, 'name') : undefined
    const data = record ? Reflect.get(record, 'data') : undefined
    const code = record ? Reflect.get(record, 'code') ?? (data && typeof data === 'object' ? Reflect.get(data, 'code') : undefined) : undefined
    const status = record ? Reflect.get(record, 'status') ?? Reflect.get(record, 'statusCode') : undefined
    const stack = record ? Reflect.get(record, 'stack') : undefined
    const message = typeof statusMessage === 'string' && statusMessage.length > 0
      ? statusMessage
      : typeof errorMessage === 'string'
        ? errorMessage
        : record
          ? ''
          : String(current)
    const entry: ErrorTelemetryEntry = {
      name: typeof name === 'string' ? name : typeof current,
      message: redactErrorText(message, MAX_ERROR_MESSAGE_LENGTH),
    }
    if (typeof code === 'string' || typeof code === 'number') {
      entry.code = String(code)
    }
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      entry.status = status
    }
    if (typeof stack === 'string') {
      entry.stack = redactErrorText(stack, MAX_ERROR_STACK_LENGTH)
    }
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
