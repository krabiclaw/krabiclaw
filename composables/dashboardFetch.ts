import type { FetchOptions } from 'ofetch'
import type { MaybeRefOrGetter } from 'vue'
import { $fetch } from 'ofetch'

type DashboardFetchOptions<T> = Omit<FetchOptions<'json'>, 'method'> & {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  validate: Validator<T>
  coalesceKey?: string
}

type DashboardRequestOptions = Omit<FetchOptions<'json'>, 'method'> & {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
}

export interface DashboardRequestScope {
  orgSlug: string
}

const dashboardInFlightReads = new Map<string, Promise<unknown>>()

const stableValue = (value: unknown): string => {
  if (value === undefined) return ''
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(',')}}`
}

async function executeApiFetch<T>(
  request: string,
  options: DashboardFetchOptions<T>,
  headers: Headers,
): Promise<T> {
  const method = options.method ?? 'GET'
  const { validate, coalesceKey, method: _method, ...fetchOptions } = options
  const run = async () => {
    let requestId: string | null = null
    try {
      const requestOptions: DashboardRequestOptions = {
        ...fetchOptions,
        method,
        headers,
        retry: 0,
      }
      const response = await $fetch.raw<unknown>(request, requestOptions)
      requestId = response.headers.get('x-request-id')
      const value = response._data
      if (!validate(value)) {
        throw new ApiClientError(`Invalid response from ${request}: API response did not match its contract`, 502, 'INVALID_API_RESPONSE', requestId)
      }
      return value as T
    } catch (error) {
      fetchOptions.signal?.throwIfAborted()
      const failure = normalizeApiError(error, 'Dashboard API request failed')
      console.error('[Dashboard API]', { request, method, statusCode: failure.statusCode, code: failure.code, requestId: failure.requestId ?? requestId, message: failure.message })
      throw failure
    }
  }

  if (method !== 'GET' || fetchOptions.signal) return await run()
  // Coalescing is browser-only to prevent SSR cross-request data leakage.
  // In server context, every request must stand alone without shared state.
  if (import.meta.server) return await run()
  const key = coalesceKey ?? `${request}:${stableValue(fetchOptions.query)}:${stableValue([...headers])}`
  const existing = dashboardInFlightReads.get(key) as Promise<T> | undefined
  if (existing) return await existing
  const pending = run().finally(() => {
    if (dashboardInFlightReads.get(key) === pending) dashboardInFlightReads.delete(key)
  })
  dashboardInFlightReads.set(key, pending)
  return await pending
}

/**
 * The only browser transport for route-scoped dashboard data. Scope is read
 * from the route at the call site and is always sent explicitly to the API.
 */
export async function dashboardFetch<T>(
  request: string,
  scope: DashboardRequestScope,
  options: DashboardFetchOptions<T>,
): Promise<T> {
  if (!scope.orgSlug) {
    throw createError({ statusCode: 400, statusMessage: 'Dashboard organization scope is required' })
  }
  // `request` is always a relative path. `ofetch` is imported directly here
  // (not Nuxt's magic `$fetch`), so it has no implicit notion of the current
  // origin. That's harmless in a real browser (relative fetches resolve
  // against the page URL) but fatal during SSR on Cloudflare Workers, whose
  // `fetch()` has no page context and throws "Invalid URL" on a bare path.
  // `useRequestURL()` must be read synchronously (before any `await`) so it
  // still has access to the current request/window context.
  const baseURL = useRequestURL().origin
  const headers = buildDashboardRequestHeaders(
    Object.fromEntries(new Headers(options.headers as HeadersInit).entries()),
  )
  // Route-derived org/site must be authoritative — applied last so a caller-supplied
  // query can never override which tenant this request is scoped to. A caller can
  // still narrow further (e.g. activity.vue's site filter) as long as the route
  // itself doesn't already have that value to assert.
  const scopedOptions: DashboardFetchOptions<T> = {
    ...options,
    baseURL,
    query: { ...(options.query as Record<string, unknown> | undefined), ...buildDashboardRequestQuery(scope) },
  }
  return await executeApiFetch(request, scopedOptions, headers)
}

export function useDashboardRouteScope(route: MaybeRefOrGetter<ReturnType<typeof useRoute>> = useRoute()) {
  return computed<DashboardRequestScope | null>(() => {
    const params = toValue(route).params
    const orgSlug = typeof params.orgSlug === 'string' ? params.orgSlug : null
    if (!orgSlug) return null
    return { orgSlug }
  })
}

export function useDashboardApi(scope = useDashboardRouteScope()) {
  return async <T>(request: string, options: DashboardFetchOptions<T>) => {
    const resolved = unref(scope)
    if (!resolved) {
      throw createError({ statusCode: 400, statusMessage: 'Dashboard organization scope is required' })
    }
    return await dashboardFetch<T>(request, resolved, options)
  }
}

export async function applicationFetch<T>(
  request: string,
  options: DashboardFetchOptions<T>,
): Promise<T> {
  // See the comment in dashboardFetch above: a bare relative path is only
  // resolvable during SSR when we give ofetch an explicit baseURL.
  const baseURL = useRequestURL().origin
  const headers = new Headers(options.headers as HeadersInit)
  if (import.meta.server) {
    for (const [key, value] of Object.entries(useRequestHeaders(['cookie']))) {
      if (value) headers.set(key, value)
    }
  }
  return await executeApiFetch(request, { ...options, baseURL }, headers)
}
