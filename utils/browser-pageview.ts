export type BrowserPageview = {
  eventId: string
  path: string
  fullPath: string
  enteredAt: number
  durationSent: boolean
  pageview: Record<string, unknown> | null
  pageviewReady: Promise<boolean>
}

/** The network protocol shared by document visits and Nuxt navigation. */
export function browserPageviewTransport(report: (error: unknown) => false) {
  const send = async (payload: Record<string, unknown>) => {
    const response = await fetch('/api/analytics/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
      keepalive: true,
    })
    if (!response.ok) throw new Error(`Analytics collection was rejected (${response.status})`)
    return await response.json() as { ignored?: boolean; ga4_delivery?: { dispatch?: boolean; event_name?: string } }
  }

  async function deliver(after: Promise<boolean>, page: BrowserPageview): Promise<boolean> {
    await after
    const result = await send(page.pageview!).catch(report)
    if (!result || result.ignored) return false
    const delivery = result.ga4_delivery
    if (delivery?.dispatch) {
      void (async () => {
        let deliveryStatus = 'dispatched'
        try {
          const zaraz = window.zaraz
          if (!zaraz?.track) throw new Error('Zaraz is unavailable for the recorded pageview')
          if (!delivery.event_name) throw new Error('The collector dispatched a pageview without its Zaraz event')
          await zaraz.track(delivery.event_name, { event_id: page.eventId, page_location: new URL(page.fullPath, window.location.origin).href })
        } catch (error) { deliveryStatus = 'failed'; report(error) }
        await send({ event_id: page.eventId, event_type: 'ga4_delivery', page_path: page.path, delivery_status: deliveryStatus }).catch(report)
      })()
    }
    return true
  }

  function duration(page: BrowserPageview) {
    if (page.durationSent || !page.pageview) return
    const durationSeconds = Math.round((Date.now() - page.enteredAt) / 1000)
    if (durationSeconds <= 0) return
    page.durationSent = true
    const payload = { event_id: page.eventId, event_type: 'duration', page_path: page.path, duration_seconds: durationSeconds }
    void page.pageviewReady.then(recorded => {
      if (!recorded || navigator.sendBeacon?.('/api/analytics/track', new Blob([JSON.stringify(payload)], { type: 'application/json' }))) return
      return send(payload).catch(report)
    })
  }

  return { deliver, duration }
}

export async function postPublicInteraction(payload: Record<string, unknown>) {
  const response = await fetch('/api/public/conversion-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  })
  if (!response.ok) throw new Error(`Native analytics collection was rejected (${response.status})`)
  return await response.json() as { ignored?: boolean }
}
