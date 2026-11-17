import type { DashboardInvalidationConnection } from '~/composables/useDashboardInvalidations'
import { useInboxUnread, usePersonalInboxUnread } from '~/lib/components/workspace/messages/inbox-unread'
import { isThreadListResponse } from '~/lib/components/workspace/messages/guest-thread-client'
import { authClient } from '~/lib/auth-client'

export function refreshConversationUnread() {
  useState('dashboard-unread-refresh', () => 0).value += 1
}

/** The Messages dot: whether the reader's Current mailbox holds an unread conversation, read with the inbox's own list. */
export function useConversationUnread(connection?: DashboardInvalidationConnection) {
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
  const unread = computed(() => (orgId.value && !personalMessages.value ? inbox.value : personal.value) ?? false)
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
        readConnectionEpoch = realtime.reconnectEpoch.value
        try {
          const response = await applicationFetch('/api/messages', {
            query: { ...(workspace && { organization_id: workspace }), mailbox: 'current', limit: 1 },
            validate: isThreadListResponse,
          })
          if (started === revision && workspace === orgId.value && !inboxRoute.value) {
            if (workspace) inbox.value = response.has_unread
            else personal.value = response.has_unread
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
  watch(realtime.reconnectEpoch, epoch => { if (epoch > readConnectionEpoch) void refresh() })
  watch(realtime.accessEnded, () => { revision++; personal.value = null }, { flush: 'sync' })
  watch(useState('dashboard-unread-refresh', () => 0), () => void refresh())
  return { unread, refresh, error, unavailable: computed(() => Boolean(error.value) || realtime.status.value === 'failed') }
}
