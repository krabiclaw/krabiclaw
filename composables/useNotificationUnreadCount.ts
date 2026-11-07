import type { DashboardInvalidationConnection } from '~/composables/useDashboardInvalidations'

/**
 * Re-read every unread count on the page. A read raises no live event of its
 * own (a team thread's change event reloads the open conversation), so the
 * screen that recorded a read asks for the counts again.
 */
export function refreshNotificationUnreadCounts() {
  useState('dashboard-unread-refresh', () => 0).value += 1
}

/** A detail acknowledges only the alerts that existed when its data was loaded. */
export function useAcknowledgeScheduleNotifications(ids: () => readonly string[] | undefined) {
  const scope = useDashboardRouteScope()
  const error = shallowRef<unknown>(null)
  let handled = false
  onMounted(() => {
    watch(ids, async (snapshot, _, onCleanup) => {
      if (!snapshot || handled) return
      const organization = scope.value
      if (!organization) {
        error.value = new Error('Dashboard organization scope is required')
        return
      }
      handled = true
      let cancelled = false
      onCleanup(() => { cancelled = true })
      error.value = null
      try {
        for (const id of snapshot) {
          if (cancelled) return
          await dashboardFetch(`/api/dashboard/notifications/${encodeURIComponent(id)}/read`, organization, {
            method: 'PATCH',
            validate: (value): value is { success: true } => isRecord(value) && value.success === true,
          })
        }
        if (!cancelled && snapshot.length) refreshNotificationUnreadCounts()
      } catch (cause) {
        if (!cancelled) error.value = cause
      }
    }, { immediate: true, flush: 'post' })
  })
  return error
}
/**
 * The dashboard shell provides the live connection and reads the count itself,
 * so it passes its own connection: a component cannot inject what it provides.
 */
export function useNotificationUnreadCount(connection?: DashboardInvalidationConnection) {
  const { organization } = useDashboardMenu()
  const orgSlug = computed(() => organization.value?.slug ?? null)
  const dashboardApi = useDashboardApi(computed(() => orgSlug.value ? { orgSlug: orgSlug.value } : null))
  const realtime = connection ?? useDashboardInvalidations()
  const unreadCount = ref(0)
  // Guest and team conversations with something unread, for the Messages tab.
  const unreadConversations = ref(0)
  const error = shallowRef<unknown>(null)
  let latestRequestId = 0

  const isUnreadCountResponse = (value: unknown): value is { unread_count: number; unread_conversations: number } =>
    isRecord(value) && typeof value.unread_count === 'number' && typeof value.unread_conversations === 'number'

  async function refresh() {
    const requestId = ++latestRequestId
    try {
      const response = orgSlug.value
        ? await dashboardApi('/api/dashboard/notifications/unread-count', { validate: isUnreadCountResponse })
        : await applicationFetch('/api/dashboard/notifications/unread-count', { query: { scope: 'personal' }, validate: isUnreadCountResponse })
      if (requestId === latestRequestId) {
        unreadCount.value = response.unread_count
        unreadConversations.value = response.unread_conversations
        error.value = null
      }
    } catch (cause) {
      if (requestId === latestRequestId) error.value = cause
    }
  }

  watch(orgSlug, () => {
    unreadCount.value = 0
    unreadConversations.value = 0
    error.value = null
    void refresh()
  }, { immediate: true })

  watch(realtime.event, (event) => {
    // A team message raises no notification; its thread's change is what moves the Messages count.
    if (event?.type === 'notification.created' || event?.type === 'notification.read' || event?.type === 'team_thread.changed') void refresh()
  })
  watch(realtime.connectionEpoch, (epoch) => {
    if (epoch > 0) void refresh()
  })
  watch(useState('dashboard-unread-refresh', () => 0), () => void refresh())

  const unavailable = computed(() => Boolean(error.value) || Boolean(orgSlug.value && realtime.status.value === 'failed'))
  return { unreadCount, unreadConversations, refresh, error, unavailable }
}
