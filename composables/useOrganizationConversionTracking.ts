import { postPublicInteraction } from '~/utils/browser-pageview'
import { projectConversionToGa4 } from '~/utils/ga4-projection'
import { automatedBrowser, pageEventIdFor, whenLeaving } from '~/utils/pageview-tracking-runtime.client'
import type { ConversionValue, OrganizationConversionEventName } from '~/utils/organization-conversion-events'

interface ConversionPayload {
  event_name: OrganizationConversionEventName
  stage: string
  page_type?: string | null
  page_path?: string | null
  page_id?: string | null
  location_id?: string | null
  product_id?: string | null
  link_item_id?: string | null
  document_id?: string | null
  tier_label?: string | null
  tier_amount?: number | null
  phone?: string | null
}

/** A submission's measurement as the server reports it beside the committed result. */
export type SubmissionMeasurement = { status: 'recorded'; event_id?: string } | { status: 'failed'; reason: string } | undefined

// The browser owns what the visitor does on the page. The name, dimensions and
// value come from the shared projection, so the same fact reads the same in
// every sender. `value` is what the server resolved for a submission it
// already committed; the browser never computes or asserts an amount.
function mirrorConversion(payload: ConversionPayload, eventId: string, value?: ConversionValue | null) {
  if (!import.meta.client) return
  const projection = projectConversionToGa4({
    eventName: payload.event_name,
    value,
    params: {
      event_id: eventId,
      stage: payload.stage,
      ...(payload.page_type ? { page_type: payload.page_type } : {}),
      ...(payload.page_path ? { page_path: payload.page_path } : {}),
      ...(payload.location_id ? { location_id: payload.location_id } : {}),
    },
  })
  window.zaraz?.track(projection.name, projection.params)
}

export function useOrganizationConversionTracking() {
  const nuxtApp = useNuxtApp()
  // A preview records nothing; the pageview collector does not run for it either.
  const { previewAuthorized } = useTenantOrganization()

  /**
   * Captures the interaction now and resolves with its native event id once the native record has
   * accepted it, or null when there is none (the collection failed, which is reported
   * through the application's error hook). Google Analytics is only ever a projection of a recorded
   * native event, so every GA send waits on this result. The visitor's own action never does.
   */
  function recordNative(payload: ConversionPayload, variantId?: string | null): Promise<string | null> {
    if (!import.meta.client || previewAuthorized || automatedBrowser()) return Promise.resolve(null)
    // The interaction is captured now: its identity, moment and page are fixed here. Only its delivery
    // waits for the pageview it happened on to be recorded, so the server can attach that visit's
    // page, language and attribution.
    const captured = { ...payload, event_id: crypto.randomUUID(), occurred_at: new Date().toISOString(), ...(variantId ? { variant_id: variantId } : {}) }
    const path = window.location.pathname
    return Promise.race([pageEventIdFor(path), whenLeaving()])
      .then(pageEventId => postPublicInteraction({ ...captured, page_event_id: pageEventId }))
      .then(result => result.ignored ? null : captured.event_id)
      .catch(async (error) => {
        await nuxtApp.callHook('vue:error', error, null, 'analytics-interaction')
        return null
      })
  }

  function track(payload: ConversionPayload) {
    void recordNative(payload).then((eventId) => { if (eventId) mirrorConversion(payload, eventId) })
  }

  /** The pageview a form submission came from, for the server to verify and attach. */
  function pageEventId(): Promise<string | null> {
    return import.meta.client ? pageEventIdFor(window.location.pathname) : Promise.resolve(null)
  }

  // A product was viewed / a booking was started: native interactions first, then the GA4
  // ecommerce event through Zaraz's ecommerce API. Neither is an outcome.
  // A product view is its page's view: the pageview collector records it and counts it for the
  // offering. Google Analytics' Product Viewed carries that recorded pageview's id.
  function trackProductView(ecommerce: Record<string, unknown>) {
    if (!import.meta.client || previewAuthorized || automatedBrowser()) return
    void Promise.race([pageEventIdFor(window.location.pathname), whenLeaving()])
      .then((eventId) => { if (eventId) window.zaraz?.ecommerce?.('Product Viewed', { ...ecommerce, event_id: eventId }) })
  }

  function trackCheckoutStart(productId: string | null, locationId: string | null, ecommerce: Record<string, unknown> | null, variantId?: string | null) {
    const payload: ConversionPayload = { event_name: 'checkout_start', stage: 'started', product_id: productId, location_id: locationId, page_type: productId ? 'product' : 'reservations' }
    void recordNative(payload, variantId)
      .then((eventId) => { if (eventId) {
        if (ecommerce) window.zaraz?.ecommerce?.('Checkout Started', { ...ecommerce, event_id: eventId })
        else mirrorConversion(payload, eventId)
      } })
  }

  function trackConsultationClick(pageType: string, pagePath: string, destination?: string | null, pageId?: string | null) {
    const external = /^https?:\/\//i.test(destination || '')
    track({
      event_name: 'consultation_cta_click',
      stage: external ? 'external_booking_handoff' : 'schedule_navigation',
      page_type: pageType,
      page_path: pagePath,
      page_id: external ? undefined : pageId,
    })
  }

  /**
   * The GA copy of a submission the server committed. It is sent only when the server recorded the
   * native event, and carries that event's id; a submission whose measurement failed has no native
   * fact to mirror, so GA receives nothing. The committed submission is successful either way.
   */
  function mirrorSubmission(eventName: 'contact_submit' | 'reservation_submit' | 'booking_submit', measurement: SubmissionMeasurement, locationId?: string | null, value?: ConversionValue | null) {
    if (measurement?.status !== 'recorded' || !measurement.event_id) return
    mirrorConversion({ event_name: eventName, stage: 'submitted', location_id: locationId }, measurement.event_id, value)
  }

  function trackDonationClick(documentId: string, pagePath: string, tierLabel: string, tierAmount: number | null) {
    track({ event_name: 'donation_click', stage: 'external_handoff', document_id: documentId, page_path: pagePath, page_type: 'donate', tier_label: tierLabel, tier_amount: tierAmount })
  }

  function trackProductOrder(locationId: string | null, productId: string, pagePath?: string) {
    track({ event_name: 'product_order_external_click', stage: 'external_handoff', location_id: locationId, product_id: productId, page_type: 'product', page_path: pagePath })
  }

  // The number as the link wrote it; the server decides whether it is the business's own.
  function trackPhoneClick(phone: string, pagePath: string) {
    track({ event_name: 'phone_click', stage: 'external_handoff', phone, page_path: pagePath })
  }

  function trackAnnouncementView(pagePath: string) {
    track({ event_name: 'announcement_view', stage: 'viewed', page_path: pagePath })
  }

  // The destination is resolved server-side from the organization's current announcement
  // config — the client never asserts which URL it actually reached.
  function trackAnnouncementCtaClick(pagePath: string) {
    track({ event_name: 'announcement_cta_click', stage: 'external_handoff', page_path: pagePath })
  }

  return { track, pageEventId, trackProductView, trackCheckoutStart, trackConsultationClick, mirrorSubmission, trackDonationClick, trackProductOrder, trackPhoneClick, trackAnnouncementView, trackAnnouncementCtaClick }
}
