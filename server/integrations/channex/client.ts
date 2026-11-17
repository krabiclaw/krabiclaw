import { HTTPError } from 'nitro'
import { ChannexDataError, object, resource, type JsonRecord, type Resource } from './data'

/**
 * The Channex API, as Blawby calls it: one platform key, JSON:API bodies,
 * and no wildcard passthrough. A call that fails throws a ChannexError.
 */

export interface ChannexEnv {
  CHANNEX_BASE_URL?: string
  CHANNEX_API_KEY?: string
}

/**
 * A Channex call that failed, answered as Blawby's coded error: 502 for a
 * provider failure, 500 when Blawby is not configured to call Channex.
 * `providerStatus` is Channex's own status (or the one Blawby assigned a
 * failure it detected); `data.provider_status` carries it to the caller.
 */
export class ChannexError extends HTTPError<{ code: string; field: string; resource?: string; provider_status: number }> {
  readonly providerStatus: number
  declare readonly data: { code: string; field: string; resource?: string; provider_status: number }
  constructor(message: string, providerStatus: number, context?: { code: string; field: string; resource?: string }) {
    const coded = context ?? { code: 'CHANNEX_REQUEST_FAILED', field: 'provider_response' }
    super({ status: coded.code === 'CHANNEX_NOT_CONFIGURED' ? 500 : 502, message, data: { ...coded, provider_status: providerStatus } })
    this.providerStatus = providerStatus
  }
}

const MAX_RESPONSE_BYTES = 10_000_000

export async function channexRequest(env: ChannexEnv, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: JsonRecord): Promise<JsonRecord> {
  const baseUrl = env.CHANNEX_BASE_URL?.trim().replace(/\/$/, '')
  const apiKey = env.CHANNEX_API_KEY?.trim()
  if (!baseUrl || !apiKey) throw new ChannexError('CHANNEX_BASE_URL and CHANNEX_API_KEY are required', 500, { code: 'CHANNEX_NOT_CONFIGURED', field: 'CHANNEX_API_KEY' })
  const label = `${method} ${path.split('?')[0]}`
  let response: Response
  let text: string
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'user-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new ChannexError(`Channex's answer to ${label} exceeds 10 MB`, 502)
    text = await response.text()
  } catch (error) {
    if (error instanceof ChannexError) throw error
    throw new ChannexError(`Channex could not be reached for ${label}: ${error instanceof Error ? error.message : String(error)}`, 502)
  }
  if (!response.ok) throw new ChannexError(`Channex answered ${response.status} to ${label}: ${text.slice(0, 500)}`, response.status)
  if (text.length > MAX_RESPONSE_BYTES) throw new ChannexError(`Channex's answer to ${label} exceeds 10 MB`, 502)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ChannexError(`Channex answered ${label} without JSON: ${error instanceof Error ? error.message : String(error)}`, 502)
  }
  return provided(() => object(parsed, `Channex response to ${label}`))
}

/** A provider shape error becomes a 502. */
function provided<T>(read: () => T, context: { field: string; resource?: string } = { field: 'response' }): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof ChannexDataError) throw new ChannexError(`Channex returned an invalid response: ${error.message}`, 502, { code: 'INVALID_PROVIDER_RESPONSE', ...context })
    throw error
  }
}

export async function channexGet(env: ChannexEnv, path: string, type: string): Promise<Resource> {
  const body = await channexRequest(env, path)
  return provided(() => resource(body.data, type), { field: 'data', resource: type })
}

export async function channexCreate(env: ChannexEnv, path: string, body: JsonRecord, type: string): Promise<Resource> {
  const result = await channexRequest(env, path, 'POST', body)
  return provided(() => resource(result.data, type), { field: 'data', resource: type })
}

/** Every page of a collection, by Channex's `meta.total`. */
export async function channexList(env: ChannexEnv, path: string, type: string, filter: Record<string, string> = {}): Promise<Resource[]> {
  const rows: Resource[] = []
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ ...filter, 'pagination[page]': String(page), 'pagination[limit]': '100' })
    const body = await channexRequest(env, `${path}?${query}`)
    if (!Array.isArray(body.data)) throw new ChannexError(`Channex returned no list for ${path}`, 502, { code: 'INVALID_PROVIDER_RESPONSE', field: 'data', resource: type })
    rows.push(...body.data.map(row => provided(() => resource(row, type), { field: 'data', resource: type })))
    // The Applications API documents an unpaginated collection with no meta.
    if (path === '/applications/installed') return rows
    const meta = provided(() => object(body.meta, 'pagination meta'), { field: 'meta', resource: type })
    if (typeof meta.total !== 'number' || !Number.isInteger(meta.total) || meta.total < 0) throw new ChannexError(`Channex returned no total for ${path}`, 502, { code: 'INVALID_PROVIDER_RESPONSE', field: 'meta.total', resource: type })
    if (rows.length >= meta.total) return rows
    if (body.data.length === 0) throw new ChannexError(`Channex returned an empty page before the total for ${path}`, 502, { code: 'INVALID_PROVIDER_RESPONSE', field: 'data', resource: type })
  }
}
