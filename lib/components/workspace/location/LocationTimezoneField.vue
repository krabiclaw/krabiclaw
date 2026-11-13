<template>
  <UFormField :label="label" required>
    <USelectMenu v-model="timezone" :aria-label="label" :items="options" value-key="value" :filter-fields="['label', 'value']" placeholder="Choose a city" :search-input="{ placeholder: 'Search by city, e.g. Bangkok' }" class="w-full" />
  </UFormField>
</template>

<script setup lang="ts">
import { TIMEZONE_OPTIONS, timezoneLabel } from '~/utils/timezone'

withDefaults(defineProps<{ label?: string }>(), { label: 'Time zone' })
const timezone = defineModel<string>({ required: true })
// Keep an existing explicit zone selectable, including UTC and ICU aliases.
const options = computed(() => [...new Set([...(timezone.value ? [timezone.value] : []), ...TIMEZONE_OPTIONS])].map(value => ({ value, label: timezoneLabel(value) })))
</script>
