<template>
  <!--
    Catalog is where everything the business offers is found, as Airbnb's Your
    listings: kind pills, then one card per thing. A menu is one card per
    location, opening that location's menu, so the locations need no filter of
    their own; every other offering is its own card, opening the one Product editor.
  -->
  <DashboardIndexPanel id="catalog" title="Catalog">
    <template #right>
      <UButton v-if="canCreate" :to="newProductTo" icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add" data-testid="catalog-add" />
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
import OrganizationLocationSelector, { type OrganizationLocationSelectorItem } from '~/components/dashboard/OrganizationLocationSelector.vue'
import type { CatalogScreen } from '~/shared/catalog-screen'
import { getErrorMessage } from '~/utils/errors'

interface CatalogView {
  screen: CatalogScreen
  kind: string
  filters: Array<{ value: string; label: string }>
  can_create: boolean
  has_stays: boolean
}
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const organizationId = useDashboardOrganizationId()
const { organization } = useDashboardOrganization()
const dashboardApi = useDashboardApi()
const kind = computed({
  get: () => typeof route.query.kind === 'string' ? route.query.kind : 'all',
  set: (value: string) => void navigateTo({ path: level.path.value, query: { ...route.query, kind: value === 'all' ? undefined : value } }),
})
const { data: catalog, error: catalogError } = await useAsyncData(
  () => `dashboard-catalog:${organizationId}:${kind.value}`,
  () => dashboardApi('/api/dashboard/catalog', {
    query: { kind: kind.value },
    validate: (value): value is CatalogView => isRecord(value) && isRecord(value.screen) && Array.isArray(value.screen.rows) && Array.isArray(value.filters) && typeof value.can_create === 'boolean' && typeof value.has_stays === 'boolean',
  }),
)
const loadError = computed(() => catalogError.value ? getErrorMessage(catalogError.value, 'The catalog could not be loaded') : null)
const kindFilters = computed(() => catalog.value?.filters ?? [])
const canCreate = computed(() => catalog.value?.can_create === true)
const newProductTo = computed(() => router.resolve({ path: `${level.path.value}/new`, query: kind.value === 'all' ? {} : { kind: kind.value === 'menu' ? 'dish' : kind.value } }).fullPath)
const activeFilterLabel = computed(() => catalog.value?.filters.find(item => item.value === catalog.value?.kind)?.label ?? 'offerings')
const items = computed<OrganizationLocationSelectorItem[]>(() => (catalog.value?.screen.rows ?? []).map(row => {
  if (!row.to) throw new Error('The Catalog row has no dashboard destination')
  return { id: row.id, label: row.label, imageUrl: row.image ?? null, eyebrow: row.eyebrow ?? '', summary: row.summary ?? '', to: row.to }
}))

interface HomeSetupAction { label: string; detail: string; to: string }
interface FirstHomeSetup { title: string; manual: HomeSetupAction; airbnb: HomeSetupAction & { can_connect: boolean } }

function isHomeSetupAction(value: unknown): value is HomeSetupAction {
  return isRecord(value) && typeof value.label === 'string' && typeof value.detail === 'string'
    && typeof value.to === 'string' && value.to.startsWith('/dashboard/')
}

const showFirstHomeSetup = computed(() => canCreate.value && organization.value?.vertical === 'lodging' && catalog.value?.has_stays === false
  && (kind.value === 'stay' || (kind.value === 'all' && items.value.length === 0)))
const loadsHomeSetup = computed(() => canCreate.value && organization.value?.vertical === 'lodging' && (kind.value === 'stay' || showFirstHomeSetup.value))
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
