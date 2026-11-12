<template>
  <DashboardLeafPanel
    id="organization-sharing-image"
    title="Social sharing image"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <MediaPicker v-model="editor.form.socialShareAssetId" :organization-id="editor.organizationId" accept="image" title="Select social sharing image" />
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
</script>
