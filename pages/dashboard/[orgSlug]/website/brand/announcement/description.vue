<template>
  <DashboardLeafPanel
    id="organization-announcement-description"
    title="Description"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? editor.validationMessage.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/500 available</p>
    <UTextarea v-model="editor.form.announcementDescription" aria-label="Description" :rows="4" maxlength="500" autofocus class="w-full" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
const charactersRemaining = computed(() => 500 - (editor.form.announcementDescription?.length ?? 0))
</script>
