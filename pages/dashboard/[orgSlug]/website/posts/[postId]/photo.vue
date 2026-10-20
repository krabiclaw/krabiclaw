<template>
  <DashboardLeafPanel
    id="post-photo"
    :title="post.sectionLabels.value.photo"
    :saving="post.editor.saving.value"
    :disabled="post.saveDisabled.value"
    :save-label="post.saveLabel.value"
    :error="post.loadError.value || post.editor.error.value || ''"
    @cancel="post.revert"
    @save="post.save"
  >
    <div class="space-y-4">
      <p class="text-base text-muted">The pictures and videos, in the order people see them: the cover first, then the rest.</p>
      <PostMediaFields v-model:media="post.editor.form.media" :organization-id="post.organizationId" />
      <p class="text-sm text-muted">Media saves with the post.</p>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import PostMediaFields from '~/components/dashboard/PostMediaFields.vue'
import { postEditorKey } from '~/components/dashboard/PostEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const post = inject(postEditorKey)!
</script>
