import { HTTPError } from 'nitro'
import { ChannexDataError, object, resource, type JsonRecord, type Resource } from './data'

/**
 * The Channex API, as KrabiClaw calls it: one platform key, JSON:API bodies,
 * and no wildcard passthrough. A failed write that Channex may still have
 * applied is `uncertain`; callers persist where they were and never retry it
 * blindly.
 */

export interface ChannexEnv {
  CHANNEX_BASE_URL?: string
  CHANNEX_API_KEY?: string
  /** The current operation's deadline; omitted for callers without a bounded background slice. */
  requestSignal?: AbortSignal
}

/**
 * A Channex call that failed, answered as KrabiClaw's coded error: 502 for a
 * provider failure, 504 when the background slice ended first, 500 when
 * KrabiClaw is not configured to call Channex. `providerStatus` is Channex's
 * own status (or the one KrabiClaw assigned a failure it detected), which
 * decides whether a failure is worth retrying; `data.provider_status` carries
 * it to the caller.
 */
export class ChannexError extends HTTPError<{ code: string; field: string; resource?: string; uncertain: boolean; provider_status: number }> {
  readonly providerStatus: number
  readonly uncertain: boolean
  /** Only an unsent or explicitly refused write proves a pending mutation did not apply. */
  readonly writeRefused: boolean
  declare readonly data: { code: string; field: string; resource?: string; uncertain: boolean; provider_status: number }
  constructor(message: string, providerStatus: number, uncertain: boolean, context?: { code: string; field: string; resource?: string }, writeRefused = false) {
    const coded = context ?? { code: 'CHANNEX_REQUEST_FAILED', field: 'provider_response' }
    const status = coded.code === 'SYNC_SLICE_ENDED' ? 504 : coded.code === 'CHANNEX_NOT_CONFIGURED' ? 500 : 502
    super({ status, message, data: { ...coded, uncertain, provider_status: providerStatus } })
    this.providerStatus = providerStatus
    this.uncertain = uncertain
    this.writeRefused = writeRefused
  }
}

/**
 * Channex answers 422 with Airbnb's own `error_code` when Airbnb failed behind
 * it ("Airbnb may be undergoing maintenance … Please try again"): that is
 * Airbnb unavailable, not a refusal of the request. Airbnb's message, when it
 * is one.
 */
function airbnbUnavailable(status: number, text: string, uncertain: boolean): string | null {
  if (status !== 422) return null
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new ChannexError(`Channex answered 422 without JSON: ${error instanceof Error ? error.message : String(error)}`, status, uncertain, { code: 'INVALID_PROVIDER_RESPONSE', field: 'errors' })
  }
  const errors = provided(() => object(object(body, 'Channex 422 response').errors, 'Channex 422 errors'), uncertain, { field: 'errors' })
  const { error_code: code, error_message: message } = errors as { error_code?: unknown; error_message?: unknown }
  if (code !== undefined && (typeof code !== 'number' || !Number.isInteger(code))) throw new ChannexError('Channex returned an invalid upstream error code', status, uncertain, { code: 'INVALID_PROVIDER_RESPONSE', field: 'errors.error_code' })
  return typeof code === 'number' && code >= 500 ? (typeof message === 'string' && message.trim() ? message.trim() : `Airbnb answered ${code}`) : null
}

// Statuses that prove Channex refused a write before applying it.
const REFUSED = new Set([400, 401, 403, 404, 422, 429])
const MAX_RESPONSE_BYTES = 10_000_000

