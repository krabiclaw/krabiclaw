import { readAttributionParams } from './analytics-attribution'
import { browserPageviewTransport, postPublicInteraction } from './browser-pageview'
import { installPublicDocumentControls } from './public-document-controls'
import { ZARAZ_ANALYTICS_PURPOSE_ID, ZARAZ_CONSENT_COOKIE_NAME } from './zaraz-consent'

const report = (error: unknown) => { globalThis.reportError(error); return false as const }
const { pathname: path, search, hash } = location
const { deliver, duration } = browserPageviewTransport(report)
const enteredAt = Date.now()
const track = !(document.currentScript as HTMLElement | null)?.hasAttribute('data-preview') && !navigator.webdriver && typeof window.crypto?.randomUUID === 'function'
const eventId = track ? crypto.randomUUID() : ''
const attribution = readAttributionParams(new URLSearchParams(search))
const referrer = document.referrer ? new URL(document.referrer) : null
const page = {
  eventId, path, fullPath: path + search + hash, enteredAt, durationSent: false, pageviewReady: Promise.resolve(false),
  pageview: track ? {
    event_id: eventId, event_type: 'pageview', page_path: path, occurred_at: new Date(enteredAt).toISOString(), attribution,
    ...(referrer && ['https:', 'http:'].includes(referrer.protocol) ? { referrer_host: referrer.hostname } : {}),
  } : null,
}
if (track) page.pageviewReady = deliver(Promise.resolve(true), page)
const leaving = new Promise<false>(resolve => {
  window.addEventListener('pagehide', () => resolve(false), { once: true })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') resolve(false) })
})
const interaction = (name: string, stage: string, fields: Record<string, string> = {}) => {
  if (!track) return
  const identity = { event_id: crypto.randomUUID(), stage, page_path: path }
  const occurred_at = new Date().toISOString()
  void Promise.race([page.pageviewReady, leaving]).then(recorded => postPublicInteraction({
    ...fields, ...identity, event_name: name, occurred_at, page_event_id: recorded ? eventId : null,
  })).then(result => {
    if (!result.ignored) return window.zaraz?.track(name, { ...identity, ...(fields.page_type ? { page_type: fields.page_type } : {}) })
  }).catch(report)
}
installPublicDocumentControls(ZARAZ_ANALYTICS_PURPOSE_ID, ZARAZ_CONSENT_COOKIE_NAME, action => interaction(action, action === 'announcement_view' ? 'viewed' : 'external_handoff'))
window.addEventListener('pagehide', () => duration(page))
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') duration(page) })
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  const phone = event.target.closest('a[href^="tel:"]')?.getAttribute('href')
  if (phone) interaction('phone_click', 'external_handoff', { phone: phone.slice(4) })
  const consultation = event.target.closest<HTMLElement>('[data-public-consultation]')?.dataset.publicConsultation
  if (consultation) interaction('consultation_cta_click', /^https?:\/\//i.test(consultation) ? 'external_booking_handoff' : 'schedule_navigation', { page_type: 'header' })
})
const header = document.querySelector('[data-tenant-critical-header]')
if (header) new ResizeObserver(() => {
  document.documentElement.style.setProperty('--tenant-header-height', `${header.getBoundingClientRect().height}px`)
}).observe(header)
