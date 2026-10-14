// Product analytics is sent through the edge-injected Cloudflare Zaraz API.
// The configured GA4 tool mirrors `zaraz.track()` events while its consent
// purpose is granted by the visitor in ZarazConsentNotice.

import { parseGaClientId, parseGaSessionId } from '~/utils/ga-cookies'
import { ZARAZ_ANALYTICS_PURPOSE_ID } from '~/utils/zaraz-consent'
import { CONVERSION_EVENT_CATALOG, type ConversionEventDefinition, type OrganizationConversionEventName } from '~/utils/organization-conversion-events'
import { pageEventIdFor, whenLeaving } from '~/utils/pageview-tracking-runtime.client'

declare global {
  interface Window {
    zaraz?: {
      track: (_eventName: string, _params?: Record<string, unknown>) => void
      ecommerce?: (_eventName: string, _params?: Record<string, unknown>) => void
      set: (_key: string, _value: string | undefined | Record<string, string>, _options?: { scope?: 'page' | 'session' | 'persist' }) => void
      consent?: {
        APIReady?: boolean
        modal: boolean
        set: (_preferences: Record<string, boolean>) => void
        getAll: () => Record<string, boolean>
        sendQueuedEvents: () => void
      }
    }
  }
}

/**
 * The signed-in product-usage events a browser reports, taken from the one event catalog. Each is
 * recorded natively first (the platform organization's own history, with the signed-in user as the
 * actor and the organization worked on as the subject), then mirrored to Google Analytics with the
 * same allowlisted properties. sign_up and onboarding_complete are recorded by the server when the
 * registration and the onboarding transition commit; purchases and refunds when Stripe reports
 * them (server/utils/stripe-ga4.ts). This composable never emits those.
 */
export type AnalyticsEventName = {
  [Name in OrganizationConversionEventName]: typeof CONVERSION_EVENT_CATALOG[Name] extends { origin: 'authenticated'; producer: 'browser' } ? Name : never
}[OrganizationConversionEventName]

export type AnalyticsEventInput = Record<string, string | number | boolean | undefined> & {
  /** The organization the user was working on. The server verifies the user belongs to it. */
  organization_id?: string
}

// Reads the GA4 client_id out of the `_ga` cookie Zaraz's GA4 tool sets.
// The client_id is the last two segments of `GA1.1.<random>.<timestamp>`.
// Used to stitch server-side Stripe webhook events back to the browsing
// session that started checkout — see server/utils/ga4-delivery.ts.
export const getGaClientId = (): string | null => {
  if (!import.meta.client) return null
  return parseGaClientId(document.cookie)
}

export const getGaSessionId = (): number | null => {
  if (!import.meta.client) return null
  return parseGaSessionId(document.cookie)
}

export const getGaSessionCapturedAt = (): number | null => {
  return getGaSessionId() ? Math.floor(Date.now() / 1000) : null
}

export interface BillingAnalyticsContext {
  gaClientId?: string
  gaSessionId?: string
  gaSessionCapturedAt?: number
}

// GA identifiers are read only while the visitor has accepted analytics; an identifier is not consent.
export const getBillingAnalyticsContext = (): BillingAnalyticsContext => {
  if (!import.meta.client || window.zaraz?.consent?.getAll()[ZARAZ_ANALYTICS_PURPOSE_ID] !== true) return {}
  const gaClientId = getGaClientId()
  const gaSessionId = getGaSessionId()
  const gaSessionCapturedAt = gaSessionId ? getGaSessionCapturedAt() : null
  return {
    ...(gaClientId ? { gaClientId } : {}),
    ...(gaSessionId ? { gaSessionId: String(gaSessionId) } : {}),
    ...(gaSessionCapturedAt ? { gaSessionCapturedAt } : {}),
  }
}


async function postAuthenticatedInteraction(payload: Record<string, unknown>): Promise<void> {
  const response = await fetch('/api/analytics/interactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
    keepalive: true,
  })
  if (!response.ok) throw new Error(`Native analytics collection was rejected (${response.status})`)
}

