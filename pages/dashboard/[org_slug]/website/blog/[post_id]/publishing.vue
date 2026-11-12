<template>
  <DashboardLeafPanel
    id="organization-blog-post-publishing"
    title="Visibility"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :save-label="editor.post.value?.status === 'published' ? 'Save' : 'Publish'"
    :error="editor.actionError.value || editor.loadError.value"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <!--
      Save carries the lifecycle change too: what the fields say when you press
      Save is what the post becomes. One commit mechanism, like every leaf.
    -->
    <div v-if="editor.post.value" class="space-y-5" :inert="editor.saving.value">
      <p v-if="editor.post.value?.status !== 'published'" class="text-sm text-muted">Saving here publishes the article now. Nothing is published later on its own.</p>
      <UFormField label="Visibility" :description="editor.form.visibility === 'unlisted' ? 'Anyone with the link can read it. It stays out of the blog, search, feeds and the sitemap.' : 'Appears in the blog, search, feeds and the sitemap.'">
        <USelect v-model="editor.form.visibility" :items="[{ label: 'Listed', value: 'listed' }, { label: 'Unlisted', value: 'unlisted' }]" :disabled="editor.saving.value" class="w-full" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { blogEditorKey } from '~/lib/components/workspace/blog/BlogPostEditor.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(blogEditorKey)!
</script>
