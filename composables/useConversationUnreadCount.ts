import type { DashboardInvalidationConnection } from '~/composables/useDashboardInvalidations'

/**
 * Ask every unread count on the page again. The screen that moved a read
 * position asks here, so the count follows even where the live connection
 * is not open (`nuxt dev`).
 */
export function refreshConversationUnreadCount() {
  useState('dashboard-unread-refresh', () => 0).value += 1
}

const isCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0

/**
 * The conversations with something unread, for the Messages tab: the
 * organization's from its conversation list's own counts (`unread.all`, the
 * one unread statement the list, its filters and the badge share), or the
 * person's own conversations as a guest. The dashboard shell provides the live
 * connection and reads the count itself, so it passes its own connection: a
 * component cannot inject what it provides.
 */
export function useConversationUnreadCount(connection?: DashboardInvalidationConnection) {
  const { organization } = useDashboardMenu()
  const orgSlug = computed(() => organization.value?.slug ?? null)
  const dashboardApi = useDashboardApi(computed(() => orgSlug.value ? { orgSlug: orgSlug.value } : null))
  const realtime = connection ?? useDashboardInvalidations()
  const unreadConversations = ref(0)
  const error = shallowRef<unknown>(null)
  let latestRequestId = 0

  async function read(): Promise<number> {
    const current = organization.value
    if (current) {
      const page = await dashboardApi(`/api/dashboard/organizations/${encodeURIComponent(current.id)}/conversations`, {
        query: { limit: 1, mailbox: 'current' },
        validate: (value): value is { unread: { all: number } } => isRecord(value) && isRecord(value.unread) && isCount(value.unread.all),
      })
      return page.unread.all
    }
    const personal = await applicationFetch('/api/account/unread-count', {
      validate: (value): value is { count: number } => isRecord(value) && isCount(value.count),
    })
    return personal.count
  }

  async function refresh() {
    const requestId = ++latestRequestId
    try {
      const count = await read()
      if (requestId === latestRequestId) {
        unreadConversations.value = count
        error.value = null
      }
    } catch (cause) {
      if (requestId === latestRequestId) error.value = cause
    }
  }

  watch(orgSlug, () => {
    unreadConversations.value = 0
    error.value = null
    void refresh()
  }, { immediate: true })

  watch(realtime.event, (event) => {
    if (event?.type === 'MESSAGE_CREATE' || event?.type === 'MESSAGE_ACK' || event?.type === 'CONVERSATION_LEAVE' || event?.type === 'access.changed') void refresh()
  })
  watch(realtime.connectionEpoch, (epoch) => {
    if (epoch > 0) void refresh()
  })
  watch(useState('dashboard-unread-refresh', () => 0), () => void refresh())

  const unavailable = computed(() => Boolean(error.value) || Boolean(orgSlug.value && realtime.status.value === 'failed'))
  return { unreadConversations, refresh, error, unavailable }
}
