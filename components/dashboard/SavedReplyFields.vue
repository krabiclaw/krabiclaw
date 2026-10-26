<template>
  <div class="space-y-8">
    <template v-if="!concern || concern === 'content'">
      <UFormField label="Name"><UInput v-model="editor.draft.value.title" :maxlength="100" autofocus class="w-full" :disabled="!editor.manage.value || editor.saving.value" /></UFormField>
      <UFormField label="Message"><UTextarea v-model="editor.draft.value.body" :maxlength="5000" :rows="8" class="w-full" :disabled="!editor.manage.value || editor.saving.value" /></UFormField>
    </template>
    <template v-if="!concern || concern === 'schedule'">
      <UFormField label="When to send"><USelect :model-value="trigger" :items="triggers" class="w-full" :disabled="!editor.manage.value || editor.saving.value" @update:model-value="setTrigger" /></UFormField>
      <template v-if="editor.draft.value.schedule">
        <UAlert v-if="editor.homesError.value" color="error" title="Homes could not be loaded" :description="editor.homesError.value" />
        <UFormField label="Homes"><USelectMenu v-model="editor.draft.value.schedule.productIds" :items="editor.homes.value.map(home => ({ label: home.name, value: home.product_id, description: home.timezone }))" value-key="value" multiple placeholder="Select homes" class="w-full" :disabled="!editor.manage.value || editor.saving.value || !!editor.homesError.value" /></UFormField>
        <template v-if="editor.draft.value.schedule.trigger !== 'booking_received'">
          <UFormField label="Day"><USelect v-model="editor.draft.value.schedule.offsetDays" :items="days" class="w-full" :disabled="!editor.manage.value || editor.saving.value" /></UFormField>
          <UFormField label="Local time"><UInput v-model="editor.draft.value.schedule.localTime" type="time" class="w-full" :disabled="!editor.manage.value || editor.saving.value" /></UFormField>
        </template>
        <p class="text-sm text-muted">New-reservation messages apply to new direct reservations. Airbnb stays receive check-in and checkout messages. Failed messages remain visible for review.</p>
      </template>
    </template>
  </div>
</template>
<script setup lang="ts">
import { savedReplyEditorKey } from './SavedReplyEditorPage.vue'
defineProps<{ concern?: 'content' | 'schedule' }>()
const editor = inject(savedReplyEditorKey)!
const trigger = computed(() => editor.draft.value.schedule?.trigger ?? 'manual')
const triggers = [{ label: 'Send manually', value: 'manual' }, { label: '5 minutes after a new direct reservation', value: 'booking_received' }, { label: 'Around check-in', value: 'check_in' }, { label: 'Around checkout', value: 'check_out' }]
const days = Array.from({ length: 15 }, (_, index) => { const value = index - 7; return { value, label: value === 0 ? 'On the day' : `${Math.abs(value)} ${Math.abs(value) === 1 ? 'day' : 'days'} ${value < 0 ? 'before' : 'after'}` } })
function setTrigger(value: string) {
  if (!editor.manage.value || editor.saving.value) return
  const current = editor.draft.value.schedule
  editor.draft.value.schedule = value === 'manual' ? null : value === 'booking_received' ? { trigger: value, delayMinutes: 5, productIds: current?.productIds ?? [] }
    : { trigger: value as 'check_in' | 'check_out', offsetDays: current && current.trigger !== 'booking_received' ? current.offsetDays : 0, localTime: current && current.trigger !== 'booking_received' ? current.localTime : '09:00', productIds: current?.productIds ?? [] }
}
</script>
