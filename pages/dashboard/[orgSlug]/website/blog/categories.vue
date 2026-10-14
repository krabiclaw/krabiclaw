<template>
  <!--
    A collection's categories: the grouping of its public index, sidebar and
    breadcrumb, each with its own page. A list of records, so nothing opens on
    arrival; each row opens the category.
  -->
  <DashboardIndexPanel id="organization-blog-categories" title="Categories">
    <div class="space-y-6">
      <DashboardListEditor
        v-model:editing="editing"
        title="Categories"
        description="Readers browse articles by category, in this order, with subcategories under their parent. Every published article is in one."
        :items="listItems"
        :error="loadError"
        empty-title="No categories yet"
        empty-icon="i-lucide-folder"
        add-label="Add a category"
        reorderable
        :removing-id="removingId"
        @add="adding = true"
        @remove="removeCategory"
        @move="moveCategory"
      >
        <template #filters>
          <UTabs v-model="collection" :items="collectionTabs" :content="false" aria-label="Collection" />
        </template>
        <template #item="{ item }">
          <!-- A subcategory sits indented under its parent, the way the site's sidebar reads it. -->
          <span class="min-w-0 flex-1" :style="{ paddingInlineStart: `${(item.depth - 1) * 1.5}rem` }" :data-testid="`article-category-${item.id}`">
            <span class="block truncate text-sm font-semibold text-highlighted">{{ item.row.name }}</span>
            <span class="mt-1 block text-sm text-muted">{{ countSummary(item.row) }}</span>
          </span>
        </template>
      </DashboardListEditor>
      <UAlert v-if="actionError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="actionError" />
    </div>

    <!-- Adding asks for what names the category; its description is a field of the category once it exists. -->
    <DashboardListItemDialog
      v-model:open="adding"
      title="New category"
      :removable="false"
      :saving="creating"
      :save-disabled="!newName.trim()"
      save-label="Create"
      @save="createCategory"
    >
      <UFormField label="Name" required>
        <UInput v-model="newName" autofocus class="w-full" @keydown.enter.prevent="newName.trim() && createCategory()" />
      </UFormField>
    </DashboardListItemDialog>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { isCategoryResponse, isCategoriesResponse, type DashboardArticleCategory } from '~/composables/useArticleCategories'
import { ARTICLE_COLLECTIONS, ARTICLE_COLLECTION_SLUGS, type ArticleCollection } from '~/utils/article-collections'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const confirmDialog = useOverlay().create(DashboardConfirmDialog)
useSeoMeta({ title: 'Categories | KrabiClaw Dashboard', robots: 'noindex, nofollow' })

const dashboardApi = useDashboardApi()
const organizationId = await useDashboardOrganizationId()
const level = useRouteLevel()

const collectionTabs = ARTICLE_COLLECTION_SLUGS.map(slug => ({ value: slug, label: ARTICLE_COLLECTIONS[slug].label }))
const collection = ref<ArticleCollection>('blog')
const { data, error, refresh } = await useArticleCategories(organizationId, collection)

const editing = ref(false)
const removingId = ref<string | null>(null)
const actionError = ref<string | null>(null)
// Reorder is a mode: a category moves among its siblings, taking its
// subcategories with it, and each sibling set that changed commits whole when
// the mode closes. The order is held as each parent's list of children.
const localSiblings = ref<Map<string | null, DashboardArticleCategory[]> | null>(null)
const changedParents = ref(new Set<string | null>())
const siblingsOf = (rows: readonly DashboardArticleCategory[]) => {
  const byParent = new Map<string | null, DashboardArticleCategory[]>()
  for (const row of rows) byParent.set(row.parent_id, [...(byParent.get(row.parent_id) ?? []), row])
  return byParent
}
/** The tree read depth-first, each row with its depth: the server's order, or the one being set. */
const categories = computed(() => {
  const byParent = localSiblings.value ?? siblingsOf(data.value ?? [])
  const rows: Array<{ row: DashboardArticleCategory; depth: number }> = []
  const walk = (parentId: string | null, depth: number) => {
    for (const row of byParent.get(parentId) ?? []) {
      rows.push({ row, depth })
      walk(row.id, depth + 1)
    }
  }
  walk(null, 1)
  return rows
})
const listItems = computed(() => categories.value.map(({ row, depth }) => ({ id: row.id, title: row.name, to: `${level.path.value}/${row.id}`, row, depth })))
function countSummary(row: DashboardArticleCategory) {
  const articles = row.article_count === 1 ? '1 article' : `${row.article_count} articles`
  return row.child_count ? `${articles} · ${row.child_count === 1 ? '1 subcategory' : `${row.child_count} subcategories`}` : articles
}
const loadError = computed(() => error.value ? getErrorMessage(error.value, 'Categories could not be loaded') : null)

const adding = ref(false)
const creating = ref(false)
const newName = ref('')
async function createCategory() {
  creating.value = true
  actionError.value = null
  try {
    const { category } = await dashboardApi(`/api/editor/organizations/${organizationId}/blog/categories`, {
      method: 'POST', body: { collection: collection.value, name: newName.value.trim() }, validate: isCategoryResponse,
    })
    adding.value = false
    newName.value = ''
    await refresh()
    await navigateTo(`${level.path.value}/${category.id}`)
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'The category could not be created')
  } finally {
    creating.value = false
  }
}

// A category that still has articles is refused by the server with how many; the owner moves them first.
async function removeCategory(item: { row: DashboardArticleCategory }) {
  if (!await confirmDialog.open({ title: `Delete ${item.row.name}`, description: 'Articles must be moved out of a category before it can be deleted.', confirmLabel: 'Delete category', cancelLabel: 'Keep category' })) return
  removingId.value = item.row.id
  actionError.value = null
  try {
    await dashboardApi(`/api/editor/organizations/${organizationId}/blog/categories/${item.row.id}`, { method: 'DELETE', validate: isRecord })
    await refresh()
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'The category could not be deleted')
  } finally {
    removingId.value = null
  }
}

function moveCategory(item: { row: DashboardArticleCategory }, direction: -1 | 1) {
  const byParent = new Map(localSiblings.value ?? siblingsOf(data.value ?? []))
  const siblings = [...(byParent.get(item.row.parent_id) ?? [])]
  const from = siblings.findIndex(row => row.id === item.row.id)
  const to = from + direction
  if (from < 0 || to < 0 || to >= siblings.length) return
  ;[siblings[from], siblings[to]] = [siblings[to]!, siblings[from]!]
  byParent.set(item.row.parent_id, siblings)
  localSiblings.value = byParent
  changedParents.value = new Set([...changedParents.value, item.row.parent_id])
}

watch(editing, async (value, previous) => {
  if (!previous || value || !localSiblings.value) return
  const byParent = localSiblings.value
  actionError.value = null
  try {
    for (const parentId of changedParents.value) {
      data.value = (await dashboardApi(`/api/editor/organizations/${organizationId}/blog/categories/order`, {
        method: 'PUT', body: { collection: collection.value, parent_id: parentId, category_ids: (byParent.get(parentId) ?? []).map(row => row.id) },
        validate: isCategoriesResponse,
      })).categories
    }
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'The new order could not be saved')
    await refresh()
  } finally {
    localSiblings.value = null
    changedParents.value = new Set()
  }
})

watch(collection, () => {
  editing.value = false
  localSiblings.value = null
  changedParents.value = new Set()
  actionError.value = null
})
</script>
