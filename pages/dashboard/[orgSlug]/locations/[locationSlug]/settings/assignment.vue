<template>
  <DashboardLeafPanel
    id="location-assignment"
    title="Team assignment"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <ResponsibilityPicker v-model:member-id="editor.detailsForm.assigned_member_id" v-model:team-id="editor.detailsForm.assigned_team_id" :organization-id="organizationId" :disabled="editor.saving.value" />
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'
import ResponsibilityPicker from '~/components/dashboard/ResponsibilityPicker.vue'

definePageMeta({ layout: 'dashboard' })

const dashboardLocation = useDashboardLocation()
const organizationId = await useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, 'assignment')
</script>
