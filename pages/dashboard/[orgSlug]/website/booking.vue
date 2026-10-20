<template>
  <DashboardLeafPanel
    id="organization-website-booking"
    title="Schedule page"
    lead="Show the online service selector on Schedule. Each service keeps its own booking settings."
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <SettingRow v-model="editor.form.native_consultations" label="Show online services" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
const level = useRouteLevel()
// The switch exists only where the organization carries consultation settings.
// The settings have loaded before this leaf renders; a website without them has no such page.
watchEffect(() => {
  if (level.mode.value === 'yield') return
  if (!editor.consultationMode.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
</script>
