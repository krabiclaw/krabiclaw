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
    <UFormField label="Caption" description="Plain text, as you want it read. Dates, offers and codes belong here.">
      <UTextarea
        v-model="post.editor.form.body"
        :rows="10"
        autofocus
        placeholder="What's new? Write it the way you'd say it to a guest."
        :maxlength="5000"
        class="w-full"
      />
    </UFormField>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { postEditorKey } from '~/components/dashboard/PostEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const post = inject(postEditorKey)!
</script>
