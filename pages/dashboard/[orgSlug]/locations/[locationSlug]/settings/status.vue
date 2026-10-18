<template>
  <DashboardLeafPanel
    id="location-status"
    title="Status"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <URadioGroup v-model="editor.detailsForm.status" :items="STATUS_ITEMS" variant="card" class="w-full" />
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const dashboardLocation = useDashboardLocation()
const organizationId = await useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, 'status')

const STATUS_ITEMS = [
  { value: 'active', label: 'Published', description: 'Visible to guests on your website.' },
  { value: 'inactive', label: 'Draft', description: 'Hidden from your website. Only team members can see it.' },
]
</script>
