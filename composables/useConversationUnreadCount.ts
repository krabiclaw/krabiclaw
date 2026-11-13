import type { DashboardInvalidationConnection } from '~/composables/useDashboardInvalidations'
import { isInboxUnread, useInboxUnread } from '~/lib/components/workspace/messages/inbox-unread'
import type { organizationRoles } from '~/utils/organization-access'
import { authClient } from '~/lib/auth-client'
import type { InboxUnreadCounts } from '~/server/domain/guest-threads/types'

export function refreshConversationUnreadCount() {
  useState('dashboard-unread-refresh', () => 0).value += 1
}

export function useConversationUnreadCount(connection?: DashboardInvalidationConnection) {
  const { organization } = useDashboardMenu()
  const session = authClient.useSession()
  const reader = computed(() => session.value.data?.user.id)
  const orgSlug = computed(() => organization.value?.slug ?? null)
  const orgId = computed(() => organization.value?.id)
  const inbox = useInboxUnread(orgId)
  const route = useRoute()
  const dashboard = useDashboardOrganization()
  const role = computed(() => dashboard.organization.value?.role as keyof typeof organizationRoles | undefined)
  const dashboardApi = useDashboardApi(computed(() => orgSlug.value ? { orgSlug: orgSlug.value } : null))
  const realtime = connection ?? useDashboardInvalidations()
  const personal = ref(0)
  const error = shallowRef<unknown>(null)
  const unreadConversations = computed(() => orgId.value ? inbox.value.unread?.all ?? 0 : personal.value)
  const inboxRoute = computed(() => typeof route.params.org_slug === 'string' && route.path.split('/')[3] === 'messages'
    && Boolean(role.value && (
      authClient.organization.checkRolePermission({ role: role.value, permissions: { operations: ['read'] } })
      || authClient.organization.checkRolePermission({ role: role.value, permissions: { operations: ['assigned'] } })
      || authClient.organization.checkRolePermission({ role: role.value, permissions: { team_messages: ['read'] } })
    )))
  let revision = 0
  let queued = false
  let active = false

  async function refresh() {
    revision++
    if (!import.meta.client || active) return
    active = true
    try {
      let started: number
      do {
        started = revision
        const state = inbox.value
        if (!reader.value || (orgId.value && (state.lists > 0 || inboxRoute.value))) break
        try {
          if (orgId.value) {
            const response = await dashboardApi(`/api/dashboard/organizations/${encodeURIComponent(orgId.value)}/conversations/unread-count`, {
              validate: (value): value is { unread: InboxUnreadCounts } => isRecord(value) && isInboxUnread(value.unread),
            })
            if (started === revision && state === inbox.value && !state.lists) state.unread = response.unread
          } else {
            const response = await applicationFetch('/api/account/unread-count', {
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
    personal.value = 0
    error.value = null
    if (queued) return
    queued = true
    void nextTick(() => { queued = false; void refresh() })
  }, { immediate: true })

  watch(realtime.event, event => {
    if (!event || event.organization_id !== orgId.value) return
    if ((event.type === 'MESSAGE_ACK' || event.type === 'CONVERSATION_LEAVE') && event.user_id !== reader.value) return
    if (event.type === 'access.changed') inbox.value.unread = null
    if (['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_ACK', 'CONVERSATION_LEAVE', 'access.changed'].includes(event.type)) void refresh()
  }, { flush: 'sync' })
  watch(realtime.connectionEpoch, epoch => { if (epoch > 1) void refresh() })
  watch(useState('dashboard-unread-refresh', () => 0), () => void refresh())
  return { unreadConversations, refresh, error, unavailable: computed(() => Boolean(error.value) || Boolean(orgSlug.value && realtime.status.value === 'failed')) }
}
