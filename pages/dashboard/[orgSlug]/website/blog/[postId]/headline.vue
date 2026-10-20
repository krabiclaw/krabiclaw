<template>
  <DashboardLeafPanel id="organization-blog-new-headline" title="Headline" :saving="editor.saving.value" :disabled="editor.saveDisabled.value" :save-label="editor.saveLabel.value" :error="editor.error.value ?? ''" @cancel="editor.revert" @save="editor.save">
    <UFormField label="Headline" required>
      <UInput v-model="editor.draft.value.title" autofocus placeholder="What is this post about?" class="w-full" />
    </UFormField>
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import { blogPostCreateKey } from '~/components/dashboard/BlogPostEditorPage.vue'
definePageMeta({ layout: 'dashboard' })
const editor = inject(blogPostCreateKey)!
</script>
