<template>
  <DashboardLeafPanel
    id="organization-blog-category"
    :title="category?.name ?? 'Category'"
    :saving="saving"
    :disabled="(!form?.dirty && !actionError) || !name.trim()"
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
        :language-settings-path="`/dashboard/${route.params.org_slug}/website/preferences/localization`"
      />
    </template>
    <UForm v-if="category" ref="form" :key="revision" :state="{ name, description, parent }" class="space-y-6" @submit="save">
      <UFormField name="name" label="Name" required>
        <UInput v-model="name" autofocus class="w-full" />
      </UFormField>
      <UFormField name="description" label="Description">
        <UTextarea v-model="description" :rows="4" autoresize class="w-full" />
      </UFormField>
      <!-- Where it sits: under another category of the collection, or at the top. Its page's address does not change. -->
      <UFormField name="parent" label="Parent">
        <USelect v-model.nullable="parent" :items="parentOptions" value-key="value" class="w-full" />
      </UFormField>
    </UForm>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import { isCategoryResponse, type DashboardArticleCategory } from '~/composables/useArticleCategories'
import { businessChanged } from '~/composables/useDashboardInvalidations'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const dashboardApi = useDashboardApi()
const realtime = useDashboardInvalidations()
const organizationId = useDashboardOrganizationId()
const categoryId = computed(() => String(route.params.category_id))

const { data: siblings, error, refresh } = await useArticleCategories(organizationId, 'blog', true, categoryId)
const category = computed<DashboardArticleCategory | null>(() => siblings.value?.find(row => row.id === categoryId.value) ?? null)
watchEffect(() => {
  if (siblings.value && !category.value && level.mode.value !== 'yield') showError(createError({ statusCode: 404, statusMessage: 'Category not found' }))
})
// A category the site does not have is not a page: it 404s rather than drawing an editor for it.
watchEffect(() => {
  if (level.mode.value !== 'yield' && error.value && isNotFoundError(error.value)) showError(createError({ statusCode: 404, statusMessage: 'Category not found' }))
})
const loadFailure = computed(() => error.value && !isNotFoundError(error.value) ? getErrorMessage(error.value, 'The category could not be loaded') : '')

const localizationFields = computed(() => [
  { key: 'name', label: 'Name', source: category.value?.name },
  { key: 'description', label: 'Description', source: category.value?.description, multiline: true },
])
// A category without a parent is top-level; it cannot sit under itself or anything under it.
const parentOptions = computed(() => {
  const all = siblings.value ?? []
  const excluded = new Set<string>([categoryId.value])
  for (let grew = true; grew;) {
    grew = false
    for (const row of all) if (row.parent_id && excluded.has(row.parent_id) && !excluded.has(row.id)) { excluded.add(row.id); grew = true }
  }
  return [{ label: 'Top level', value: null }, ...all.filter(row => !excluded.has(row.id)).map(row => ({ label: row.name, value: row.id }))]
})
const name = ref('')
const description = ref('')
const parent = ref<string | null>(null)
function reset() {
  name.value = category.value?.name ?? ''
  description.value = category.value?.description ?? ''
  parent.value = category.value?.parent_id ?? null
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
    const saved = await dashboardApi(`/api/editor/organizations/${organizationId}/blog/categories/${categoryId.value}`, {
      method: 'PATCH', body: { name: name.value.trim(), description: description.value.trim() || null, parent_id: parent.value }, validate: isCategoryResponse,
    })
    if (siblings.value) siblings.value = siblings.value.map(row => row.id === saved.category.id ? saved.category : row)
    const held = realtime.held.begin(`website:article-categories:${organizationId}:category:${categoryId.value}`, businessChanged)
    realtime.held.hold(held, siblings.value, Date.now() + 30_000, 16)
    void refresh()
    void refreshNuxtData(`article-categories:${organizationId}:${saved.category.collection}`)
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'The category could not be saved')
  } finally {
    saving.value = false
  }
}
</script>
