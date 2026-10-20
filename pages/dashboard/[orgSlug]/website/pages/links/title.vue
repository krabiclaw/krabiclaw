<template>
  <DashboardLeafPanel
    id="organization-links-title"
    title="Title"
    :saving="editor.saving.value"
    :disabled="!editor.form.title.trim()"
    :error="editor.loadError.value ?? editor.errorMessage.value"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <template v-if="!editor.loadError.value">
      <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/160 available</p>
      <UInput v-model="editor.form.title" aria-label="Links page title" maxlength="160" autofocus class="w-full" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { linksEditorKey } from '~/components/dashboard/LinksPageEditor.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(linksEditorKey)!
const charactersRemaining = computed(() => 160 - (editor.form.title?.length ?? 0))
</script>
