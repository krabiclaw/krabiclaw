<template>
  <UModal v-model:open="open" title="Select nights" :dismissible="!pending">
    <template #body>
      <UAlert v-if="error" class="mb-4" color="error" variant="soft" :description="error" />
      <form :id="formId" class="grid gap-5 sm:grid-cols-2" novalidate @submit.prevent="submit">
        <UFormField label="Start night"><UInput v-model="startNight" type="date" :min="firstNight" class="w-full" /></UFormField>
        <UFormField label="End night (optional)"><UInput v-model="endNight" type="date" :min="firstNight" class="w-full" /></UFormField>
      </form>
    </template>
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="link" :disabled="pending" @click="open = false" />
      <UButton label="Edit selected nights" color="neutral" type="submit" :form="formId" :loading="pending" />
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { parseDate, type CalendarDate } from '@internationalized/date'
import { STAY_CALENDAR_DAYS } from '~/shared/bookings'
import { getErrorMessage } from '~/utils/errors'
import { addLocalDays, isValidCalendarDate } from '~/utils/timezone'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
  firstNight: string
  selection: { from: string; to: string } | null
  pastMessage: string
  select: (start: CalendarDate, end: CalendarDate) => Promise<string | undefined>
}>()
const formId = useId()
const startNight = ref('')
const endNight = ref('')
const error = ref('')
const pending = ref(false)

watch(open, (show) => {
  if (!show) return
  const range = props.selection
  startNight.value = range?.from ?? props.firstNight
  const last = range ? addLocalDays(range.to, -1) : ''
  endNight.value = last === startNight.value ? '' : last
  error.value = ''
})

async function submit() {
  if (pending.value) return
  if (!isValidCalendarDate(startNight.value) || (endNight.value && !isValidCalendarDate(endNight.value))) {
    error.value = 'Choose valid start and end nights.'
    return
  }
  if (startNight.value < props.firstNight) {
    error.value = props.pastMessage
    return
  }
  const start = parseDate(startNight.value)
  const end = parseDate(endNight.value || startNight.value)
  const difference = end.compare(start)
  if (difference < 0 || difference >= STAY_CALENDAR_DAYS) {
    error.value = `Choose an end night on or after the start, with at most ${STAY_CALENDAR_DAYS} nights.`
    return
  }

  pending.value = true
  try {
    error.value = await props.select(start, end) ?? ''
    if (!error.value) open.value = false
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The selected nights could not be shown.')
  } finally {
    pending.value = false
  }
}
</script>
