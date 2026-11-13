<template>
  <!--
    Catalog is where everything the business offers is found, as Airbnb's Your
    listings: kind pills, then one card per thing. A menu is one card per
    location, opening that location's menu, so the locations need no filter of
    their own; every other offering is its own card, opening the one Product editor.
  -->
  <DashboardIndexPanel id="catalog" title="Catalog">
    <template #right>
      <UButton :to="newProductTo" icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add" data-testid="catalog-add" />
    </template>

    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Catalog could not be loaded" :description="loadError" />
    <template v-else>
      <DashboardFilterPills id="catalog-kind" v-model="kind" label="Kind" :items="kindFilters" class="mb-8" />
      <UAlert
        v-if="loadsHomeSetup && setupError"
        color="error"
        variant="soft"
        class="mb-6"
        title="Home setup could not be loaded"
        :description="getErrorMessage(setupError, 'The request failed')"
      />
      <UButton v-if="kind === 'stay' && setup?.resume_home_setup && !firstHomeSetup" :to="setup.resume_home_setup.to" color="neutral" variant="outline" class="mb-6" :label="setup.resume_home_setup.label" />
      <section v-if="showFirstHomeSetup && firstHomeSetup" class="mx-auto max-w-2xl space-y-5" data-testid="first-home-setup">
        <h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">{{ firstHomeSetup.title }}</h2>
        <div class="grid gap-3 sm:grid-cols-2">
          <NuxtLink
            v-for="choice in firstHomeChoices"
            :key="choice.to"
            :to="choice.to"
            class="flex flex-col gap-4 rounded-2xl border border-default p-5 hover:border-accented"
          >
            <UIcon :name="choice.icon" class="size-7" aria-hidden="true" />
            <div>
              <span class="block font-semibold">{{ choice.label }}</span>
              <span class="mt-1 block text-sm text-muted">{{ choice.detail }}</span>
            </div>
          </NuxtLink>
        </div>
      </section>
      <OrganizationLocationSelector
        v-else-if="items.length"
        :items="items"
        :active-item="level.child.value"
        :label-heading-level="2"
        missing-image-label="No photo"
        missing-image-hint="Add one in this item’s photo editor."
        data-testid="catalog-grid"
      />
      <UEmpty v-else-if="!showFirstHomeSetup || (!setupPending && !setupError)" icon="i-lucide-store" :title="`No ${activeFilterLabel.toLowerCase()} yet`" />
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { catalogProductItem } from '~/components/dashboard/CatalogProductList.vue'
import OrganizationLocationSelector, { type OrganizationLocationSelectorItem } from '~/components/dashboard/OrganizationLocationSelector.vue'
import type { ProductKind } from '~/shared/product-details'
import { groupProductsByCollection } from '~/utils/product-presentation'
import { getErrorMessage } from '~/utils/errors'

const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const organizationId = useDashboardOrganizationId()
// One authorized organization read. Location narrows this projection by its
// explicit product relationships, without dropping membership needed by editors.
const catalog = useProductCatalog(organizationId, ref(null))
const [, { locations, error: locationsError }] = await Promise.all([
  catalog.load,
  useOrganizationLocations({ includeInactive: true }),
])
const { priceLabel } = useCatalogPrice(ref(null), locations)
const loadError = computed(() => {
  const cause = catalog.error.value ?? locationsError.value
  return cause ? getErrorMessage(cause, 'The catalog could not be loaded') : null
})

// The kinds this business offers, in Catalog's order; a kind nobody sells is not a pill.
type CatalogKind = 'all' | 'menu' | Exclude<ProductKind, 'dish'>
const KINDS: Array<{ value: Exclude<CatalogKind, 'all'>; label: string }> = [
  { value: 'menu', label: 'Menu' },
  { value: 'experience', label: 'Experiences' },
  { value: 'service', label: 'Services' },
  { value: 'stay', label: 'Places to stay' },
  { value: 'table', label: 'Tables' },
]
const grouped = computed(() => new Map(groupProductsByCollection(catalog.products.value, catalog.collections.value).map(group => [group.id, group])))
// A section is the menu's when it holds dishes or nothing yet.
const menuCollections = computed(() => catalog.collections.value.filter(collection => {
  const members = grouped.value.get(collection.id)?.products ?? []
  return !members.length || members.some(product => product.kind === 'dish')
}))
const hasMenu = computed(() => menuCollections.value.length > 0 || catalog.products.value.some(product => product.kind === 'dish'))
const offered = (value: Exclude<CatalogKind, 'all'>) => value === 'menu' ? hasMenu.value : catalog.products.value.some(product => product.kind === value)
// The chosen kind is held in the URL, so a filtered Catalog can be linked and gone Back to.
const kind = computed({
  get: (): CatalogKind => KINDS.find(row => row.value === route.query.kind)?.value ?? 'all',
  set: (value: string) => void navigateTo({ path: level.path.value, query: { ...route.query, kind: value === 'all' ? undefined : value } }),
})
const kindFilters = computed(() => [{ value: 'all' as const, label: 'All' }, ...KINDS.filter(row => row.value === kind.value || offered(row.value))])
const newProductTo = computed(() => router.resolve({ path: `${level.path.value}/new`, query: kind.value === 'all' ? {} : { kind: kind.value === 'menu' ? 'dish' : kind.value } }).fullPath)
const activeFilterLabel = computed(() => kind.value === 'all' ? 'offerings' : KINDS.find(row => row.value === kind.value)!.label)

