<template>
  <USelect v-model="selected" :items="items" :disabled="disabled" class="w-full" data-testid="check-in-end-time" />
</template>

<script setup lang="ts">
import { STAY_QUIET_HOUR_TIMES } from '~/shared/product-details'

/** The end of a home's check-in window: a time, or '' for Airbnb's Flexible. */
const model = defineModel<string>({ required: true })
defineProps<{ disabled?: boolean }>()
// A select needs a non-empty value for the flexible end, which the form holds as ''.
const FLEXIBLE = 'flexible'
const selected = computed({
  get: () => model.value || FLEXIBLE,
  set: (value: string) => { model.value = value === FLEXIBLE ? '' : value },
})
/** Airbnb's choices: whole hours, or Flexible; a saved time between hours stays selectable. */
const items = computed(() => [
  { label: 'Flexible', value: FLEXIBLE },
  ...[...new Set([...STAY_QUIET_HOUR_TIMES, ...(model.value ? [model.value] : [])])].sort().map(time => ({ label: time, value: time })),
])
</script>
