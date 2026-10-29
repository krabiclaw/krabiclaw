<template>
  <DashboardLeafPanel id="scheduled-guest-messages" title="Scheduled messages" lead="See when messages will be sent and review their delivery." :footer="false" :error="actionError">
    <template #right><UButton icon="i-lucide-refresh-cw" aria-label="Refresh scheduled messages" color="neutral" variant="ghost" :loading="status === 'pending'" @click="refresh()" /></template>
    <UAlert v-if="error" color="error" title="Scheduled messages could not be loaded" :description="getErrorMessage(error, 'Scheduled messages request failed')" />
    <template v-else-if="data">
      <div class="divide-y divide-default">
        <article v-for="message in data.messages" :key="message.id" class="space-y-3 py-6 first:pt-0" :data-scheduled-message="message.id">
          <div class="flex items-start justify-between gap-3">
            <h2 class="font-semibold text-highlighted">{{ message.title }}</h2>
            <UBadge :color="message.status === 'failed' || message.status === 'needs_review' ? 'error' : message.status === 'sent' ? 'success' : 'neutral'" variant="soft">{{ statusLabels[message.status] }}</UBadge>
          </div>
          <p v-if="message.dueAt" class="text-sm text-muted"><time :datetime="message.dueAt">{{ atHome(message.dueAt, message.timezone) }}</time> · {{ message.timezone }}</p>
          <p class="whitespace-pre-wrap break-words text-base">{{ message.body }}</p>
          <p v-if="message.sentAt" class="text-sm text-muted">Sent {{ atHome(message.sentAt, message.timezone) }}</p>
          <UAlert v-if="message.reason" :color="message.status === 'failed' || message.status === 'needs_review' ? 'error' : 'neutral'" variant="soft" :description="message.reason" />
          <div class="flex flex-wrap gap-3">
            <UButton v-if="message.requestId && !threadId" :to="`${messagesPath}/${encodeURIComponent(message.requestId)}`" label="Open conversation" color="neutral" variant="link" />
            <UButton v-if="manage && message.templateId" :to="`${messagesPath}/automatic/${encodeURIComponent(message.templateId)}/schedule`" label="Edit automatic message" color="neutral" variant="link" />
            <UButton v-if="manage && message.status === 'pending'" label="Cancel scheduled message" color="neutral" variant="outline" :loading="cancelling === message.id" :disabled="!!cancelling" @click="cancel(message.id)" />
          </div>
        </article>
      </div>
      <p v-if="!data.messages.length" class="py-8 text-muted">No scheduled messages{{ threadId ? ' in this conversation' : ' yet' }}.</p>
      <div v-if="offset || data.pagination.hasMore" class="mt-6 flex justify-between gap-3">
        <UButton label="Previous" color="neutral" variant="outline" :disabled="!offset || status === 'pending'" @click="offset = Math.max(0, offset - 25)" />
        <UButton label="Next" color="neutral" variant="outline" :disabled="!data.pagination.hasMore || status === 'pending'" @click="offset = data.pagination.nextOffset!" />
      </div>
    </template>
    <p v-else role="status" class="text-muted">Loading scheduled messages…</p>
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { isScheduledMessage, isScheduledMessagePage, type ScheduledMessage } from './guest-messaging-client'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'
const props = defineProps<{ threadId?: string }>()
const route = useRoute()
const dashboard = useDashboardOrganization()
const api = useDashboardApi()
const { locale } = useI18n()
const offset = ref(0)
const actionError = ref('')
const cancelling = ref<string | null>(null)
const messagesPath = computed(() => `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/messages`)
const role = computed(() => dashboard.organization.value?.role as keyof typeof organizationRoles | undefined)
const manage = computed(() => Boolean(role.value && authClient.organization.checkRolePermission({ role: role.value, permissions: { operations: ['update'] } })))
const { data, error, status, refresh } = await useAsyncData(() => `scheduled-messages:${dashboard.organizationId.value}:${props.threadId ?? ''}:${offset.value}`, () => api('/api/dashboard/scheduled-guest-messages', { query: { limit: 25, offset: offset.value, ...(props.threadId ? { request_id: props.threadId } : {}) }, validate: isScheduledMessagePage }))
const statusLabels: Record<ScheduledMessage['status'], string> = { pending: 'Scheduled', sending: 'Sending', sent: 'Sent', failed: 'Failed', needs_review: 'Needs review', cancelled: 'Cancelled', skipped: 'Skipped' }
function atHome(value: string, timezone: string) { return new Intl.DateTimeFormat(locale.value, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }
async function cancel(id: string) {
  if (cancelling.value || !manage.value) return
  cancelling.value = id
  actionError.value = ''
  try {
    await api(`/api/dashboard/scheduled-guest-messages/${encodeURIComponent(id)}/cancel`, { method: 'POST', validate: (value): value is { message: ScheduledMessage } => isRecord(value) && isScheduledMessage(value.message) })
    await refresh()
    if (error.value) throw error.value
  } catch (cause) { actionError.value = getErrorMessage(cause, 'The scheduled message could not be cancelled') }
  finally { cancelling.value = null }
}
</script>
