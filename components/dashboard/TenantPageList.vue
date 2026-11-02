<template>
  <div class="space-y-4">
  <DashboardListEditor
    title="Pages"
    :items="listItems"
    :loading="status === 'pending'"
    empty-title="No pages yet"
    empty-icon="i-lucide-file-text"
    add-label="Add a page"
    :error="loadError"
    :removing-id="removingId"
    @add="navigateTo(`${level.path.value}/new`)"
    @remove="remove"
  />
  <UAlert v-if="deleteError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="deleteError" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'
import { isTenantPageListResponse, tenantPageRows, type TenantPageListRow } from '~/composables/useTenantPageDraft'

const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const organizationId = await useDashboardOrganizationId()
const level = useRouteLevel()

/**
 * The links page is a page in this list and a level nested under Pages at a
 * URL of its own, so its row is resolved from the route it is rather than by
 * assembling the organization's path a second time.
 */
const linksPath = computed(() => router.resolve({
  name: 'dashboard-orgSlug-website-pages-links',
  params: { orgSlug: route.params.orgSlug },
}).path)

const { data, error, status, refresh } = await useAsyncData(
  `tenant-pages-${organizationId}`,
  () => dashboardApi<{ pages: TenantPageListRow[] }>(`/api/editor/organizations/${organizationId}/pages`, { validate: isTenantPageListResponse }),
  {
    getCachedData(cacheKey, nuxtApp, ctx) {
      if (ctx?.cause === 'refresh:manual' || ctx?.cause === 'refresh:hook') return undefined
      return nuxtApp.payload.data[cacheKey] as { pages: TenantPageListRow[] } | undefined
    },
  },
)

if (import.meta.client) {
  onMounted(() => {
    if (useNuxtApp().payload.data[`tenant-pages-${organizationId}`]) {
      void refresh()
    }
  })
}

const loadError = computed(() => (error.value ? getErrorMessage(error.value, 'Failed to load pages') : null))

const listItems = computed(() => tenantPageRows(data.value?.pages ?? []).map(row => ({
  ...row,
  to: row.recipe === 'links' ? linksPath.value : `${level.path.value}/${row.id}`,
})))

const removingId = ref<string | null>(null)
const deleteError = ref<string | null>(null)

/**
 * Remove a page and everything under it. The index owns adding and removing a
 * record; the leaf edits the one it was opened on (DESIGN.md).
 *
 * The server refuses the pages that may not go -- a system page, and a path the
 * template renders a document at -- so this reports what it said rather than
 * keeping a second copy of the rule that would drift from it.
 */
async function remove(item: { id: string; updatedAt: string }) {
  removingId.value = item.id
  deleteError.value = null
  const previousPages = data.value?.pages ? [...data.value.pages] : []
  // Optimistic update: remove immediately from UI
  if (data.value?.pages) {
    data.value = {
      ...data.value,
      pages: data.value.pages.filter(p => p.id !== item.id),
    }
  }
  let deleted = false
  try {
    await dashboardApi(`/api/editor/organizations/${organizationId}/pages/${item.id}`, {
      method: 'DELETE',
      body: { expectedUpdatedAt: item.updatedAt },
      validate: isRecord,
    })
    deleted = true
    await refresh()
  } catch (error) {
    // Rollback only if the delete itself failed
    if (!deleted && data.value) {
      data.value = {
        ...data.value,
        pages: previousPages,
      }
    }
    deleteError.value = getErrorMessage(error, 'Failed to remove the page')
  } finally {
    removingId.value = null
  }
}
</script>
