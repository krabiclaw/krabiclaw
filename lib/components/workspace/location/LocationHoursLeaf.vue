<template>
  <!-- One concern of the hours index: the timezone, or one weekday. -->
  <DashboardLeafPanel
    :id="`hours-${concern}`"
    :title="day ? day.label : 'Timezone'"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :save-label="editor.saveLabel.value"
    :error="editor.editorError.value ?? editor.validationMessage.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <LocationTimezoneField v-if="!day" v-model="form.timezone" />
    <LocationHoursDay v-else :key="day.value" v-model:form="form" :day="day.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import type { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'
import LocationHoursDay from './LocationHoursDay.vue'
import LocationTimezoneField from './LocationTimezoneField.vue'
import { WEEK_ROWS } from './hours'

const props = defineProps<{
  editor: Awaited<ReturnType<typeof useLocationEditor>>
  /** `timezone`, or a weekday's name. */
  concern: string
}>()

// The editor's own draft of the hours, the one its Save sends.
const form = props.editor.hoursForm
const day = computed(() => WEEK_ROWS.find(row => row.slug === props.concern) ?? null)

// Anything else under Hours is not a page (DESIGN.md).
watchEffect(() => {
  if (props.concern !== 'timezone' && !day.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
</script>