export const useAnalytics = () => {
  const { template } = useTenantOrganization().organization
  const isPlatform = template.slug === 'platform'
  const nuxtApp = useNuxtApp()

  const trackEvent = (eventName: AnalyticsEventName, input: AnalyticsEventInput = {}) => {
    if (!import.meta.client || !isPlatform) return
    const { organization_id: organizationId, ...properties } = input
    const eventId = crypto.randomUUID()
    const definition: ConversionEventDefinition = CONVERSION_EVENT_CATALOG[eventName]
    const kept = Object.fromEntries(Object.entries(properties).filter(([name]) => definition.properties?.includes(name)))
    const occurredAt = new Date().toISOString()
    const path = window.location.pathname
    const native = Promise.race([pageEventIdFor(path), whenLeaving()]).then(pageEventId => postAuthenticatedInteraction({ event_id: eventId, occurred_at: occurredAt, event_name: eventName, organization_id: organizationId, page_event_id: pageEventId, properties: kept }))
    // The Google Analytics copy is a projection of the native event: it is sent only after the native
    // record accepted it, with the same id. A collection failure is reported through the application's
    // error hook into operational logs, independently of product analytics.
    void native.then(
      () => window.zaraz?.track(eventName, { event_id: eventId, ...kept, ...(organizationId ? { organization_id: organizationId } : {}), device_language: navigator.language, is_prod: import.meta.env.PROD }),
      (error) => {
        return nuxtApp.callHook('vue:error', error, null, 'analytics-interaction')
      },
    )
  }

  const setUserId = (userId: string | null | undefined) => {
    if (!import.meta.client || typeof window === 'undefined') return
    window.zaraz?.set('user_id', userId ?? undefined, { scope: 'session' })
  }

  const trackOrganizationCreated = (organizationId: string) => trackEvent('organization_created', { organization_id: organizationId })
  const trackDomainConnected = (domain: string, organizationId: string) => trackEvent('domain_connected', { domain, organization_id: organizationId })
  const trackSubscriptionUpgrade = (plan: string, organizationId: string) => trackEvent('subscription_upgrade', { plan, organization_id: organizationId })
  const trackSubscriptionDowngrade = (plan: string, organizationId: string) => trackEvent('subscription_downgrade', { plan, organization_id: organizationId })
  const trackSubscriptionCheckoutSuccess = (organizationId: string, plan?: string) => trackEvent('subscription_checkout_success', { plan, organization_id: organizationId })
  const trackPostCreated = (contentId: string, organizationId: string) => trackEvent('post_created', { content_id: contentId, organization_id: organizationId, content_type: 'post' })
  const trackPostPublished = (contentId: string, organizationId: string) => trackEvent('post_published', { content_id: contentId, organization_id: organizationId, content_type: 'post' })
  const trackImageUploaded = (organizationId: string, fileSize: number, provider: string) => trackEvent('image_uploaded', { organization_id: organizationId, file_size: fileSize, provider, media_type: 'image' })
  const trackVideoUploaded = (organizationId: string, fileSize: number, provider: string) => trackEvent('video_uploaded', { organization_id: organizationId, file_size: fileSize, provider, media_type: 'video' })
  const trackMediaLibraryViewed = (organizationId: string) => trackEvent('media_library_viewed', { organization_id: organizationId })
  const trackDashboardVisited = (section: string, organizationId?: string) => trackEvent('dashboard_visited', { dashboard_section: section, organization_id: organizationId })
  return {
    trackEvent,
    trackOrganizationCreated,
    trackDomainConnected,
    trackSubscriptionUpgrade,
    trackSubscriptionDowngrade,
    trackSubscriptionCheckoutSuccess,
    setUserId,
    getBillingAnalyticsContext,
    trackPostCreated,
    trackPostPublished,
    trackImageUploaded,
    trackVideoUploaded,
    trackMediaLibraryViewed,
    trackDashboardVisited,
  }
}
