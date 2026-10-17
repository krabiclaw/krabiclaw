<template>
  <DashboardLeafPanel
    id="organization-page-summary"
    title="Summary"
    lead="Used as the page's search engine description and social media summary."
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.loadError.value ?? editor.errorMessage.value"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <template v-if="!editor.loadError.value">
      <UTextarea v-model="editor.draft.value.summary" aria-label="Summary" :rows="5" autoresize autofocus class="w-full" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { tenantPageEditorKey } from '~/components/dashboard/TenantPageEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(tenantPageEditorKey)!
</script>
