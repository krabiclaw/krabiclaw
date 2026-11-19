export type AnnouncementAction = 'announcement_view' | 'announcement_cta_click'

/** DOM controls shared by the document-only pages and the hydrated app. */
export function installPublicDocumentControls(
  purpose: string,
  consentCookie: string,
  onAnnouncement: (action: AnnouncementAction) => void,
  followsNavigation = false,
) {
  const initialized = new WeakMap<HTMLElement, string>()
  const report = (error: unknown) => { globalThis.reportError(error) }

  function refresh() {
    const consent = document.querySelector<HTMLElement>('[data-public-consent]')
    if (consent && window.zaraz?.consent?.APIReady && cookieMissing()) consent.hidden = false
    for (const notice of document.querySelectorAll<HTMLElement>('[data-public-announcement]')) {
      const key = notice.dataset.publicAnnouncement!
      if (initialized.get(notice) === key) continue
      initialized.set(notice, key)
      let dismissed = false
      try { dismissed = localStorage.getItem(key) === '1' } catch (error) { report(error) }
      if (notice instanceof HTMLDialogElement) {
        if (dismissed) notice.close()
        else if (!notice.open) notice.showModal()
      } else notice.hidden = dismissed
      if (!dismissed) onAnnouncement('announcement_view')
    }
  }

  function cookieMissing() {
    return !document.cookie.split('; ').some(cookie => cookie.startsWith(`${consentCookie}=`))
  }

  function dismiss(notice: HTMLElement) {
    if (notice.dataset.dismissible === 'true') {
      try { localStorage.setItem(notice.dataset.publicAnnouncement!, '1') } catch (error) { report(error) }
    }
    if (notice instanceof HTMLDialogElement) notice.close()
    else notice.hidden = true
  }

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const choice = event.target.closest<HTMLElement>('[data-consent-value]')
    if (choice) {
      const consent = window.zaraz?.consent
      if (!consent?.APIReady) return
      const accepted = choice.dataset.consentValue === 'true'
      consent.set({ [purpose]: accepted })
      if (accepted) consent.sendQueuedEvents()
      const notice = choice.closest<HTMLElement>('[data-public-consent]')
      if (notice) notice.hidden = true
      return
    }
    const notice = event.target.closest<HTMLElement>('[data-public-announcement]')
    if (!notice) return
    if (event.target.closest('[data-announcement-dismiss]') || (notice instanceof HTMLDialogElement && event.target === notice)) dismiss(notice)
    else if (event.target.closest('[data-announcement-link]')) onAnnouncement('announcement_cta_click')
  })

  document.addEventListener('cancel', (event) => {
    if (!(event.target instanceof HTMLDialogElement) || !event.target.hasAttribute('data-public-announcement')) return
    event.preventDefault()
    dismiss(event.target)
  }, true)
  document.addEventListener('zarazConsentAPIReady', refresh)
  refresh()
  if (followsNavigation) {
    const selector = '[data-public-consent], [data-public-announcement]'
    new MutationObserver(changes => {
      if (changes.some(change => change.type === 'attributes' || Array.from(change.addedNodes).some(node =>
        node instanceof Element && (node.matches(selector) || node.querySelector(selector))))) refresh()
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-public-announcement'] })
  }
}

export function bootPublicDocument(
  controls: typeof installPublicDocumentControls,
  transport: typeof import('~/utils/browser-pageview').browserPageviewTransport,
  post: typeof import('~/utils/browser-pageview').postPublicInteraction,
  config: { purpose: string; consentCookie: string; gaEvent: string; preview: boolean; attributionKeys: readonly string[] },
) {
  const report = (error: unknown) => { globalThis.reportError(error); return false as const }
  const { pathname: path, search, hash } = location
  const { deliver, duration } = transport(config.gaEvent, report)
  const enteredAt = Date.now()
  const track = !config.preview && !navigator.webdriver && typeof window.crypto?.randomUUID === 'function'
  const eventId = track ? crypto.randomUUID() : ''
  const query = new URLSearchParams(search)
  const attribution = Object.fromEntries(config.attributionKeys.flatMap(key => {
    const value = query.getAll(key).find(value => value.trim() && !/[\u0000-\u001f\u007f]/.test(value))
    return value ? [[key, Array.from(value.trim()).slice(0, 255).join('')]] : []
  }))
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
    void Promise.race([page.pageviewReady, leaving]).then(recorded => post({
      ...fields, ...identity, event_name: name, occurred_at, page_event_id: recorded ? eventId : null,
    })).then(result => {
      if (!result.ignored) return window.zaraz?.track(name, { ...identity, ...(fields.page_type ? { page_type: fields.page_type } : {}) })
    }).catch(report)
  }
  controls(config.purpose, config.consentCookie, action => interaction(action, action === 'announcement_view' ? 'viewed' : 'external_handoff'))
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
}
