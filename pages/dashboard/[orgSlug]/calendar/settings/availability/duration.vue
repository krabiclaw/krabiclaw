<template>
  <DashboardLeafPanel id="reservation-duration" title="Reservation duration" lead="How long should each table reservation occupy the calendar?" :saving="editor.saving.value" :disabled="editor.saveDisabled.value" :error="editor.editorError.value ?? ''" @cancel="editor.revert" @save="editor.save">
    <UInputNumber v-model="editor.reservationForm.value.duration_minutes" :min="1" aria-label="Minutes" />
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import { useCalendarLocationEditor } from '~/composables/useCalendarLocationEditor'
definePageMeta({ layout: 'dashboard' })
const editor = await useCalendarLocationEditor('reservations')
</script>
