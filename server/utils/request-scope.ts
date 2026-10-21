import type { H3Event } from 'nitro'
import { getEventContext, type HTTPEvent } from 'nitro/h3'

const STORE_KEY = '__requestScopedReads'

type Store = Map<string, Promise<unknown>>

/**
 * Read something at most once per request.
 *
 * A single render asks the same questions repeatedly: the route middleware,
 * the SSR context loader and each of the page's own loaders all resolve the
 * same site and the same membership, and each resolution is a D1 round trip
 * that is the dominant cost of a CMS request. None of those answers can change
 * while the request is in flight, so the second and later asks are pure
 * latency.
 *
 * `event.context` is H3's per-request store and is already how this codebase
 * carries request-scoped values (tenantType, organizationId, publicResourceProvider).
 * The promise is stored, not the resolved value, so concurrent callers in the
 * same `Promise.all` share one round trip rather than racing to start two.
 *
 * Only cache reads that are stable for the life of the request. A rejected
 * read is dropped so a retry is not served the failure, and a caller that
 * needs to observe a write it just made must not read through here.
 */
export function oncePerRequest<T>(event: H3Event | HTTPEvent, key: string, read: () => Promise<T>): Promise<T> {
  const context = getEventContext(event) as Record<string, unknown>
  let store = context[STORE_KEY] as Store | undefined
  if (!store) {
    store = new Map()
    context[STORE_KEY] = store
  }
  const existing = store.get(key)
  if (existing) return existing as Promise<T>
  const pending = read()
  store.set(key, pending)
  pending.catch(() => store.delete(key))
  return pending
}
