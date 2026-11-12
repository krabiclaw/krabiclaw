<template>
  <DashboardLeafPanel
    id="organization-announcement-image"
    title="Image (optional)"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? editor.validationMessage.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <MediaPicker v-model="editor.form.announcementAssetId" :organization-id="editor.organizationId" accept="image" title="Select announcement image" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
</script>
