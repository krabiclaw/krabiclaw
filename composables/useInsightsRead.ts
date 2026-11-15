import type { InjectionKey } from 'vue'
import { businessChanged } from '~/composables/useDashboardInvalidations'

/** Opens the list of Insights pages beside a page on a narrow screen. */
export const insightsListKey: InjectionKey<() => void> = Symbol('insights-list')

/** An Insights read held on the live connection for 30 seconds, dropped by any event that changes bookings, nights, reviews or access. */
export function useInsightsRead() {
  const realtime = useDashboardInvalidations()
  return async function <T>(key: string, read: () => Promise<T>, isPage: (value: unknown) => value is T): Promise<T> {
    const held = realtime.held.get(`insights:${key}`)
    if (isPage(held)) return held
    const reading = realtime.held.begin(`insights:${key}`, businessChanged)
    const page = await read()
    realtime.held.hold(reading, page, Date.now() + 30_000)
    return page
  }
}
