<template>
  <DashboardLeafPanel id="scheduled-guest-messages" title="Sent and upcoming" :footer="false" :error="actionError">
    <template #right><UButton icon="i-lucide-refresh-cw" aria-label="Refresh scheduled messages" color="neutral" variant="ghost" :loading="status === 'pending'" :disabled="revoked || !!cancelling" @click="reconcile()" /></template>
    <UAlert v-if="revoked" color="error" title="Conversation access changed" description="You no longer have access to this conversation." />
    <UAlert v-else-if="error" color="error" title="Scheduled messages could not be loaded" :description="getErrorMessage(error, 'Scheduled messages request failed')" />
    <UButton v-if="conversationPath && !revoked && !error" :to="conversationPath" label="Back to conversation" color="neutral" variant="link" class="mb-4" />
    <template v-if="!revoked && !error && data && status !== 'idle' && data.pagination.offset === offset">
      <div class="divide-y divide-default">
        <article v-for="message in data.messages" :key="message.id" class="space-y-3 py-6 first:pt-0" :data-scheduled-message="message.id">
          <div class="flex items-start justify-between gap-3">
            <h2 class="font-semibold text-highlighted">{{ message.template_title ?? 'Your reply, sent later' }}</h2>
            <UBadge :color="message.status === 'failed' || message.status === 'needs_review' ? 'error' : message.status === 'sent' ? 'success' : 'neutral'" variant="soft">{{ statusLabels[message.status] }}</UBadge>
          </div>
          <p v-if="message.due_at" class="text-sm text-muted"><time :datetime="message.due_at">{{ atHome(message.due_at, message.timezone) }}</time><template v-if="message.timezone"> · {{ message.timezone }}</template></p>
          <p class="whitespace-pre-wrap break-words text-base">{{ message.body }}</p>
          <p v-if="message.sent_at" class="text-sm text-muted">Sent {{ atHome(message.sent_at, message.timezone) }}</p>
          <UAlert v-if="message.reason" :color="message.status === 'failed' || message.status === 'needs_review' ? 'error' : 'neutral'" variant="soft" :description="message.reason" />
          <div class="flex flex-wrap gap-3">
            <UButton v-if="!conversationId && message.conversation_id" :to="`${messagesPath}/${encodeURIComponent(message.conversation_id)}`" label="Open conversation" color="neutral" variant="link" />
            <UButton v-if="manage && message.template_id" :to="`${messagesPath}/automatic/${encodeURIComponent(message.template_id)}/schedule`" label="Edit automatic message" color="neutral" variant="link" />
            <UButton v-if="cancellable(message)" label="Cancel scheduled message" color="neutral" variant="outline" :loading="cancelling === message.id" :disabled="!!cancelling || status === 'pending'" @click="cancel(message.id)" />
          </div>
        </article>
      </div>
      <p v-if="!data.messages.length" class="py-8 text-muted">No scheduled messages yet.</p>
      <div v-if="offset || data.pagination.has_more" class="mt-6 flex justify-between gap-3">
        <UButton label="Previous" color="neutral" variant="outline" :disabled="!offset || status === 'pending' || !!cancelling" @click="offset = Math.max(0, offset - pageSize)" />
        <UButton label="Next" color="neutral" variant="outline" :disabled="!data.pagination.has_more || status === 'pending' || !!cancelling" @click="offset = data.pagination.next_offset!" />
      </div>
    </template>
    <p v-else-if="!revoked && !error" role="status" class="text-muted">Loading scheduled messages…</p>
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { isScheduledMessagePage, isScheduledMessageResponse, type ScheduledMessage, type ScheduledMessagePage } from './guest-messaging-client'
import { getErrorMessage } from '~/utils/errors'
import { dashboardLeafParentKey } from '~/lib/components/workspace/dashboard/dashboardPanelContext'

