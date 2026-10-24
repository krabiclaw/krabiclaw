<template>
  <DashboardLeafPanel
    id="post-body"
    :title="post.sectionLabels.value.body"
    :saving="post.editor.saving.value"
    :disabled="post.saveDisabled.value"
    :save-label="post.saveLabel.value"
    :error="post.loadError.value || post.editor.error.value || ''"
    @cancel="post.revert"
    @save="post.save"
  >
    <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/5000 available</p>
    <UTextarea
      v-model="post.editor.form.body"
      aria-label="Caption"
      variant="none"
      :rows="1"
      autoresize
      autofocus
      :maxlength="5000"
      class="w-full"
    />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { postEditorKey } from '~/components/dashboard/PostEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const post = inject(postEditorKey)!
const charactersRemaining = computed(() => 5000 - (post.editor.form.body?.length ?? 0))
</script>
