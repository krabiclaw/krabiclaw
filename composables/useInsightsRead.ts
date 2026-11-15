/**
 * An Insights read that a return within the live connection does not repeat,
 * as the Messages inbox's: a page or filter read in the last 30 seconds, while
 * the dashboard socket stayed open, is shown as it was. Any event that changes
 * bookings, nights, reviews or access drops every kept read, and a read an
 * event overtook is not kept.
 */
export function useInsightsRead() {
  const realtime = useDashboardInvalidations()
  return async function <T>(key: string, read: () => Promise<T>, isPage: (value: unknown) => value is T): Promise<T> {
    const held = realtime.recentInsights.reads.get(key)
    if (held && held.expiresAt > Date.now() && realtime.status.value === 'open' && held.epoch === realtime.connectionEpoch.value && isPage(held.page)) return held.page
    const epoch = realtime.connectionEpoch.value
    const invalidations = realtime.recentInsights.invalidations
    const page = await read()
    if (realtime.status.value === 'open' && epoch === realtime.connectionEpoch.value && invalidations === realtime.recentInsights.invalidations) {
      realtime.recentInsights.reads.set(key, { page, expiresAt: Date.now() + 30_000, epoch })
    }
    return page
  }
}