const route = useRoute()
const router = useRouter()
const dashboard = useDashboardOrganization()
const api = useDashboardApi()
const { locale } = useI18n()
const pageSize = 25
const offset = ref(0)
const actionError = ref('')
const cancelling = ref<string | null>(null)
const revoked = ref(false)
const messagesPath = computed(() => `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/messages`)
const conversationId = computed(() => route.query.conversation_id)
const conversationPath = computed(() => {
  const { conversation_id: id, ...query } = route.query
  return typeof id === 'string' && id.trim() ? router.resolve({ path: `${messagesPath.value}/${encodeURIComponent(id)}`, query }).fullPath : null
})
const role = computed(() => dashboard.organization.value?.role as keyof typeof organizationRoles | undefined)
const manage = computed(() => Boolean(role.value && authClient.organization.checkRolePermission({ role: role.value, permissions: { operations: ['update'] } })))
const session = authClient.useSession()
// An automatic message is the business's to cancel; a reply sent later is only its author's.
const cancellable = (message: ScheduledMessage) => message.status === 'pending' && (message.author_user_id === null ? manage.value : message.author_user_id === session.value.data?.user.id)
const { data, error, status, refresh, clear } = useAsyncData<ScheduledMessagePage>(
  () => JSON.stringify({ view: 'scheduled-messages', organization: dashboard.organizationId.value, conversation: conversationId.value, offset: offset.value }),
  (_app, { signal }) => {
    const id = conversationId.value
    const organizationId = dashboard.organizationId.value
    const requestedOffset = offset.value
    if (id !== undefined && (typeof id !== 'string' || !id.trim())) {
      return Promise.reject(createError({ statusCode: 400, statusMessage: 'conversation_id must identify a guest conversation' }))
    }
    return api('/api/dashboard/scheduled-guest-messages', {
      query: { conversation_id: id, limit: pageSize, offset: requestedOffset },
      signal,
      validate: (page): page is ScheduledMessagePage => isScheduledMessagePage(page)
        && page.pagination.limit === pageSize && page.pagination.offset === requestedOffset
        && page.messages.every(message => message.organization_id === organizationId && (id === undefined || message.conversation_id === id)),
    })
  },
)
const parent = inject(dashboardLeafParentKey, null)
provide(dashboardLeafParentKey, {
  focus: parent?.focus,
  exit: () => revoked.value || (conversationId.value !== undefined && error.value) ? messagesPath.value : conversationPath.value ?? parent?.exit() ?? null,
})

const realtime = useDashboardInvalidations()
let refreshRequested = false
function reconcile() {
  if (revoked.value) return
  refreshRequested = status.value === 'pending' || cancelling.value !== null
  if (!refreshRequested) void refresh()
}
watch([status, cancelling], () => { if (refreshRequested) reconcile() })
watch(realtime.event, event => {
  if (!event || event.organization_id !== dashboard.organizationId.value) return
  if (event.type === 'access.changed') {
    revoked.value = false
    clear()
    reconcile()
  } else if (event.type === 'CONVERSATION_LEAVE' && event.conversation_id === conversationId.value && event.user_id === session.value.data?.user.id) {
    revoked.value = true
    refreshRequested = false
    clear()
  } else if (event.type === 'MESSAGE_UPDATE' && event.scheduled) {
    if (conversationId.value === undefined || event.conversation_id === conversationId.value) reconcile()
  } else if (event.type === 'MESSAGE_CREATE' && !event.message) {
    if (event.conversation_id === conversationId.value || (conversationId.value === undefined
      && (status.value === 'pending' || data.value?.messages.some(message => message.conversation_id === event.conversation_id)))) reconcile()
  }
}, { flush: 'sync' })
watch(realtime.connectionEpoch, epoch => {
  if (epoch < 2) return
  revoked.value = false
  reconcile()
})

const statusLabels: Record<ScheduledMessage['status'], string> = { pending: 'Scheduled', sending: 'Sending', sent: 'Sent', failed: 'Failed', needs_review: 'Needs review', cancelled: 'Cancelled', skipped: 'Skipped' }
// An automatic message is shown in its booking's clock; a reply sent later in this device's.
function atHome(value: string, timezone: string | null) { return new Intl.DateTimeFormat(locale.value, { ...(timezone ? { timeZone: timezone } : {}), dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }
async function cancel(id: string) {
  if (cancelling.value) return
  cancelling.value = id
  actionError.value = ''
  try {
    const { message } = await api(`/api/dashboard/scheduled-guest-messages/${encodeURIComponent(id)}/cancel`, { method: 'POST', validate: isScheduledMessageResponse })
    if (data.value) data.value = { ...data.value, messages: data.value.messages.map(row => row.id === message.id ? message : row) }
  } catch (cause) { actionError.value = getErrorMessage(cause, 'The scheduled message could not be cancelled') }
  finally { cancelling.value = null }
}
</script>
