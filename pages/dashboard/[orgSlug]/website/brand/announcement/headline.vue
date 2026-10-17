<template>
  <DashboardLeafPanel
    id="organization-announcement-headline"
    title="Headline"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? editor.validationMessage.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/120 available</p>
    <UInput v-model="editor.form.announcementHeadline" aria-label="Headline" maxlength="120" autofocus class="w-full" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
const charactersRemaining = computed(() => 120 - (editor.form.announcementHeadline?.length ?? 0))
</script>
