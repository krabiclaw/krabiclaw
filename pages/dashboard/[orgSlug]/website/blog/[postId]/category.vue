<template>
  <DashboardLeafPanel
    id="organization-blog-post-category"
    title="Category"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value || Boolean(categoriesFailure) || !editor.form.category_id"
    :error="editor.actionError.value || editor.loadError.value || categoriesFailure"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <div v-if="editor.post.value" class="space-y-6" :inert="editor.saving.value">
      <!-- A category belongs to one collection, so choosing the collection is choosing whose categories are offered. -->
      <UFormField label="Collection">
        <USelect v-model="editor.form.collection" :items="editor.collectionOptions" value-key="value" :disabled="editor.saving.value" class="w-full" />
      </UFormField>
      <UFormField label="Category" required>
        <USelect
          v-model="editor.form.category_id"
          :items="editor.categoryOptions.value"
          :disabled="editor.saving.value"
          value-key="value"
          :placeholder="editor.categories.value?.length === 0 ? 'No categories yet' : 'Choose a category'"
          class="w-full"
        />
        <template #hint>
          <ULink :to="categoriesPath" class="text-sm">Manage categories</ULink>
        </template>
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { blogEditorKey } from '~/lib/components/workspace/blog/BlogPostEditor.vue'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const editor = inject(blogEditorKey)!
const route = useRoute()
const categoriesPath = computed(() => `/dashboard/${String(route.params.orgSlug)}/website/blog/categories`)
const categoriesFailure = computed(() => editor.categoriesError.value ? getErrorMessage(editor.categoriesError.value, 'Categories could not be loaded') : '')
</script>
