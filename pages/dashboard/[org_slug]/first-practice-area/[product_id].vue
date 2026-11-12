<template>
  <PracticeAreaSetupPanel v-if="guide?.step" :title="guide.step.title" :detail="guide.step.detail"
    :back-to="guide.back_url" :back-label="guide.back_label" :next-label="guide.next_label"
    :exit-label="guide.exit_label" :saving="saving" :next-disabled="incomplete" :error="error"
    @next="advance(false)" @exit="advance(true)">
    <UFormField v-if="guide.step.max_length" :label="guide.step.title" :ui="{ label: 'sr-only' }">
      <UTextarea v-model="answer" :aria-label="guide.step.title" :maxlength="guide.step.max_length" :rows="4" size="xl" class="w-full"
        :ui="{ base: 'min-h-32 resize-none rounded-xl text-base lg:min-h-44' }" />
      <p class="mt-2 text-sm text-muted" aria-hidden="true">{{ answer.length }}/{{ guide.step.max_length }}</p>
    </UFormField>
    <URadioGroup v-else-if="guide.step.options" v-model="answer" :items="guide.step.options" :aria-label="guide.step.title" variant="card" />
    <div v-else-if="guide.step.schedule" class="grid gap-4">
      <UFormField label="Day" name="weekday">
        <USelect v-model="schedule.weekday" :items="WEEK_ROWS" value-key="value" aria-label="Day" placeholder="Choose a day" size="xl" class="w-full" />
      </UFormField>
      <div class="grid gap-4" :class="{ 'grid-cols-2': guide.step.id === 'hours' }">
        <UFormField label="Starts at">
          <UInput v-model="schedule.start" type="time" aria-label="Starts at" size="xl" class="w-full" />
        </UFormField>
        <UFormField v-if="guide.step.id === 'hours'" label="Ends at">
          <UInput v-model="schedule.end" type="time" aria-label="Ends at" size="xl" class="w-full" />
        </UFormField>
      </div>
      <BookingTimezoneSelect v-if="guide.step.id === 'hours'" v-model="schedule.timezone" :options="TIMEZONE_OPTIONS" />
      <p v-else-if="guide.step.schedule.timezone" class="text-sm text-muted">{{ timezoneLabel(guide.step.schedule.timezone) }}</p>
    </div>
    <UFormField v-else-if="guide.step.id === 'duration' || guide.step.id === 'fee'" :label="guide.step.title" :ui="{ label: 'sr-only' }">
      <UInput v-model="answer" :aria-label="guide.step.title" :inputmode="guide.step.id === 'fee' ? 'decimal' : 'numeric'"
        size="xl" class="w-full sm:max-w-xs" :ui="{ base: 'min-h-12 text-base' }">
        <template v-if="guide.step.currency_symbol" #leading>
          <span :title="guide.step.currency" class="font-semibold text-highlighted">{{ guide.step.currency_symbol }}</span>
        </template>
      </UInput>
    </UFormField>
  </PracticeAreaSetupPanel>
  <PracticeAreaSetupPanel v-else-if="guide?.done" :title="guide.done.title" :detail="guide.done.detail"
    :back-to="guide.done.today_url" :back-label="guide.done.today_label" :next-label="guide.done.preview_label" :exit-label="guide.done.today_label"
    :saving="false" hide-exit @next="openPreview" @exit="navigateTo(guide.done.today_url)" />
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
const query = { step: route.query.step, attorney: route.query.attorney }
const { data: guide, error: loadError, refresh } = await useAsyncData(`practice-area:${route.fullPath}`, () => api(endpoint, {
  query,
  validate: (value): value is PracticeAreaGuide => isRecord(value) && (isRecord(value.step) || isRecord(value.done)),
}))
if (loadError.value) throw loadError.value
const answer = ref(guide.value?.step?.value ?? '')
const saving = ref(false)
const error = ref<string | null>(null)
const savedSchedule = () => ({
  weekday: guide.value?.step?.schedule?.weekday,
  start: guide.value?.step?.schedule?.start ?? '',
  end: guide.value?.step?.schedule?.end ?? '',
  timezone: guide.value?.step?.schedule?.timezone ?? null,
})
const schedule = ref(savedSchedule())
const incomplete = computed(() => {
  const step = guide.value?.step
  if (!step) return true
  if (step.options) return !step.options.some(option => option.value === answer.value)
  if (step.schedule) return schedule.value.weekday === undefined || !schedule.value.start
    || step.id === 'hours' && (!schedule.value.end || !schedule.value.timezone)
  if (step.max_length || step.id === 'duration' || step.id === 'fee') return !answer.value.trim()
  return false
})

async function advance(exit: boolean) {
  if (saving.value || !guide.value?.step || !exit && incomplete.value) return
  saving.value = true
  error.value = null
  try {
    const { next_url } = await api(endpoint, {
      method: 'POST', query,
      body: { step: guide.value.step.id, value: answer.value, ...(guide.value.step.schedule ? { schedule: schedule.value } : {}), exit },
      validate: (value): value is { next_url: string } => isRecord(value) && typeof value.next_url === 'string',
    })
    if (next_url === route.fullPath) {
      await refresh()
      if (loadError.value) throw loadError.value
      answer.value = guide.value?.step?.value ?? ''
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
  if (guide.value?.done) window.open(guide.value.done.preview_url, '_blank', 'noopener,noreferrer')
}
</script>
