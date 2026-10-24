<template>
  <DashboardLeafPanel
    id="organization-blog-post-excerpt"
    title="Excerpt"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.actionError.value || editor.loadError.value"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <UTextarea v-if="editor.post.value" v-model="editor.form.excerpt" aria-label="Excerpt" variant="none" :rows="1" autoresize autofocus :placeholder="editor.resolvedExcerpt.value" :disabled="editor.saving.value" class="w-full" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { blogEditorKey } from '~/lib/components/workspace/blog/BlogPostEditor.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(blogEditorKey)!
</script>
