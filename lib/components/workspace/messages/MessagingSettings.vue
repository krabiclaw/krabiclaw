<template>
  <!-- How this person writes to guests: each choice is theirs, whatever their role. -->
  <div class="space-y-6">
    <USwitch v-model="suggestionsOn" label="Suggested replies" description="When a guest writes, a drafted reply appears in the message field. Use it or press Tab, then edit before sending." />
    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-highlighted">Send later</h3>
      <UAlert v-if="error" color="error" variant="soft" :description="getErrorMessage(error, 'Your scheduled messages could not be loaded')" />
      <p v-else-if="!data" role="status" class="text-sm text-muted">Loading…</p>
      <p v-else-if="!data.messages.length" class="text-sm text-muted">Nothing scheduled. Choose Send later from + in a conversation.</p>
      <ul v-else class="divide-y divide-default">
        <li v-for="later in data.messages" :key="later.id" class="flex items-start gap-3 py-2 text-sm">
          <div class="min-w-0 flex-1">
            <p class="text-primary">{{ label(later.sendAt) }}</p>
            <p class="line-clamp-2">{{ later.body }}</p>
            <p v-if="later.status !== 'pending'" class="text-error">{{ later.reason }}</p>
          </div>
          <UButton v-if="later.status === 'pending'" label="Cancel" color="neutral" variant="ghost" size="xs" :loading="cancelling === later.id" @click="cancel(later.id)" />
        </li>
      </ul>
      <UAlert v-if="cancelError" color="error" variant="soft" :description="cancelError" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { getErrorMessage } from '~/utils/errors'
import { isSendLaterList, isSendLaterResponse, useSuggestedReplies } from './guest-messaging-client'

const dashboard = useDashboardOrganization()
const api = useDashboardApi(useDashboardRouteScope())
const { locale } = useI18n()
const suggestionsOn = useSuggestedReplies(() => dashboard.organizationId.value)
const base = computed(() => `/api/dashboard/organizations/${dashboard.organizationId.value}/send-later`)
const { data, error, refresh } = await useAsyncData(() => `send-later:${dashboard.organizationId.value}`, () => api(base.value, { validate: isSendLaterList }))
const cancelling = ref<string | null>(null)
const cancelError = ref<string | null>(null)
const label = (instant: string) => new Intl.DateTimeFormat(locale.value, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(instant))
async function cancel(id: string) {
  cancelling.value = id
  cancelError.value = null
  try {
    await api(`${base.value}/${encodeURIComponent(id)}/cancel`, { method: 'POST', validate: isSendLaterResponse })
    await refresh()
  } catch (err) {
    cancelError.value = getErrorMessage(err, 'The message could not be cancelled')
  } finally {
    cancelling.value = null
  }
}
</script>
