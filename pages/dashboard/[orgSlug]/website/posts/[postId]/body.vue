<template>
  <DashboardLeafPanel
    id="post-body"
    :title="post.sectionLabels.value.body"
    lead="Plain text, as you want it read. Dates, offers and codes belong here."
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
      :rows="10"
      autofocus
      placeholder="What's new? Write it the way you'd say it to a guest."
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
