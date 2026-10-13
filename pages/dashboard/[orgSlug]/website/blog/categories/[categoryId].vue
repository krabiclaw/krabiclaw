<template>
  <DashboardLeafPanel
    id="organization-blog-category"
    :title="category?.name ?? 'Category'"
    :saving="saving"
    :disabled="!form?.dirty || !name.trim()"
    :error="actionError || loadFailure"
    @cancel="reset(); revision += 1"
    @save="form?.submit()"
  >
    <template v-if="category" #right>
      <DashboardResourceLocalization
        :organization-id="organizationId"
        resource-type="article_category"
        :resource-id="category.id"
        resource-label="category"
        :fields="localizationFields"
        :language-settings-path="`/dashboard/${route.params.orgSlug}/website/localization`"
      />
    </template>
    <UForm v-if="category" ref="form" :key="revision" :state="{ name, description, parent }" class="space-y-6" @submit="save">
      <UFormField label="Name" required>
        <UInput v-model="name" autofocus class="w-full" />
      </UFormField>
      <UFormField label="Description" help="Shown on the category's page and used as its search description.">
        <UTextarea v-model="description" :rows="4" autoresize class="w-full" />
      </UFormField>
      <!-- Where it sits: under another category of the collection, or at the top. Its page's address does not change. -->
      <UFormField label="Parent" help="Categories nest up to three levels deep.">
        <USelect v-model="parent" :items="parentOptions" value-key="value" class="w-full" />
      </UFormField>
    </UForm>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import { isCategoryResponse, type DashboardArticleCategory } from '~/composables/useArticleCategories'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const dashboardApi = useDashboardApi()
const organizationId = await useDashboardOrganizationId()
const categoryId = computed(() => String(route.params.categoryId))

const { data, error, refresh } = await useAsyncData(
  () => `article-category:${organizationId}:${categoryId.value}`,
  async () => (await dashboardApi(`/api/editor/organizations/${organizationId}/blog/categories/${categoryId.value}`, { validate: isCategoryResponse })).category,
)
// A category the site does not have is not a page: it 404s rather than drawing an editor for it.
watchEffect(() => {
  if (level.mode.value !== 'yield' && error.value && isNotFoundError(error.value)) showError(createError({ statusCode: 404, statusMessage: 'Category not found' }))
})
const loadFailure = computed(() => error.value && !isNotFoundError(error.value) ? getErrorMessage(error.value, 'The category could not be loaded') : '')

const category = computed<DashboardArticleCategory | null>(() => data.value ?? null)
const localizationFields = computed(() => [
  { key: 'name', label: 'Name', source: category.value?.name },
  { key: 'description', label: 'Description', source: category.value?.description, multiline: true },
])
const { data: siblings } = await useArticleCategories(organizationId, () => category.value?.collection ?? 'blog')
// The top of the collection is the empty choice; a category cannot sit under itself or anything under it.
const TOP_LEVEL = ''
const parentOptions = computed(() => {
  const all = siblings.value ?? []
  const excluded = new Set<string>([categoryId.value])
  for (let grew = true; grew;) {
    grew = false
    for (const row of all) if (row.parent_id && excluded.has(row.parent_id) && !excluded.has(row.id)) { excluded.add(row.id); grew = true }
  }
  return [{ label: 'Top level', value: TOP_LEVEL }, ...all.filter(row => !excluded.has(row.id)).map(row => ({ label: row.name, value: row.id }))]
})
const name = ref('')
const description = ref('')
const parent = ref(TOP_LEVEL)
function reset() {
  name.value = category.value?.name ?? ''
  description.value = category.value?.description ?? ''
  parent.value = category.value?.parent_id ?? TOP_LEVEL
}
watch(category, reset, { immediate: true })
const form = useTemplateRef('form')
// Cancel restores the draft; a new revision is a fresh form, so nothing reads as changed.
const revision = ref(0)

const saving = ref(false)
const actionError = ref('')
async function save() {
  saving.value = true
  actionError.value = ''
  try {
    await dashboardApi(`/api/editor/organizations/${organizationId}/blog/categories/${categoryId.value}`, {
      method: 'PATCH', body: { name: name.value.trim(), description: description.value.trim() || null, parent_id: parent.value || null }, validate: isCategoryResponse,
    })
    await Promise.all([refresh(), refreshNuxtData(`article-categories:${organizationId}:${category.value?.collection}`)])
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'The category could not be saved')
  } finally {
    saving.value = false
  }
}
</script>
