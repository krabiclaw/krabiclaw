import type { FetchOptions } from 'ofetch'
import { $fetch } from 'ofetch'

export class ApiClientError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly requestId: string | null
  readonly data: Record<string, unknown>
  override readonly cause?: unknown

  constructor(
    message: string,
    statusCode: number,
    code: string,
    requestId: string | null,
    data: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.statusCode = statusCode
    this.code = code
    this.requestId = requestId
    this.data = data
    this.cause = cause
  }
}

export type Validator<T> = (value: unknown) => value is T
type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type ApiRequestOptions = Omit<FetchOptions<'json'>, 'method'> & { method?: ApiMethod }

const inFlightReads = new Map<string, Promise<unknown>>()

function sanitizeApiData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const sanitized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (
      item === null
      || typeof item === 'string'
      || typeof item === 'number'
      || typeof item === 'boolean'
      || (Array.isArray(item) && item.every(entry =>
        entry === null || ['string', 'number', 'boolean'].includes(typeof entry) || isRecord(entry),
      ))
      || isRecord(item)
    ) {
      sanitized[key] = item
    }
  }
  return sanitized
}

export function normalizeApiError(error: unknown, fallbackMessage = 'API request failed'): ApiClientError {
  if (error instanceof ApiClientError) return error
  const candidate = isRecord(error) || (error && typeof error === 'object') ? (error as {
    statusCode?: number
    status?: number
    message?: string
    data?: unknown
    response?: { status?: number; headers?: Headers }
  }) : {}
  const data = sanitizeApiData(candidate.data)
  const structuredError = isRecord(data.error) ? data.error : null
  const topLevelError = typeof data.error === 'string' ? data.error : null
  const domainData = isRecord(data.data) ? data.data : data
  const statusCode = candidate.statusCode ?? candidate.status ?? candidate.response?.status ?? 500
  return new ApiClientError(
    (typeof structuredError?.message === 'string' ? structuredError.message : null)
      ?? topLevelError
      ?? (typeof data.message === 'string' ? data.message : null)
      ?? (typeof data.statusMessage === 'string' ? data.statusMessage : null)
      ?? candidate.message
      ?? fallbackMessage,
    statusCode,
    (typeof structuredError?.code === 'string' ? structuredError.code : null)
      ?? (typeof domainData.code === 'string' ? domainData.code : null)
      ?? 'API_REQUEST_FAILED',
    (typeof structuredError?.requestId === 'string' ? structuredError.requestId : null)
      ?? candidate.response?.headers?.get('x-request-id')
      ?? null,
    data,
    error,
  )
}

async function request<T>(
  url: string,
  options: {
    method?: ApiMethod
    headers?: HeadersInit
    body?: unknown
    query?: Record<string, unknown>
    signal?: AbortSignal
    validate: Validator<T>
    coalesceKey?: string
  },
): Promise<T> {
  const method = options.method ?? 'GET'
  const run = async () => {
    try {
      const requestOptions: ApiRequestOptions = {
        method,
        headers: options.headers,
        body: options.body as Record<string, unknown> | BodyInit | null | undefined,
        query: options.query,
        signal: options.signal,
        retry: 0,
      }
      const value = await $fetch<unknown>(url, requestOptions)
      if (!options.validate(value)) {
        throw new ApiClientError('API response did not match its contract', 502, 'INVALID_API_RESPONSE', null)
      }
      return value
    } catch (error) {
      throw normalizeApiError(error)
    }
  }

  // A request with a caller-owned signal cannot safely share cancellation
  // ownership with another consumer. Coalescing is client-only to prevent
  // SSR cross-request data leakage.
  if (method !== 'GET' || !options.coalesceKey || options.signal || import.meta.server) return await run()
  const existing = inFlightReads.get(options.coalesceKey) as Promise<T> | undefined
  if (existing) return await existing
  const pending = run().finally(() => {
    if (inFlightReads.get(options.coalesceKey!) === pending) {
      inFlightReads.delete(options.coalesceKey!)
    }
  })
  inFlightReads.set(options.coalesceKey, pending)
  return await pending
}

export function publicApiRequest<T>(
  url: string,
  options: {
    validate: Validator<T>
    signal?: AbortSignal
    coalesceKey?: string
    query?: Record<string, unknown>
    headers?: HeadersInit
  },
) {
  return request(url, options)
}

export function publicApiMutation<T>(
  url: string,
  options: {
    method: Exclude<ApiMethod, 'GET'>
    body?: unknown
    query?: Record<string, unknown>
    headers?: HeadersInit
    signal?: AbortSignal
    validate: Validator<T>
  },
) {
  return request(url, options)
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const hasRecordConfig = (
  value: unknown,
): value is { config: Record<string, unknown> } =>
  isRecord(value) && isRecord(value.config)
