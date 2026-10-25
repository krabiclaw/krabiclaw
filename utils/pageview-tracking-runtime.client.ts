import type { RouteLocationNormalized } from 'vue-router'
import { normalizeReferrerHost, readAttributionParams } from '~/utils/analytics-attribution'
import { resolveTenantLocalePath } from '~/utils/tenant-locale-path'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { isTrackablePath } from '~/utils/pageview-path'
import { NATIVE_PAGEVIEW_ZARAZ_EVENT } from '~/utils/zaraz-consent'

interface ZarazPageviewApi {
  track?: (name: string, properties?: Record<string, unknown>) => Promise<void>
}

/**
 * One observed page visit. Everything an event says about the visit is captured here, at the moment
 * the navigation is observed: a payload built later would read the next route's query string.
 */
interface TrackedPage {
  eventId: string
  path: string
  fullPath: string
  enteredAt: number
  durationSent: boolean
  /** The pageview request, fixed when the navigation was observed. Null when the route is not tracked. */
  pageview: Record<string, unknown> | null
  /** Resolves true only when the collector persisted this exact event. */
  pageviewReady: Promise<boolean>
}


// The pages observed so far, by path, so an action names the visit it happened on even when it was
// captured before the collector registered or after the visitor moved on.
const observedPages = new Map<string, TrackedPage>()
const OBSERVED_PAGES_MAX = 20

// Settles once the collector has observed the initial page (or has decided it will not track). An
// emitter that runs earlier than registration waits on this instead of reading a page that does not exist yet.
let settleRegistration: () => void = () => {}
const registration = new Promise<void>((resolve) => { settleRegistration = resolve })

/** Called by the registering plugin once the collector has finished starting, whether or not it tracks. */
export function collectorRegistered(): void {
  settleRegistration()
}

/**
 * The pageview event of the visit the caller's path names, once the collector has recorded it, for an
 * interaction or a form submission to attach as its origin. Null when that page is not tracked, was
 * not persisted, or the collector is not running. The wait is only for the pageview already in flight;
 * callers capture the event first and await this for its delivery, never before the visitor's action.
 * The server believes the reference only when it recorded that pageview for the same visitor session.
 */
export async function pageEventIdFor(path: string): Promise<string | null> {
  if (!import.meta.client) return null
  await registration
  const page = observedPages.get(path)
  if (!page?.pageview) return null
  return await page.pageviewReady ? page.eventId : null
}

/**
 * Resolves null when the visitor is leaving the page. An interaction waiting for its pageview races this,
 * so it is still delivered (without origin context, which stays unknown) rather than lost with the page.
 */
export function whenLeaving(): Promise<null> {
  return new Promise((resolve) => {
    window.addEventListener('pagehide', () => resolve(null), { once: true })
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') resolve(null) }, { once: true })
  })
}

