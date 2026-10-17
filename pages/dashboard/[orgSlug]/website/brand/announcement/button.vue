<template>
  <DashboardLeafPanel
    id="organization-announcement-button"
    title="Button"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? editor.validationMessage.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <div class="space-y-6">
      <UFormField label="Button label" hint="Optional">
        <UInput v-model="editor.form.announcementCtaLabel" placeholder="Learn more" autofocus class="w-full" />
      </UFormField>
      <UFormField label="Button URL" hint="Optional">
        <UInput v-model="editor.form.announcementCtaUrl" type="url" placeholder="https://..." class="w-full" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
</script>
