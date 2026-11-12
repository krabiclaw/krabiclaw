<template>
  <div class="space-y-4">
    <!-- Subtitle matching Airbnb Photo tour header -->
    <p class="text-sm text-muted leading-relaxed">
      Manage pages and add sections. Guests and clients will only see content you publish.
    </p>

    <!-- Error alert if loading fails -->
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="loadError" />

    <!-- Airbnb Parity: Task Banner (amber dot, "View your tasks", opens Page tasks modal) -->
    <button
      v-if="tasks.length > 0"
      type="button"
      class="w-full flex items-center justify-between p-4 sm:p-5 rounded-2xl bg-[#F7F7F7] dark:bg-neutral-800 text-left transition hover:bg-neutral-200/70 dark:hover:bg-neutral-700/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      data-testid="pages-tasks-banner"
      @click="tasksModalOpen = true"
    >
      <div class="flex items-center gap-2.5">
        <span class="size-2.5 rounded-full bg-amber-500 shrink-0" />
        <span class="text-sm sm:text-base font-semibold text-highlighted">View your tasks ({{ tasks.length }})</span>
      </div>
      <UIcon name="i-lucide-chevron-right" class="size-5 text-muted shrink-0" />
    </button>

    <!-- Loading spinner -->
    <div v-if="status === 'pending' && !listItems.length" class="flex min-h-48 items-center justify-center">
      <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-muted" />
    </div>

    <!-- Empty State -->
    <div
      v-else-if="!listItems.length"
      class="rounded-3xl border border-dashed border-default p-10 text-center"
    >
      <UIcon name="i-lucide-file-text" class="size-10 text-muted mx-auto mb-3" />
      <h3 class="text-base font-semibold text-highlighted">No pages yet</h3>
      <p class="text-sm text-muted mt-1 mb-4">Create your first page to start customizing your storefront.</p>
      <UButton
        icon="i-lucide-plus"
        color="neutral"
        label="Add a page"
        :to="`${level.path.value}/new`"
      />
    </div>

    <!-- Airbnb Portrait Image Cards Grid -->
    <div v-else class="grid grid-cols-2 sm:grid-cols-3 gap-4 sm:gap-6 pt-2">
      <NuxtLink
        v-for="item in listItems"
        :key="item.id"
        :to="item.to"
        class="group block text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary rounded-2xl"
        :data-testid="`page-card-${item.id}`"
      >
        <!-- Portrait Image Card -->
        <div class="relative aspect-[3/4] w-full overflow-hidden rounded-2xl bg-[#F7F7F7] dark:bg-neutral-800 border border-neutral-200/70 dark:border-neutral-800 flex items-center justify-center transition-shadow group-hover:shadow-md">
          <!-- Real page photo -->
          <img
            v-if="item.imageUrl"
            :src="item.imageUrl"
            alt=""
            class="size-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
          <!-- Empty state when page has no cover/OG photo -->
          <div v-else class="flex flex-col items-center justify-center p-4 text-center">
            <UIcon
              name="i-lucide-image"
              class="size-10 sm:size-12 text-neutral-300 dark:text-neutral-600 transition-transform duration-300 group-hover:scale-110"
            />
          </div>
        </div>

        <!-- Page title below image -->
        <h3 class="mt-2.5 text-base font-semibold text-highlighted group-hover:underline truncate">
          {{ item.title }}
        </h3>

        <!-- Number of sections below title -->
        <p class="mt-0.5 text-sm text-muted">
          {{ formatSections(item.sectionCount) }}
        </p>
      </NuxtLink>
    </div>

    <!-- Page Tasks Modal -->
    <PageTasksModal
      v-model="tasksModalOpen"
      :tasks="tasks"
      @dismiss="dismissTask"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getErrorMessage } from '~/utils/errors'
import { isTenantPageListResponse, tenantPageRows, type PageTask, type TenantPageListRow } from '~/composables/useTenantPageDraft'
import PageTasksModal from '~/components/dashboard/PageTasksModal.vue'

const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const organizationId = useDashboardOrganizationId()
const level = useRouteLevel()

const tasksModalOpen = ref(false)
const dismissedTaskIds = ref<Set<string>>(new Set())

const linksPath = computed(() => router.resolve({
  name: 'dashboard-orgSlug-website-pages-links',
  params: { orgSlug: route.params.orgSlug },
}).path)

const { data, error, status, refresh } = await useAsyncData(
  `tenant-pages-${organizationId}`,
  () => dashboardApi<{ pages: TenantPageListRow[]; tasks?: PageTask[] }>(`/api/editor/organizations/${organizationId}/pages`, { validate: isTenantPageListResponse }),
  {
    getCachedData(cacheKey, nuxtApp, ctx) {
      if (ctx?.cause === 'refresh:manual' || ctx?.cause === 'refresh:hook') return undefined
      return nuxtApp.payload.data[cacheKey] as { pages: TenantPageListRow[]; tasks?: PageTask[] } | undefined
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

const tasks = computed<PageTask[]>(() => {
  const allTasks = data.value?.tasks ?? []
  return allTasks.filter(task => !dismissedTaskIds.value.has(task.id))
})

function dismissTask(taskId: string) {
  dismissedTaskIds.value.add(taskId)
}

function formatSections(count?: number): string {
  if (!count || count === 0) return 'Add sections'
  return `${count} ${count === 1 ? 'section' : 'sections'}`
}
</script>
