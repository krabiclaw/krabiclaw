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
  const scope = useDashboardRouteScope()
  const dashboardApi = useDashboardApi(scope)
  const nuxtApp = useNuxtApp()
  const track = (payload: DashboardTelemetryPayload) => {
    if (import.meta.server || !scope.value) return
    void dashboardApi<{ ok: true }>('/api/dashboard/telemetry', {
      method: 'POST', body: payload,
      validate: (value): value is { ok: true } => typeof value === 'object' && value !== null && 'ok' in value && value.ok === true,
    }).catch(error => nuxtApp.callHook('vue:error', error, null, 'dashboard-telemetry'))
  }
  return { track }
}
