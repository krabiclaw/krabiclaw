<template>
  <DashboardLeafPanel
    id="post-headline"
    :title="post.sectionLabels.value.headline"
    :saving="post.editor.saving.value"
    :disabled="post.saveDisabled.value"
    :save-label="post.saveLabel.value"
    :error="post.loadError.value || post.editor.error.value || ''"
    @cancel="post.revert"
    @save="post.save"
  >
    <UFormField label="Headline" description="Optional. Shown as the post's title on your site and in this list.">
      <UInput v-model="post.editor.form.title" autofocus placeholder="Add a headline" class="w-full" />
    </UFormField>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { postEditorKey } from '~/components/dashboard/PostEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const post = inject(postEditorKey)!
</script>
