import type { RouteLocationNormalized } from 'vue-router'
import { normalizeReferrerHost, readAttributionParams } from '~/utils/analytics-attribution'
import { resolveTenantLocalePath } from '~/utils/tenant-locale-path'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { isTrackablePath } from '~/utils/pageview-path'

import { browserPageviewTransport, type BrowserPageview as TrackedPage } from '~/utils/browser-pageview'

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

/**
 * A browser driven by automation, which says so itself: Blawby's own
 * deployed checks after every release, and crawlers that run a real browser.
 * Its visits are not visitors. A test that means to be counted launches its
 * browser without the automation flag, as the local E2E suite does.
 */
export function automatedBrowser(): boolean {
  return navigator.webdriver === true
}

export function registerPageviewTracking() {
  const win = window as Window & { __kc_pageview_tracking_registered?: boolean }
  if (win.__kc_pageview_tracking_registered || automatedBrowser()) { settleRegistration(); return }

  const nuxtApp = useNuxtApp()
  if (nuxtApp.payload.error) { settleRegistration(); return }
  // A preview is the host looking at their own site, not a visit.
  if (useTenantOrganization().previewAuthorized) { settleRegistration(); return }
  win.__kc_pageview_tracking_registered = true

  const router = useRouter()
  const locales = useState<PublicLocaleRepresentation[]>('public-locale-representations', () => [])
  const isTracked = (path: string) => isTrackablePath(resolveTenantLocalePath(path, locales.value.map(item => item.locale)).sourcePath) && path !== '/dev' && !path.startsWith('/dev/')

  const { deliver: deliverPageview, duration: sendDuration } = browserPageviewTransport(error => {
    void nuxtApp.callHook('vue:error', error, null, 'analytics-collector')
    return false
  })

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
      event_id: eventId,
      event_type: 'pageview',
      page_path: target.path,
      occurred_at: new Date(page.enteredAt).toISOString(),
      ...(referrerHost ? { referrer_host: referrerHost } : {}),
      ...(Object.keys(attribution).length > 0 ? { attribution } : {}),
    }
    return page
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

  // A tap on a phone number is a call, whichever component drew the link: one listener here, so no
  // theme or block has to remember to report it. Only a tracked page's call is a visitor's.
  const { trackPhoneClick } = useOrganizationConversionTracking()
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href^="tel:"]') : null
    if (link && currentPage.pageview) trackPhoneClick(link.getAttribute('href')!.slice('tel:'.length), currentPage.path)
  })
}
