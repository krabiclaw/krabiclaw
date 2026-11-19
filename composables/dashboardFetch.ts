import { dashboardProductId, rendersProductArrival, rendersProductCreation, rendersCatalogEditor, rendersWebsiteDocument, websiteBlogPost, websiteSocialPost } from '~/utils/dashboard-document'
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
      // One line of text: a browser log that prints an object as [object Object] hides which call failed and why.
      console.error(`[Dashboard API] ${method} ${request} → ${failure.statusCode} ${failure.code ?? 'ERROR'}: ${failure.message} (request ${failure.requestId ?? requestId})`)
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
  const postDocument = import.meta.server && (() => {
    const url = useRequestURL()
    const panel = url.pathname.replace(/^\/dashboard\/[^/]+/, '')
    return websiteSocialPost(panel) && rendersWebsiteDocument(panel, Object.fromEntries(url.searchParams))
  })()
  if (import.meta.server && (!options.method || options.method === 'GET') && (
    (/^\/api\/editor\/organizations\/[^/]+\/(?:locations\/[^/]+\/)?products\/[^/]+(?:\/availability)?$/.test(request)
      && Boolean(dashboardProductId(useRequestURL().pathname.replace(/^\/dashboard\/[^/]+/, ''))))
    || (/^\/api\/editor\/organizations\/[^/]+\/products$/.test(request) && options.query?.include === 'collections' && rendersCatalogEditor(useRequestURL().pathname.replace(/^\/dashboard\/[^/]+/, '')))
    || (/^\/api\/organizations\/[^/]+\/members\/scheduling$/.test(request) && options.query?.view === 'assignment')
    || /^\/api\/messages\/listings\/[^/]+\/participants$/.test(request)
    || (request === '/api/dashboard/locations' && (rendersCatalogEditor(useRequestURL().pathname.replace(/^\/dashboard\/[^/]+/, '')) || /^\/dashboard\/[^/]+\/locations(?:\/|$)/.test(useRequestURL().pathname) && options.query?.status !== 'all' || rendersProductCreation(useRequestURL().pathname.replace(/^\/dashboard\/[^/]+/, ''), Object.fromEntries(useRequestURL().searchParams))))
    || (/^\/api\/organizations\/[^/]+\/domains$/.test(request) && /\/website\/preferences\/domains\/?$/.test(useRequestURL().pathname))
    || (/^\/api\/editor\/organizations\/[^/]+\/locales$/.test(request) && /\/website\/preferences\/localization\/?$/.test(useRequestURL().pathname))
    || (/^\/api\/dashboard\/stay-homes\/[^/]+$/.test(request) && rendersProductArrival(useRequestURL().pathname.replace(/^\/dashboard\/[^/]+/, ''), Object.fromEntries(useRequestURL().searchParams)))
    || (/^\/api\/organizations\/[^/]+\/billing\/homes$/.test(request) && /^\/dashboard\/[^/]+\/products\/[^/]+\/publication(?:\/|$)/.test(useRequestURL().pathname))
    || request === '/api/dashboard/agenda' || request === '/api/dashboard/bookings/calendar'
    || (request === '/api/dashboard/stay-homes' && options.query?.view === 'calendar')
    || (request === '/api/dashboard/payments' && (options.query?.view === 'performance' || options.query?.view === 'payouts'))
    || (request === '/api/dashboard/settings' && (options.query?.connections === '1' || options.query?.view === 'website'))
    || (/^\/api\/editor\/organizations\/[^/]+\/media$/.test(request) && /^\/dashboard\/[^/]+\/locations\/[^/]+\/photos\/?$/.test(useRequestURL().pathname))
    || /^\/api\/editor\/organizations\/[^/]+\/(?:reviews|blog\/[^/]+|posts|qa|locations\/[^/]+\/qa|pages\/[^/]+)$/.test(request)
      && (!request.endsWith('/blog/categories') || /\/website\/blog\/categories(?:\/|$)/.test(useRequestURL().pathname) || Boolean(websiteBlogPost(useRequestURL().pathname.replace(/^\/dashboard\/[^/]+/, ''))))
    || (postDocument && (request === '/api/integrations/social-connections' || request === '/api/dashboard/locations' && options.query?.organization === 'true'
      || /^\/api\/editor\/organizations\/[^/]+\/posts\/[^/]+$/.test(request)))
    || request === '/api/dashboard/integrations/google-calendar'
  )) {
    const provider = useRequestEvent()?.context.dashboardDocumentProvider as {
      read: (orgSlug: string, resource: string, query: Record<string, unknown>) => Promise<unknown>
    } | undefined
    if (!provider) throw createError({ statusCode: 502, statusMessage: 'Dashboard document reader is unavailable' })
    const value = await provider.read(scope.orgSlug, request, (options.query as Record<string, unknown> | undefined) ?? {})
    if (!options.validate(value)) throw createError({ statusCode: 502, statusMessage: 'Invalid dashboard document resource' })
    return value
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
    const orgSlug = typeof params.org_slug === 'string' ? params.org_slug : null
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
  if (import.meta.server && (!options.method || options.method === 'GET') && ((/^\/api\/organizations\/[^/]+\/members\/scheduling$/.test(request) && options.query?.view === 'assignment')
      || /^\/api\/messages\/listings\/[^/]+\/participants$/.test(request))
    && dashboardProductId(useRequestURL().pathname.replace(/^\/dashboard\/[^/]+/, ''))) {
    const slug = useRoute().params.org_slug
    if (typeof slug !== 'string') throw createError({ statusCode: 400, statusMessage: 'Dashboard organization scope is required' })
    return dashboardFetch(request, { orgSlug: slug }, options)
  }
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
