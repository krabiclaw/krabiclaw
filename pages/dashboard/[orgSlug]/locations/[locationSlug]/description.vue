<template>
  <DashboardLeafPanel
    id="location-description"
    title="Description"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <div class="space-y-6">
      <UFormField label="Short description"><UInput v-model="editor.detailsForm.short_description" class="w-full" /></UFormField>
      <UFormField label="Description"><UTextarea v-model="editor.detailsForm.description" :rows="10" class="w-full" /></UFormField>
      <UFormField label="Price level"><UInput v-model="editor.detailsForm.price_level" class="w-full" /></UFormField>
    </div>
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const dashboardLocation = useDashboardLocation()
const organizationId = useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, 'description')
</script>
