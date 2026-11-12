<template>
  <!-- The location's weekly opening hours; the location's Hours index edits the same field. -->
  <LocationHoursIndex id="calendar-settings-hours" :editor="editor" />
</template>

<script setup lang="ts">
import LocationHoursIndex from '~/lib/components/workspace/location/LocationHoursIndex.vue'
import { useCalendarLocationEditor } from '~/composables/useCalendarLocationEditor'

definePageMeta({ layout: 'dashboard' })

const editor = await useCalendarLocationEditor(null)
</script>
