<template>
  <DashboardLeafPanel
    id="organization-qa-visibility"
    title="Status"
    lead="A published question appears on your site. A draft question is hidden."
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :save-label="editor.saveLabel.value"
    :error="editor.errorMessage.value"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <SettingRow v-model="editor.form.published" label="Published" description="A published question appears on the page it is filed under." />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { qaEditorKey } from '~/components/dashboard/QaEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(qaEditorKey)!
</script>
