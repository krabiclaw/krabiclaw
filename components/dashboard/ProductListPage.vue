<template>
  <!--
    Catalog opens on the three ways into what the organization offers — its
    Menu, its Experiences, its Services — and All items for everything,
    whatever its kind. These are entry points, not groupings anyone creates:
    every organization has all three, whatever its template. Each opens a
    view suited to its task; every offering opens the one Product editor.
  -->
  <DashboardIndexPanel id="catalog" title="Catalog" column>
    <template #right>
      <UButton :to="`${level.path.value}/new/kind`" icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add" data-testid="catalog-add" />
    </template>

    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Catalog could not be loaded" :description="loadError" />
    <div v-else class="space-y-6">
      <div class="grid grid-cols-3 gap-3">
        <NuxtLink
          v-for="entry in entries"
          :key="entry.id"
          :to="entry.to"
          class="flex aspect-square flex-col rounded-2xl border border-default bg-elevated p-4 transition-colors hover:bg-accented"
          :data-testid="`catalog-entry-${entry.id}`"
        >
          <UIcon :name="entry.icon" class="size-6 text-muted" />
          <p class="mt-auto text-[15px] font-semibold text-highlighted">{{ entry.label }}</p>
          <p class="mt-1 text-sm text-muted">{{ entry.summary }}</p>
        </NuxtLink>
      </div>

      <EditorNavigationList :groups="allItems" :active-item="level.child.value" />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { getErrorMessage } from '~/utils/errors'

// The level runs while setup is still synchronous: it injects the record the
// `<RouterView>` above rendered, and an `await` before it would bind nothing.
const level = useRouteLevel()
const organizationId = await useDashboardOrganizationId()
const catalog = useProductCatalog(organizationId, ref(null))
await catalog.load
const { locations, error: locationsError } = await useOrganizationLocations()

const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The catalog could not be loaded') : null
})

const count = (kind: string) => catalog.products.value.filter(product => product.kind === kind).length
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// A menu belongs to a location. With one location there is nothing to choose,
// so the Menu opens on it; with several, the Menu asks which.
const menuTo = computed(() => locations.value.length === 1
  ? `${level.path.value}/menu?location_id=${encodeURIComponent(locations.value[0]!.id)}`
  : `${level.path.value}/menu`)

// The menu's sections, as the Menu lists them: holding dishes, or still empty.
const menuSectionCount = computed(() => catalog.collections.value.filter((collection) => {
  const members = catalog.products.value.filter(product => product.collections.some(entry => entry.collection_id === collection.id))
  return !members.length || members.some(product => product.kind === 'dish')
}).length)

const entries = computed(() => [
  { id: 'menu', label: 'Menu', icon: 'i-lucide-utensils', to: menuTo.value, summary: plural(menuSectionCount.value, 'section', 'sections') },
  { id: 'experiences', label: 'Experiences', icon: 'i-lucide-sparkles', to: `${level.path.value}/experiences`, summary: plural(count('experience'), 'experience', 'experiences') },
  { id: 'services', label: 'Services', icon: 'i-lucide-briefcase', to: `${level.path.value}/services`, summary: plural(count('service'), 'service', 'services') },
])

const allItems = computed<EditorNavigationGroup[]>(() => [{
  id: 'all',
  items: [{
    id: 'all',
    label: 'All items',
    summary: plural(catalog.products.value.length, 'item', 'items'),
    lead: { icon: 'i-lucide-layout-grid' },
    to: `${level.path.value}/all`,
  }],
}])

useSeoMeta({ title: 'Catalog | Krabiclaw Dashboard', robots: 'noindex, nofollow' })
</script>