// A menu belongs to a location: one card for each, holding that location's
// sections and the ones every location shares. With no locations there is one menu.
const menuCards = computed<OrganizationLocationSelectorItem[]>(() => {
  const sectionCount = (id: string | null) => menuCollections.value.filter(collection => collection.location_id === null || collection.location_id === id).length
  const sections = (count: number) => `${count} ${count === 1 ? 'section' : 'sections'}`
  if (!locations.value.length) {
    return [{ id: 'menu', label: 'Menu', eyebrow: 'Menu', summary: sections(sectionCount(null)), imageUrl: null, fallbackIcon: 'i-lucide-utensils', to: `${level.path.value}/menu` }]
  }
  return locations.value.map(location => ({
    id: `menu-${location.id}`,
    label: location.title,
    eyebrow: `Menu${location.status === 'active' ? '' : ` (${location.status})`}`,
    summary: sections(sectionCount(location.id)),
    imageUrl: location.picture_url,
    fallbackIcon: 'i-lucide-utensils',
    to: router.resolve({ path: `${level.path.value}/menu`, query: { location_id: location.id } }).fullPath,
  }))
})
const offerings = computed(() => catalog.products.value.filter(product => product.kind !== 'dish' && (kind.value === 'all' || product.kind === kind.value)))
const items = computed<OrganizationLocationSelectorItem[]>(() => [
  ...(hasMenu.value && (kind.value === 'all' || kind.value === 'menu') ? menuCards.value : []),
  ...(kind.value === 'menu' ? [] : offerings.value.map(product => catalogProductItem(product, {
    collections: catalog.collections.value,
    locations: locations.value,
    priceLabel,
    to: `${level.path.value}/${product.id}`,
  }))),
])

interface HomeSetupAction { label: string; detail: string; to: string }
interface FirstHomeSetup { title: string; manual: HomeSetupAction; airbnb: HomeSetupAction & { can_connect: boolean } }

function isHomeSetupAction(value: unknown): value is HomeSetupAction {
  return isRecord(value) && typeof value.label === 'string' && typeof value.detail === 'string'
    && typeof value.to === 'string' && value.to.startsWith('/dashboard/')
}

const { organization } = useDashboardOrganization()
const dashboardApi = useDashboardApi()
const showFirstHomeSetup = computed(() => organization.value?.vertical === 'lodging' && !offered('stay')
  && (kind.value === 'stay' || (kind.value === 'all' && items.value.length === 0)))
const loadsHomeSetup = computed(() => organization.value?.vertical === 'lodging' && (kind.value === 'stay' || showFirstHomeSetup.value))
const { data: setup, error: setupError, pending: setupPending } = await useAsyncData(
  () => `first-home-setup:${organizationId}`,
  () => loadsHomeSetup.value
    ? dashboardApi('/api/dashboard/stay-homes', {
        validate: (value): value is { first_home_setup: FirstHomeSetup | null; resume_home_setup: HomeSetupAction | null } => {
          if (!isRecord(value)) return false
          if (value.resume_home_setup !== null && !isHomeSetupAction(value.resume_home_setup)) return false
          const setup = value.first_home_setup
          return setup === null || (isRecord(setup) && typeof setup.title === 'string'
            && isHomeSetupAction(setup.manual) && isRecord(setup.airbnb)
            && typeof setup.airbnb.can_connect === 'boolean' && isHomeSetupAction(setup.airbnb))
        },
      })
    : Promise.resolve({ first_home_setup: null, resume_home_setup: null }),
  { watch: [kind, showFirstHomeSetup] },
)
const firstHomeSetup = computed(() => setup.value?.first_home_setup)
const firstHomeChoices = computed(() => firstHomeSetup.value ? [
  { ...firstHomeSetup.value.manual, icon: 'i-lucide-house-plus' },
  { ...firstHomeSetup.value.airbnb, icon: 'i-simple-icons-airbnb' },
] : [])

useSeoMeta({ title: 'Catalog | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
