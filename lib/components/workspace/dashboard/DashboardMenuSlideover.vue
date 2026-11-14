<template>
  <USlideover
    v-model:open="open"
    title="Menu"
    :ui="{
      body: 'overflow-y-auto',
      // Nuxt UI floats the close button with `absolute end-4`, which would leave
      // search stranded next to the title while the menu page renders it on
      // the right. Returning close to the flow lets both sit together, search
      // then close, the way the menu page's navbar already lays them out.
      close: 'static',
    }"
  >
    <template #actions>
      <div class="ms-auto flex items-center gap-1.5">
        <UButton
          v-if="!personal"
          icon="i-lucide-search"
          aria-label="Search"
          color="neutral"
          variant="ghost"
          square
          data-testid="dashboard-search"
          @click="openSearch"
        />
      </div>
    </template>

    <template #body>
      <DashboardMenuContent />
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import DashboardMenuContent from './DashboardMenuContent.vue'
import { dashboardSearchOpenKey } from './dashboardPanelContext'

const open = defineModel<boolean>('open', { default: false })

const route = useRoute()
const openDashboardSearch = inject(dashboardSearchOpenKey)!
const { personal } = useDashboardMenu()

function openSearch() {
  open.value = false
  openDashboardSearch()
}

// DashboardMenuContent renders plain NuxtLinks, so a selection navigates the
// page underneath the slideover rather than closing it. Close on the resulting
// path change instead of wrapping every item in a click handler.
watch(() => route.path, () => { open.value = false })
</script>
