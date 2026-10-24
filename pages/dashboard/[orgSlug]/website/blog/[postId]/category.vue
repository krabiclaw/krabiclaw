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
          :items="categoryOptions"
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
// A nested category reads with the categories above it: "Integrations › Google".
const categoryOptions = computed(() => {
  const all = editor.categories.value ?? []
  const byId = new Map(all.map(category => [category.id, category]))
  const trail = (id: string | null): string[] => {
    const category = id ? byId.get(id) : undefined
    return category ? [...trail(category.parent_id), category.name] : []
  }
  return all.map(category => ({ label: trail(category.id).join(' › '), value: category.id }))
})
const categoriesFailure = computed(() => editor.categoriesError.value ? getErrorMessage(editor.categoriesError.value, 'Categories could not be loaded') : '')

// A category of the other collection is not a choice here: switching the
// collection clears it, and the owner picks one of the new collection's.
watch(editor.categories, (categories) => {
  if (categories && editor.form.category_id && !categories.some(category => category.id === editor.form.category_id)) editor.form.category_id = ''
})
</script>
