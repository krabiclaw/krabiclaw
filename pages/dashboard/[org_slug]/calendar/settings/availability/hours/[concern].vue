<template>
  <LocationHoursLeaf :editor="editor" :concern="String(route.params.concern)" />
</template>

<script setup lang="ts">
import LocationHoursLeaf from '~/lib/components/workspace/location/LocationHoursLeaf.vue'
import { useCalendarLocationEditor } from '~/composables/useCalendarLocationEditor'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const editor = await useCalendarLocationEditor('hours')
</script>