export async function channexRequest(env: ChannexEnv, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: JsonRecord): Promise<JsonRecord> {
  const baseUrl = env.CHANNEX_BASE_URL?.trim().replace(/\/$/, '')
  const apiKey = env.CHANNEX_API_KEY?.trim()
  if (!baseUrl || !apiKey) throw new ChannexError('CHANNEX_BASE_URL and CHANNEX_API_KEY are required', 500, false, { code: 'CHANNEX_NOT_CONFIGURED', field: 'CHANNEX_API_KEY' }, method !== 'GET')
  const label = `${method} ${path.split('?')[0]}`
  if (env.requestSignal?.aborted) throw new ChannexError(`The background slice ended before ${label} was sent`, 504, false, { code: 'SYNC_SLICE_ENDED', field: 'background_slice' }, method !== 'GET')
  let response: Response | undefined
  let text: string
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'user-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: env.requestSignal,
    })
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      const refused = method !== 'GET' && response.status !== 422 && REFUSED.has(response.status)
      throw new ChannexError(`Channex's answer to ${label} exceeds 10 MB`, 502, method !== 'GET' && !refused, undefined, refused)
    }
    text = await response.text()
  } catch (error) {
    if (error instanceof ChannexError) throw error
    const refused = method !== 'GET' && response !== undefined && response.status !== 422 && REFUSED.has(response.status)
    if (env.requestSignal?.aborted) throw new ChannexError(`The background slice ended while waiting for ${label}`, 504, method !== 'GET' && !refused, { code: 'SYNC_SLICE_ENDED', field: 'background_slice' }, refused)
    throw new ChannexError(`Channex could not be reached for ${label}: ${error instanceof Error ? error.message : String(error)}`, 502, method !== 'GET' && !refused, undefined, refused)
  }
  if (!response.ok) {
    const refused = method !== 'GET' && REFUSED.has(response.status)
    const airbnb = airbnbUnavailable(response.status, text, method !== 'GET')
    if (airbnb) throw new ChannexError(`Airbnb did not answer ${label} through Channex: ${airbnb}`, response.status, method !== 'GET', { code: 'AIRBNB_UNAVAILABLE', field: 'provider_response' })
    throw new ChannexError(`Channex answered ${response.status} to ${label}: ${text.slice(0, 500)}`, response.status, method !== 'GET' && !refused, undefined, refused)
  }
  if (text.length > MAX_RESPONSE_BYTES) throw new ChannexError(`Channex's answer to ${label} exceeds 10 MB`, 502, method !== 'GET')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ChannexError(`Channex answered ${label} without JSON: ${error instanceof Error ? error.message : String(error)}`, 502, method !== 'GET')
  }
  return provided(() => object(parsed, `Channex response to ${label}`), method !== 'GET')
}

/** A provider shape error becomes a 502; for a write it is uncertain, because Channex accepted it. */
function provided<T>(read: () => T, uncertain = false, context: { field: string; resource?: string } = { field: 'response' }): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof ChannexDataError) throw new ChannexError(`Channex returned an invalid response: ${error.message}`, 502, uncertain, { code: 'INVALID_PROVIDER_RESPONSE', ...context })
    throw error
  }
}

export async function channexGet(env: ChannexEnv, path: string, type: string): Promise<Resource> {
  const body = await channexRequest(env, path)
  return provided(() => resource(body.data, type), false, { field: 'data', resource: type })
}

export async function channexCreate(env: ChannexEnv, path: string, body: JsonRecord, type: string): Promise<Resource> {
  const result = await channexRequest(env, path, 'POST', body)
  return provided(() => resource(result.data, type), true, { field: 'data', resource: type })
}

/** Every page of a collection, by Channex's `meta.total`. */
export async function channexList(env: ChannexEnv, path: string, type: string, filter: Record<string, string> = {}): Promise<Resource[]> {
  const rows: Resource[] = []
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ ...filter, 'pagination[page]': String(page), 'pagination[limit]': '100' })
    const body = await channexRequest(env, `${path}?${query}`)
    if (!Array.isArray(body.data)) throw new ChannexError(`Channex returned no list for ${path}`, 502, false, { code: 'INVALID_PROVIDER_RESPONSE', field: 'data', resource: type })
    rows.push(...body.data.map(row => provided(() => resource(row, type), false, { field: 'data', resource: type })))
    // The Applications API documents an unpaginated collection with no meta.
    if (path === '/applications/installed') return rows
    const meta = provided(() => object(body.meta, 'pagination meta'), false, { field: 'meta', resource: type })
    if (typeof meta.total !== 'number' || !Number.isInteger(meta.total) || meta.total < 0) throw new ChannexError(`Channex returned no total for ${path}`, 502, false, { code: 'INVALID_PROVIDER_RESPONSE', field: 'meta.total', resource: type })
    if (rows.length >= meta.total) return rows
    if (body.data.length === 0) throw new ChannexError(`Channex returned an empty page before the total for ${path}`, 502, false, { code: 'INVALID_PROVIDER_RESPONSE', field: 'data', resource: type })
  }
}
