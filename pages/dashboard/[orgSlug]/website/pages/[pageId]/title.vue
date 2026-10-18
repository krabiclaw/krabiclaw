<template>
  <DashboardLeafPanel
    id="organization-page-title"
    title="Title"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :save-label="editor.saveLabel.value"
    :error="editor.loadError.value ?? editor.errorMessage.value"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <template v-if="!editor.loadError.value">
      <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/200 available</p>
      <UInput v-model="editor.draft.value.title" aria-label="Title" maxlength="200" autofocus class="w-full" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { tenantPageEditorKey } from '~/components/dashboard/TenantPageEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(tenantPageEditorKey)!
const charactersRemaining = computed(() => 200 - (editor.draft.value?.title?.length ?? 0))
</script>
