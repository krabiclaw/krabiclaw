<template>
  <DashboardLeafPanel
    id="location-reservations"
    title="Reservations"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <div class="space-y-6">
      <UAlert
        v-if="!editor.reservationConfigExists.value"
        color="neutral"
        variant="soft"
        icon="i-lucide-calendar-off"
        description="This location does not take reservations yet. Saving a policy opens them."
      />
      <!-- Notice, seats and cancellation are the calendar's settings; this page holds the guests' notes. -->
      <UFormField label="Anything else" hint="Optional">
        <UTextarea
          :model-value="editor.reservationForm.value.additional_notes_html ?? ''"
          :rows="4"
          class="w-full"
          @update:model-value="setNotes"
        />
      </UFormField>
      <UButton
        v-if="editor.reservationConfigExists.value"
        color="error"
        variant="soft"
        icon="i-lucide-trash-2"
        :loading="editor.closingReservations.value"
        :disabled="editor.saving.value"
        @click="editor.closeReservations"
      >
        Stop taking reservations here
      </UButton>
    </div>
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const dashboardLocation = useDashboardLocation()
const organizationId = await useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, 'reservations')


// Kept as typed: trimming on every keystroke ate the space before the next word.
function setNotes(next: string | number) {
  const notes = typeof next === 'string' ? next : ''
  editor.reservationForm.value = { ...editor.reservationForm.value, additional_notes_html: notes.trim() ? notes : null }
}
</script>
