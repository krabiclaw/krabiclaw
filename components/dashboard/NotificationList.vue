<template>
  <div class="w-full">
    <div class="flex justify-end pb-2">
      <UButton
        v-if="unreadCount > 0"
        label="Mark all read"
        color="neutral"
        variant="ghost"
        size="sm"
        :loading="markingAll"
        @click="markAllRead"
      />
    </div>

    <div>
      <UAlert
        v-if="loadError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Updates could not be loaded"
        :description="getErrorMessage(loadError, 'Updates request failed')"
        class="mb-4"
      >
        <template #actions>
          <UButton color="error" variant="soft" size="xs" :loading="status === 'pending'" @click="retryNotifications">
            Refresh
          </UButton>
        </template>
      </UAlert>
      <UAlert v-if="actionError" color="error" :description="actionError" class="mb-4" />
      <div v-if="!loadError && notifications.length === 0" class="py-16 text-center">
        <UIcon name="i-lucide-bell-off" class="mx-auto mb-3 size-7 text-muted" />
        <p class="text-sm text-muted">No updates yet.</p>
      </div>

      <!--
        A row is what the reference draws: a mark for what happened, the
        title, one line under it, when. Unread is bold. Nothing else, and no
        chevron; the row itself opens the thing.
      -->
      <div v-else class="divide-y divide-default">
        <button
          v-for="notification in notifications"
          :key="notification.id"
          :data-testid="`notification-${notification.id}`"
          type="button"
          class="flex w-full items-start gap-3 py-5 text-left transition-colors hover:bg-elevated/60"
          @click="openNotification(notification)"
        >
          <!-- Unread indicator dot on the left of the row -->
          <div class="flex h-12 w-2 shrink-0 items-center justify-center">
            <span v-if="!notification.read_at" class="size-2 rounded-full bg-primary"><span class="sr-only">Unread</span></span>
          </div>
          <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-elevated">
            <UIcon :name="iconFor(notification.template)" class="size-5" :class="notification.read_at ? 'text-muted' : 'text-highlighted'" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-highlighted" :class="notification.read_at ? 'font-medium' : 'font-semibold'">{{ notification.title }}</span>
            <span v-if="notification.message" class="mt-0.5 line-clamp-2 block text-sm text-muted">{{ notification.message }}</span>
            <span class="mt-1 block text-sm text-dimmed">{{ formatRelativeTime(notification.created_at) }}</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ personalScope?: boolean }>()

const dashboardScope = useDashboardRouteScope()
const dashboardApi = useDashboardApi(dashboardScope)
const notificationApi = computed(() => props.personalScope ? applicationFetch : dashboardApi)
const notificationQuery = computed(() => props.personalScope ? { scope: 'personal' } : {})
const realtime = useDashboardInvalidations()
const { formatRelativeTime } = useHumanTime()

interface DashboardNotification {
  id: string
  scope: 'global' | 'organization'
  template: string
  severity: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string | null
  deep_link: string | null
  created_at: string
  read_at: string | null
}

interface NotificationResponse {
  notifications: DashboardNotification[]
  unread_count: number
}

const isNotificationResponse = (value: unknown): value is NotificationResponse =>
  isRecord(value)
  && Array.isArray(value.notifications)
  && value.notifications.every(notification =>
    isRecord(notification)
    && typeof notification.id === 'string'
    && (notification.scope === 'global' || notification.scope === 'organization')
    && typeof notification.template === 'string'
    && ['info', 'success', 'warning', 'error'].includes(String(notification.severity))
    && typeof notification.title === 'string' && notification.title.trim().length > 0
    && (notification.message === null || typeof notification.message === 'string')
    && (notification.deep_link === null || typeof notification.deep_link === 'string')
    && typeof notification.created_at === 'string'
    && (notification.read_at === null || typeof notification.read_at === 'string'),
  )
  && Number.isSafeInteger(value.unread_count) && Number(value.unread_count) >= 0

