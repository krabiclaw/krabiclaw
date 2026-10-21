import { expect, test, type Frame, type Page, type Request, type Response } from '@playwright/test'
import { blawbyTestBaseUrl, blawbyTestExtraHeaders, tenantTestBaseUrl, potteryHouseTestBaseUrl, tenantTestExtraHeaders, potteryHouseTestExtraHeaders } from './test-env'

export const tenantBaseURL = tenantTestBaseUrl()
export const potteryHouseBaseURL = potteryHouseTestBaseUrl()
export const blawbyBaseURL = blawbyTestBaseUrl()
// Extra headers for tenant tests against local hosts.
// Deployed staging tenant tests use direct environment aliases.
export const tenantExtraHeaders = tenantTestExtraHeaders()
export const potteryHouseExtraHeaders = potteryHouseTestExtraHeaders()
export const blawbyExtraHeaders = blawbyTestExtraHeaders()

interface ZarazConsentApi {
  APIReady: boolean
}

// Inject extra headers ONLY into requests targeting the tenant's base hostname.
// page.setExtraHTTPHeaders sends to ALL origins, triggering CORS preflights on
// cross-origin resources (R2 media CDN, analytics beacon) that don't allow
// x-preview-tenant — causing ERR_BLOCKED_BY_ORB and CORS failures.
export async function openTenantPage(page: Page, url: string, headers: Record<string, string>) {
  const { origin, hostname } = new URL(url)
  const usesZarazConsent = !['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
  if (Object.keys(headers).length) {
    await page.route(`${origin}/**`, async (route) => {
      await route.continue({ headers: { ...route.request().headers(), ...headers } })
    })
  }

  const started = Date.now()
  const pending = new Set<Request>()
  let stage = 'navigation'
  let documentResponse: Record<string, unknown> | null = null
  const onRequest = (request: Request) => pending.add(request)
  const onFinished = (request: Request) => pending.delete(request)
  const onResponse = (response: Response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      const headers = response.headers()
      documentResponse = {
        status: response.status(),
        requestId: headers['x-request-id'],
        rayId: headers['cf-ray'],
        d1Statements: headers['x-d1-query-count'] ?? null,
        d1DurationMs: headers['x-d1-duration-ms'] ?? null,
        serverDurationMs: headers['x-total-duration-ms'] ?? null,
      }
    }
  }
  const report = (event: string) => console.log('[e2e-navigation]', JSON.stringify({
    event, stage, path: new URL(url).pathname, hostname, durationMs: Date.now() - started,
    testTimeoutMs: test.info().timeout,
    documentResponse,
    pending: [...pending].map(request => {
      const resource = new URL(request.url())
      return { origin: resource.origin, path: resource.pathname, type: request.resourceType() }
    }),
  }))
  page.on('request', onRequest)
  page.on('requestfinished', onFinished)
  page.on('requestfailed', onFinished)
  page.on('response', onResponse)
  report('started')
  try {
    const response = await page.goto(url, { waitUntil: 'load' })
    stage = 'consent'
    report('loaded')
    // Zaraz must be ready before a deployed page can present or honor a choice.
    if (usesZarazConsent) {
      await page.waitForFunction(() => {
        const consent = (window as Window & { zaraz?: { consent?: ZarazConsentApi } }).zaraz?.consent
        return consent?.APIReady === true
      })
    }

    // Initial tenant announcements are visitor UI; acknowledge them through
    // their real Close button before testing the site's navigation.
    const announcement = page.getByRole('dialog').filter({
      has: page.getByRole('button', { name: 'Close', exact: true }),
    })
    await waitForNuxtHydration(page)
    if (await announcement.isVisible()) {
      await announcement.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(announcement).toBeHidden()
    }

    report('finished')
    return response
  } catch (error) {
    report('failed')
    throw error
  } finally {
    page.off('request', onRequest)
    page.off('requestfinished', onFinished)
    page.off('requestfailed', onFinished)
    page.off('response', onResponse)
  }
}

// Cloudflare's injected preview toolbar can leave an empty overlay over app controls.
/**
 * A platform page is server-rendered with its buttons already in the HTML, so a
 * click that lands before Nuxt finishes hydrating is a click on a button with no
 * handler yet. Wait for the app to report hydration complete before interacting.
 */
export async function waitForNuxtHydration(page: Page | Frame) {
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt') as (Element & {
      __vue_app__?: { $nuxt?: { isHydrating: boolean } }
    }) | null
    return root?.__vue_app__?.$nuxt?.isHydrating === false
  })
}

export async function dismissPreviewToolbar(page: Page) {
  await page.addInitScript(() => {
    const removePreviewModal = () => document.querySelectorAll('.cf_modal_container').forEach(element => element.remove())
    new MutationObserver(removePreviewModal).observe(document, { childList: true, subtree: true })
    removePreviewModal()
  })
}
