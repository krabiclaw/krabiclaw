import type { DashboardInvalidationConnection } from '~/composables/useDashboardInvalidations'
import { isInboxUnread, useInboxUnread, usePersonalInboxUnread } from '~/lib/components/workspace/messages/inbox-unread'
import { authClient } from '~/lib/auth-client'
import type { InboxUnreadCounts } from '~/server/domain/guest-threads/types'

export function refreshConversationUnreadCount() {
  useState('dashboard-unread-refresh', () => 0).value += 1
}

export function useConversationUnreadCount(connection?: DashboardInvalidationConnection) {
  const { organization } = useDashboardMenu()
  const session = authClient.useSession()
  const reader = computed(() => session.value.data?.user.id)
  const orgId = computed(() => organization.value?.id)
  const inbox = useInboxUnread(orgId)
  const route = useRoute()
  const realtime = connection ?? useDashboardInvalidations()
  const personal = usePersonalInboxUnread()
  const error = shallowRef<unknown>(null)
  const personalMessages = computed(() => /^\/dashboard\/account\/messages(?:\/|$)/.test(route.path))
  const unreadConversations = computed(() => orgId.value && !personalMessages.value ? inbox.value?.all ?? 0 : personal.value ?? 0)
  const inboxRoute = computed(() => personalMessages.value || (typeof route.params.org_slug === 'string' && route.path.split('/')[3] === 'messages'))
  let revision = 0
  let queued = false
  let active = false
  let readConnectionEpoch = 0

  async function refresh() {
    revision++
    if (!import.meta.client || active) return
    active = true
    try {
      let started: number
      do {
        started = revision
        const workspace = orgId.value
        if (!reader.value || inboxRoute.value) break
        readConnectionEpoch = realtime.connectionEpoch.value
        try {
          if (workspace) {
            const response = await applicationFetch('/api/messages/unread-count', {
              query: { organization_id: workspace },
              validate: (value): value is { unread: InboxUnreadCounts } => isRecord(value) && isInboxUnread(value.unread),
            })
            if (started === revision && workspace === orgId.value && !inboxRoute.value) inbox.value = response.unread
          } else {
            const response = await applicationFetch('/api/messages/unread-count', {
              validate: (value): value is { count: number } => isRecord(value) && Number.isSafeInteger(value.count) && Number(value.count) >= 0,
            })
            if (started === revision) personal.value = response.count
          }
          if (started === revision) error.value = null
        } catch (cause) {
          if (started === revision) error.value = cause
        }
      } while (started !== revision)
    } finally {
      active = false
    }
  }

  watch([reader, orgId, inboxRoute], () => {
    revision++
    error.value = null
    if (queued) return
    queued = true
    void nextTick(() => { queued = false; void refresh() })
  }, { immediate: true, flush: 'sync' })

  watch(realtime.event, event => {
    if (!event || (orgId.value && !personalMessages.value && event.organization_id !== orgId.value)) return
    if (event.type === 'MESSAGE_UPDATE' && event.scheduled) return
    if ((event.type === 'MESSAGE_ACK' || event.type === 'CONVERSATION_LEAVE') && event.user_id !== reader.value) return
    if (event.type === 'access.changed') inbox.value = null
    if (['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_ACK', 'CONVERSATION_LEAVE', 'access.changed'].includes(event.type)) void refresh()
  }, { flush: 'sync' })
  watch(realtime.connectionEpoch, epoch => { if (epoch > readConnectionEpoch) void refresh() })
  watch(realtime.accessEnded, () => { revision++; personal.value = null }, { flush: 'sync' })
  watch(useState('dashboard-unread-refresh', () => 0), () => void refresh())
  return { unreadConversations, refresh, error, unavailable: computed(() => Boolean(error.value) || realtime.status.value === 'failed') }
}
