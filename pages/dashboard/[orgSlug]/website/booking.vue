<template>
  <DashboardLeafPanel
    id="organization-website-booking"
    title="Consultation requests"
    lead="Let clients choose a practice area and request a consultation. Each consultation keeps its own availability."
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <SettingRow v-model="editor.form.native_consultations" label="Accept consultation requests online" />
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
