<template>
  <div class="space-y-6">
    <!-- Which page these questions belong to. A location's questions are its own; only the site's are filed by page. -->
    <div v-if="!locationScope" class="flex justify-end">
      <USelect v-model="selectedPagePath" :items="pageScopes" class="w-48" aria-label="Q&A page scope" />
    </div>

  <DashboardListEditor
    v-model:editing="editing"
    title="Q&A"
    :items="listItems"
    :error="qaError ? getErrorMessage(qaError, 'Q&A request failed') : null"
    :empty-title="locationScope ? 'No Q&A yet' : 'No site Q&A yet'"
    empty-icon="i-lucide-circle-help"
    add-label="Add a question"
    reorderable
    :removing-id="removingId"
    @add="openNew"
    @remove="removeItem"
    @move="move"
  >
    <template #item="{ item }">
      <div class="flex flex-wrap items-center gap-2">
        <UBadge :color="item.row.status === 'published' ? 'success' : 'neutral'" variant="soft">{{ item.row.status }}</UBadge>
        <UBadge v-if="item.row.source === 'import'" color="neutral" variant="subtle">From Google</UBadge>
        <span v-if="item.row.upvote_count" class="text-xs text-muted">{{ item.row.upvote_count }} upvotes</span>
      </div>
      <p class="mt-2 text-sm font-medium text-highlighted">{{ item.title }}</p>
      <p class="mt-1 line-clamp-2 text-sm text-muted" :class="item.row.answer ? '' : 'italic'">{{ item.row.answer || 'No answer yet.' }}</p>
    </template>
  </DashboardListEditor>
  <UAlert v-if="listError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="listError" />
  </div>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import { getErrorMessage } from '~/utils/errors'
import { isQaDeleted, isQaResponse, type QaRow } from '~/utils/organization-qa'
/** Set when this list is a location's Q&A rather than the site's. */
// The location the URL scopes this to with `?location_id=`, or none for the whole site.
const locationScope = useLocationScope()

const dashboardApi = useDashboardApi()
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const organizationId = await useDashboardOrganizationId()
const selectedPagePath = computed({
  get() {
    if (locationScope.value || route.query.page_path === undefined) return 'general'
    const pagePath = route.query.page_path
    if (typeof pagePath !== 'string' || !pagePath.trim() || !pagePath.startsWith('/') || pagePath.startsWith('//')) {
      throw createError({ statusCode: 400, statusMessage: 'Choose one page for these questions.', fatal: true })
    }
    return pagePath
  },
  set(value: string) {
    void router.replace({ query: { ...route.query, page_path: value === 'general' ? undefined : value } })
  },
})

const qaEndpoint = computed(() => locationScope.value
  ? `/api/editor/organizations/${organizationId}/locations/${locationScope.value}/qa`
  : `/api/editor/organizations/${organizationId}/qa`)

// The three reads are independent, so they are issued together.
const tenantPagesAsyncData = useAsyncData(
  () => `dashboard-tenant-pages-${organizationId}`,
  async () => {
    if (locationScope.value) return []
    return await dashboardApi<Array<{ path: string; title: string }>>(
      `/api/editor/organizations/${organizationId}/tenant-pages`,
      {
        validate: (value): value is Array<{ path: string; title: string }> =>
          Array.isArray(value)
          && value.every(page =>
            isRecord(page)
            && typeof page.path === 'string'
            && typeof page.title === 'string',
          ),
      },
    )
  },
)

const existingQaScopesAsyncData = useAsyncData(
  () => `dashboard-qa-scopes-${organizationId}`,
  async () => {
    if (locationScope.value) return []
    return await dashboardApi<Array<{ page_path: string | null }>>(
      `/api/editor/organizations/${organizationId}/qa/scopes`,
      {
        validate: (value): value is Array<{ page_path: string | null }> =>
          Array.isArray(value)
          && value.every(scope =>
            isRecord(scope)
            && (scope.page_path === null || typeof scope.page_path === 'string'),
          ),
      },
    )
  },
)

const pagePath = computed(() => selectedPagePath.value === 'general' ? null : selectedPagePath.value)
const qaAsyncData = useAsyncData(
  () => locationScope.value ? `dashboard-location-qa-${organizationId}-${locationScope.value}` : `dashboard-organization-qa-${organizationId}-${selectedPagePath.value}`,
  () => dashboardApi<{ qa: QaRow[] }>(qaEndpoint.value, {
    query: pagePath.value ? { page_path: pagePath.value } : undefined,
    validate: isQaResponse,
  }),
)

const [
  { data: tenantPages },
  { data: existingQaScopes },
  { data, refresh, error: qaError },
] = await Promise.all([tenantPagesAsyncData, existingQaScopesAsyncData, qaAsyncData])

const pageScopes = computed(() => {
  const scopes = new Map<string, string>()
  scopes.set('general', 'Whole site')

  for (const page of tenantPages.value ?? []) {
    if (page.path && !scopes.has(page.path)) {
      scopes.set(page.path, page.title || page.path)
    }
  }

  for (const scope of existingQaScopes.value ?? []) {
    if (scope.page_path && !scopes.has(scope.page_path)) {
      scopes.set(scope.page_path, scope.page_path)
    }
  }

  return Array.from(scopes.entries()).map(([value, label]) => ({ label, value }))
})
const qaRows = computed(() => data.value?.qa ?? [])
// A Google question is Google's: the server refuses to change or remove one,
// so the row shows no remove control rather than offering a click that fails.
const listItems = computed(() => qaRows.value.map(row => ({
  id: row.id,
  title: row.question,
  removable: row.source !== 'import',
  to: router.resolve({ path: `${level.path.value}/${row.id}`, query: route.query }).fullPath,
  row,
})))

const editing = ref(false)
const removingId = ref<string | null>(null)
const listError = ref<string | null>(null)

// A question opens its own level rather than a sheet over the list, so the
// record has a URL and adding and editing are the same screen. The page the
// list is filtered to rides along as the new record's intended scope.
function openNew() {
  void navigateTo({ path: `${level.path.value}/new`, query: { ...(locationScope.value ? { location_id: locationScope.value } : {}), ...(pagePath.value ? { page_path: pagePath.value } : {}) } })
}

async function removeItem(item: { id: string }) {
  removingId.value = item.id
  listError.value = null
  try {
    await dashboardApi(`${qaEndpoint.value}/${item.id}`, {
      method: 'DELETE',
      query: pagePath.value ? { page_path: pagePath.value } : undefined,
      validate: isQaDeleted,
    })
    await refresh()
  } catch (error) {
    listError.value = error instanceof Error ? error.message : 'Failed to remove question'
  } finally {
    removingId.value = null
  }
}

async function move(item: { id: string }, direction: -1 | 1) {
  const index = qaRows.value.findIndex(row => row.id === item.id)
  const current = qaRows.value[index]
  const target = qaRows.value[index + direction]
  if (!current || !target) return
  listError.value = null
  try {
    await dashboardApi(`${qaEndpoint.value}/reorder`, {
      method: 'POST',
      body: { ...(locationScope.value ? {} : { page_path: pagePath.value }), updates: [{ id: current.id, sort_order: target.sort_order }, { id: target.id, sort_order: current.sort_order }] },
      validate: (value): value is { updated: number } =>
        isRecord(value) && typeof value.updated === 'number',
    })
  } catch (error) {
    listError.value = error instanceof Error ? error.message : 'Failed to move question'
  }
  await refresh()
}

// Switching scope shows a different list, so the edit state goes with it.
watch(selectedPagePath, () => {
  editing.value = false
})
</script>
