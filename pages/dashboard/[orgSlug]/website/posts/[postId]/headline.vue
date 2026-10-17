<template>
  <DashboardLeafPanel
    id="post-headline"
    :title="post.sectionLabels.value.headline"
    lead="Shown as the post's title on your site and in this list."
    :saving="post.editor.saving.value"
    :disabled="post.saveDisabled.value"
    :save-label="post.saveLabel.value"
    :error="post.loadError.value || post.editor.error.value || ''"
    @cancel="post.revert"
    @save="post.save"
  >
    <UFormField label="Headline" hint="Optional">
      <UInput v-model="post.editor.form.title" autofocus placeholder="Add a headline" class="w-full" />
    </UFormField>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { postEditorKey } from '~/components/dashboard/PostEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const post = inject(postEditorKey)!
</script>