// Keyed by scope, so switching organization or to the personal inbox reads that list.
const { data, error: loadError, status, refresh: refreshNotifications } = await useAsyncData(
  () => `dashboard-notifications:${props.personalScope ? 'personal' : dashboardScope.value?.orgSlug ?? ''}`,
  () => notificationApi.value<NotificationResponse>('/api/dashboard/notifications', {
    query: { limit: 50, ...notificationQuery.value },
    validate: isNotificationResponse,
  }),
)
const notifications = computed(() => data.value?.notifications ?? [])
const unreadCount = computed(() => data.value?.unread_count ?? 0)
const markingAll = ref(false)
const actionError = ref<string | null>(null)

/** The mark for what happened: a message, a booking, a review, a person. */
function iconFor(template: string) {
  if (/payment|refund|dispute|payout|invoice|billing/.test(template)) return 'i-lucide-credit-card'
  if (/review/.test(template)) return 'i-lucide-star'
  if (/reservation|booking/.test(template)) return 'i-lucide-calendar-check'
  if (/reply|contact|msg|message/.test(template)) return 'i-lucide-message-square'
  if (/signup|invite|member/.test(template)) return 'i-lucide-user-round'
  return 'i-lucide-bell'
}

// Dashboard updates stay on this origin; Stripe owns receipt and financial actions.
function notificationDestination(value: string | null): string | null {
  if (!value) return null
  const resolved = new URL(value, window.location.origin)
  if (resolved.origin === window.location.origin && (resolved.pathname === '/dashboard' || resolved.pathname.startsWith('/dashboard/'))) return `${resolved.pathname}${resolved.search}${resolved.hash}`
  if (resolved.protocol === 'https:' && (resolved.hostname === 'stripe.com' || resolved.hostname.endsWith('.stripe.com'))) return resolved.href
  throw new Error('This update has an invalid link.')
}

function retryNotifications() {
  if (!props.personalScope) realtime.connect()
  void refreshNotifications()
}

async function markRead(notification: DashboardNotification) {
  if (notification.read_at) return
  await notificationApi.value(`/api/dashboard/notifications/${notification.id}/read`, {
    method: 'PATCH',
    query: notificationQuery.value,
    validate: (value): value is { success: true } => isRecord(value) && value.success === true,
  })
  await refreshNotifications()
}

async function markAllRead() {
  markingAll.value = true
  actionError.value = null
  try {
    await notificationApi.value('/api/dashboard/notifications/read-all', {
      method: 'PATCH',
      query: notificationQuery.value,
      validate: (value): value is { success: true } => isRecord(value) && value.success === true,
    })
    // The server's list is the state; a refresh also outranks any older read
    // still in flight, which a local rewrite of the rows would not.
    await refreshNotifications()
  } catch (error) {
    actionError.value = getErrorMessage(error, 'Updates could not be marked as read.')
  } finally {
    markingAll.value = false
  }
}

async function openNotification(notification: DashboardNotification) {
  // The row is navigated away from immediately after this, so a mark-read that
  // failed and only reached the console left a notification that reappears as
  // unread with nothing on screen saying why.
  actionError.value = null
  try {
    const destination = notificationDestination(notification.deep_link)
    await markRead(notification)
    if (destination) await navigateTo(destination, { external: destination.startsWith('https://') })
  } catch (error) {
    actionError.value = getErrorMessage(error, 'This update could not be opened.')
  }
}

watch(realtime.event, (event) => {
  if (!props.personalScope && (event?.type === 'notification.created' || event?.type === 'notification.read')) void refreshNotifications()
})

watch(realtime.connectionEpoch, (epoch) => {
  if (!props.personalScope && epoch > 0) void refreshNotifications()
})

watch(() => [props.personalScope, dashboardScope.value?.orgSlug], () => {
  actionError.value = null
})
</script>
