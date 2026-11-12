<template>
  <PracticeAreaSetupPanel v-if="current" :title="current.step.title" :detail="current.step.detail"
    :back-to="current.back_url" :back-label="current.back_label" :next-label="current.next_label"
    :exit-label="current.exit_label" :saving="saving" :next-disabled="incomplete" :error="error"
    @next="advance(false)" @exit="advance(true)">
    <UFormField v-if="current.step.max_length" :label="current.step.title" :ui="{ label: 'sr-only' }">
      <UTextarea v-model="answer" :aria-label="current.step.title" :maxlength="current.step.max_length" :rows="4" size="xl" class="w-full"
        :ui="{ base: 'min-h-32 resize-none rounded-xl text-base lg:min-h-44' }" />
      <p class="mt-2 text-sm text-muted" aria-hidden="true">{{ answer.length }}/{{ current.step.max_length }}</p>
    </UFormField>
    <URadioGroup v-else-if="current.step.options" v-model="answer" :items="current.step.options" :aria-label="current.step.title" variant="card" />
    <div v-else-if="current.step.schedule" class="grid gap-4">
      <UFormField label="Day" name="weekday">
        <USelect v-model="schedule.weekday" :items="WEEK_ROWS" value-key="value" aria-label="Day" placeholder="Choose a day" size="xl" class="w-full" />
      </UFormField>
      <div class="grid gap-4" :class="{ 'grid-cols-2': current.step.id === 'hours' }">
        <UFormField label="Starts at">
          <UInput v-model="schedule.start" type="time" aria-label="Starts at" size="xl" class="w-full" />
        </UFormField>
        <UFormField v-if="current.step.id === 'hours'" label="Ends at">
          <UInput v-model="schedule.end" type="time" aria-label="Ends at" size="xl" class="w-full" />
        </UFormField>
      </div>
      <BookingTimezoneSelect v-if="current.step.id === 'hours'" v-model="schedule.timezone" :options="TIMEZONE_OPTIONS" />
      <p v-else-if="current.step.schedule.timezone" class="text-sm text-muted">{{ timezoneLabel(current.step.schedule.timezone) }}</p>
    </div>
    <UFormField v-else-if="current.step.id === 'duration' || current.step.id === 'fee'" :label="current.step.title" :ui="{ label: 'sr-only' }">
      <UInput v-model="answer" :aria-label="current.step.title" :inputmode="current.step.id === 'fee' ? 'decimal' : 'numeric'"
        size="xl" class="w-full sm:max-w-xs" :ui="{ base: 'min-h-12 text-base' }">
        <template v-if="current.step.currency_symbol" #leading>
          <span :title="current.step.currency" class="font-semibold text-highlighted">{{ current.step.currency_symbol }}</span>
        </template>
      </UInput>
    </UFormField>
  </PracticeAreaSetupPanel>
  <PracticeAreaSetupPanel v-else-if="completed" :title="completed.done.title" :detail="completed.done.detail"
    :back-to="completed.done.today_url" :back-label="completed.done.today_label" :next-label="completed.done.preview_label" :exit-label="completed.done.today_label"
    :saving="false" hide-exit @next="openPreview" @exit="navigateTo(completed.done.today_url)" />
</template>

<script setup lang="ts">
import { isNavigationFailure } from 'vue-router'
import BookingTimezoneSelect from '~/components/booking/BookingTimezoneSelect.vue'
import { WEEK_ROWS } from '~/lib/components/workspace/location/hours'
import { TIMEZONE_OPTIONS, timezoneLabel } from '~/utils/timezone'
import PracticeAreaSetupPanel from '~/components/dashboard/PracticeAreaSetupPanel.vue'
import type { PracticeAreaGuide } from '~/server/api/dashboard/onboarding/practice-area/[product_id]'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard', tabs: false, key: route => route.fullPath })

const route = useRoute()
const api = useDashboardApi()
const endpoint = `/api/dashboard/onboarding/practice-area/${encodeURIComponent(String(route.params.product_id))}`
const query = { step: route.query.step }
const { data: guide, error: loadError, refresh } = await useAsyncData(`practice-area:${route.fullPath}`, () => api(endpoint, {
  query,
  validate: (value): value is PracticeAreaGuide => isRecord(value) && (isRecord(value.step) || isRecord(value.done)),
}))
if (loadError.value) throw loadError.value
const current = computed(() => guide.value && 'step' in guide.value ? guide.value : undefined)
const completed = computed(() => guide.value && 'done' in guide.value ? guide.value : undefined)
const answer = ref(current.value?.step.value ?? '')
const saving = ref(false)
const error = ref<string | null>(null)
const savedSchedule = () => ({
  weekday: current.value?.step.schedule?.weekday,
  start: current.value?.step.schedule?.start ?? '',
  end: current.value?.step.schedule?.end ?? '',
  timezone: current.value?.step.schedule?.timezone ?? null,
})
const schedule = ref(savedSchedule())
const incomplete = computed(() => {
  const step = current.value?.step
  if (!step) return true
  if (step.options) return !step.options.some(option => option.value === answer.value)
  if (step.schedule) return schedule.value.weekday === undefined || !schedule.value.start
    || step.id === 'hours' && (!schedule.value.end || !schedule.value.timezone)
  if (step.max_length || step.id === 'duration' || step.id === 'fee') return !answer.value.trim()
  return false
})

async function advance(exit: boolean) {
  if (saving.value || !current.value?.step || !exit && incomplete.value) return
  saving.value = true
  error.value = null
  try {
    const { next_url } = await api(endpoint, {
      method: 'POST', query,
      body: { step: current.value.step.id, value: answer.value, ...(current.value.step.schedule ? { schedule: schedule.value } : {}), exit },
      validate: (value): value is { next_url: string } => isRecord(value) && typeof value.next_url === 'string',
    })
    if (next_url === route.fullPath) {
      await refresh()
      if (loadError.value) throw loadError.value
      answer.value = current.value?.step.value ?? ''
      schedule.value = savedSchedule()
    } else {
      const result = await navigateTo(next_url)
      if (isNavigationFailure(result)) throw result
    }
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not save the consultation setup')
  } finally {
    saving.value = false
  }
}

function openPreview() {
  if (completed.value?.done) window.open(completed.value.done.preview_url, '_blank', 'noopener,noreferrer')
}
</script>
