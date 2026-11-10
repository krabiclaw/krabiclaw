<template>
  <UPopover v-model:open="isOpen" :content="{ align: 'start', side: 'bottom', sideOffset: 8 }">
    <button
      type="button"
      class="inline-flex h-9 items-center gap-2 rounded-full border border-default bg-default px-3.5 text-xs font-medium text-highlighted shadow-xs hover:border-accented focus:outline-hidden focus:ring-2 focus:ring-primary/20"
      :class="isCustomRange ? 'ring-1 ring-primary border-primary' : ''"
      data-testid="insights-date-range-pill"
    >
      <span>{{ displayStart }}</span>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" class="size-2.5 stroke-current stroke-[3]" fill="none" aria-hidden="true">
        <path d="M28 16H2M17 4l11.3 11.3a1 1 0 0 1 0 1.4L17 28" />
      </svg>
      <span>{{ displayEnd }}</span>
      <span v-if="isCustomRange" class="size-1.5 rounded-full bg-primary" title="Custom filter active" />
    </button>

    <template #content>
      <div class="w-80 space-y-4 p-4 text-sm" role="dialog" aria-label="Date range selection">
        <div class="flex items-center justify-between border-b border-default pb-3">
          <p class="font-semibold text-highlighted">Date range</p>
          <UButton
            v-if="isCustomRange"
            label="Reset"
            color="neutral"
            variant="ghost"
            size="xs"
            @click="resetToDefault"
          />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <label for="start-date-input" class="text-xs font-medium text-muted uppercase tracking-wider">Start date</label>
            <UInput
              id="start-date-input"
              v-model="draftStart"
              type="date"
              class="w-full text-xs"
              :max="draftEnd || undefined"
            />
          </div>
          <div class="space-y-1">
            <label for="end-date-input" class="text-xs font-medium text-muted uppercase tracking-wider">End date</label>
            <UInput
              id="end-date-input"
              v-model="draftEnd"
              type="date"
              class="w-full text-xs"
              :min="draftStart || undefined"
            />
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 border-t border-default pt-3">
          <UButton label="Cancel" color="neutral" variant="ghost" size="sm" @click="cancel" />
          <UButton label="Apply" color="primary" variant="solid" size="sm" :disabled="!isValidRange" @click="apply" />
        </div>
      </div>
    </template>
  </UPopover>
</template>

<script setup lang="ts">
import { formatCalendarDate } from '~/utils/timezone'

const props = defineProps<{
  startDate: string
  endDate: string
  defaultDays?: number
}>()

const emit = defineEmits<{
  (e: 'update:range', range: { startDate: string; endDate: string }): void
}>()

const isOpen = ref(false)
const draftStart = ref(props.startDate)
const draftEnd = ref(props.endDate)

watch(() => [props.startDate, props.endDate], ([newStart, newEnd]) => {
  draftStart.value = newStart ?? ''
  draftEnd.value = newEnd ?? ''
})

const displayStart = computed(() => {
  if (!props.startDate) return 'Start'
  return formatCalendarDate(props.startDate, 'en', { month: 'short', day: 'numeric' })
})

const displayEnd = computed(() => {
  if (!props.endDate) return 'End'
  return formatCalendarDate(props.endDate, 'en', { month: 'short', day: 'numeric' })
})

const isCustomRange = computed(() => {
  if (!props.startDate || !props.endDate) return false
  const diffDays = Math.round((Date.parse(`${props.endDate}T00:00:00Z`) - Date.parse(`${props.startDate}T00:00:00Z`)) / 86_400_000) + 1
  return diffDays !== (props.defaultDays ?? 30)
})

const isValidRange = computed(() => {
  if (!draftStart.value || !draftEnd.value) return false
  return draftStart.value <= draftEnd.value
})

function cancel() {
  draftStart.value = props.startDate
  draftEnd.value = props.endDate
  isOpen.value = false
}

function apply() {
  if (!isValidRange.value) return
  emit('update:range', {
    startDate: draftStart.value,
    endDate: draftEnd.value,
  })
  isOpen.value = false
}

function resetToDefault() {
  const days = props.defaultDays ?? 30
  const end = new Date()
  const start = new Date(end.getTime() - (days - 1) * 86_400_000)
  draftStart.value = start.toISOString().slice(0, 10)
  draftEnd.value = end.toISOString().slice(0, 10)
  apply()
}
</script>
