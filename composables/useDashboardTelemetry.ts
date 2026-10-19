export interface DashboardTelemetryPayload {
  action: 'today_view' | 'today_range_switch' | 'today_card_click' | 'today_filter_change'
  surface?: string
  range?: string
  cardId?: string
  cardPriority?: string
  cardKind?: string
  targetPath?: string
  locationId?: string
  metadata?: Record<string, unknown>
}

export function useDashboardTelemetry() {
  const track = (payload: DashboardTelemetryPayload) => {
    try {
      if (typeof window === 'undefined') return
      const body = JSON.stringify(payload)
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([body], { type: 'application/json' })
        if (navigator.sendBeacon('/api/dashboard/telemetry', blob)) return
      }
      void fetch('/api/dashboard/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {})
    } catch {
      // Telemetry must never throw or break user workflow.
    }
  }

  return { track }
}
