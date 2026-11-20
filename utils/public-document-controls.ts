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