export function registerPageviewTracking() {
  const win = window as Window & { __kc_pageview_tracking_registered?: boolean; zaraz?: ZarazPageviewApi }
  if (win.__kc_pageview_tracking_registered) { settleRegistration(); return }

  const nuxtApp = useNuxtApp()
  if (nuxtApp.payload.error) { settleRegistration(); return }
  // A preview is the host looking at their own site, not a visit.
  if (useTenantOrganization().previewAuthorized) { settleRegistration(); return }
  win.__kc_pageview_tracking_registered = true

  const router = useRouter()
  const locales = useState<PublicLocaleRepresentation[]>('public-locale-representations', () => [])
  const isTracked = (path: string) => isTrackablePath(resolveTenantLocalePath(path, locales.value.map(item => item.locale)).sourcePath) && path !== '/dev' && !path.startsWith('/dev/')

  // The collector answers `ignored` for a request it deliberately does not record (a known bot), and
  // an error for one it could not. Neither is a persisted event. A failure is reported through the
  // application's own error hook — the one the error tracker already listens to — and never breaks
  // the page the visitor is on.
  const send = async (payload: Record<string, unknown>) => {
    const response = await fetch('/api/analytics/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
      keepalive: true,
    })
    if (!response.ok) throw new Error(`Analytics collection was rejected (${response.status})`)
    return await response.json() as { ignored?: boolean; ga4_delivery?: { claimId?: string } }
  }
  const report = (error: unknown) => {
    void nuxtApp.callHook('vue:error', error, null, 'analytics-collector')
    return false as const
  }
  // Google Analytics is a destination of the native record: its page view is sent, manually, only
  // once the collector accepted this exact pageview, and names it by the native event id. An
  // ignored or failed pageview sends nothing.
  const deliverPageview = async (after: Promise<boolean>, page: TrackedPage): Promise<boolean> => {
    await after
    const result = await send(page.pageview!).catch(report)
    if (!result || result.ignored) return false
    const claimId = result.ga4_delivery?.claimId
    if (claimId) {
      // Native readiness never waits for an optional destination or its receipt.
      void (async () => {
        let deliveryStatus = 'dispatched'
        try {
          if (!win.zaraz?.track) throw new Error('Zaraz is unavailable for the claimed pageview')
          await win.zaraz.track(NATIVE_PAGEVIEW_ZARAZ_EVENT, { event_id: page.eventId, page_location: new URL(page.fullPath, window.location.origin).href })
        } catch (error) { deliveryStatus = 'failed'; report(error) }
        await send({ eventId: page.eventId, eventType: 'ga4_delivery', pagePath: page.path, claimId, deliveryStatus }).catch(report)
      })()
    }
    return true
  }

  // Observed at navigation time: the destination's own query parameters, its path, and the moment.
  // The referrer is the browser's for the first page only; later pages are internal navigations.
  const observe = (target: Pick<RouteLocationNormalized, 'path' | 'fullPath'>, initial: boolean): TrackedPage => {
    const eventId = crypto.randomUUID()
    const page: TrackedPage = {
      eventId, path: target.path, fullPath: target.fullPath, enteredAt: Date.now(),
      durationSent: false, pageview: null, pageviewReady: Promise.resolve(false),
    }
    if (!isTracked(target.path) || nuxtApp.payload.error) return page
    const attribution = readAttributionParams(new URL(target.fullPath, window.location.origin).searchParams)
    const referrerHost = initial ? normalizeReferrerHost(document.referrer) : null
    page.pageview = {
      eventId,
      eventType: 'pageview',
      pagePath: target.path,
      occurredAt: new Date(page.enteredAt).toISOString(),
      ...(referrerHost ? { referrerHost } : {}),
      ...(Object.keys(attribution).length > 0 ? { attribution } : {}),
    }
    return page
  }

  const sendDuration = (page: TrackedPage) => {
    if (page.durationSent || !page.pageview) return
    const durationSeconds = Math.round((Date.now() - page.enteredAt) / 1000)
    if (durationSeconds <= 0) return
    page.durationSent = true
    const payload = JSON.stringify({ eventId: page.eventId, eventType: 'duration', pagePath: page.path, durationSeconds })
    void page.pageviewReady.then((recorded) => {
      if (!recorded) return
      // Exact-event duration: a beacon survives the page going away; without one the same request is sent.
      if (navigator.sendBeacon?.('/api/analytics/track', new Blob([payload], { type: 'application/json' }))) return
      return send(JSON.parse(payload) as Record<string, unknown>).catch(report)
    })
  }

  const remember = (page: TrackedPage) => {
    observedPages.delete(page.path)
    observedPages.set(page.path, page)
    if (observedPages.size > OBSERVED_PAGES_MAX) observedPages.delete(observedPages.keys().next().value as string)
  }

  // Tracking is registered whatever the first route is: landing on an excluded internal route must
  // not stop a later public navigation from being recorded.
  let currentPage = observe(router.currentRoute.value, true)
  remember(currentPage)
  if (currentPage.pageview) currentPage.pageviewReady = deliverPageview(Promise.resolve(true), currentPage)
  settleRegistration()

  // clearError clears the native payload only after its redirect has finished.
  watch(() => nuxtApp.payload.error, (error) => {
    if (error || currentPage.pageview) return
    currentPage = observe(router.currentRoute.value, false)
    remember(currentPage)
    if (currentPage.pageview) currentPage.pageviewReady = deliverPageview(Promise.resolve(true), currentPage)
  })

  router.afterEach((to, from, failure) => {
    if (failure || to.fullPath === from.fullPath || to.fullPath === currentPage.fullPath) return
    const previousPage = currentPage
    sendDuration(previousPage)
    const nextPage = observe(to, false)
    currentPage = nextPage
    remember(nextPage)
    if (nextPage.pageview) {
      // Sent after the previous page's event, so the session exists before this one lands, but with
      // the payload captured now.
      nextPage.pageviewReady = deliverPageview(previousPage.pageviewReady, nextPage)
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sendDuration(currentPage)
  })
  window.addEventListener('pagehide', () => sendDuration(currentPage))
}
