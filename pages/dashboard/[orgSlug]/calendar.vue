<template>
  <UDashboardPanel v-if="scopeError || scopePending" id="calendar-scope">
    <template #header><UDashboardNavbar title="Calendar" /></template>
    <UAlert v-if="scopeError" class="m-6" color="error" variant="soft" title="The calendar could not be loaded" :description="scopeError" />
    <p v-else role="status" class="p-6 text-muted">Loading calendar…</p>
  </UDashboardPanel>
  <StayNightCalendar
    v-else-if="stayScope"
    :key="productId!"
    :product-id="productId!"
    :homes="homes?.homes ?? []"
    :manage="homes?.manage ?? false"
    :home-error="homesError ? getErrorMessage(homesError, 'The places to stay could not be loaded') : ''"
    :offering-items="offeringItems"
    :offerings-error="offeringsError"
  />
  <CalendarPage v-else :key="productId ?? 'agenda'" :session-product="scoped?.product" :session-locations="scoped?.locations ?? []" :offering-items="offeringItems" :offerings-error="offeringsError" :can-create-stay="Boolean(homes?.manage && homes.homes.length)" />
</template>

<script setup lang="ts">
import CalendarPage from '~/components/dashboard/CalendarPage.vue'
import StayNightCalendar from '~/components/dashboard/StayNightCalendar.vue'
import type { StayHome } from '~/server/domain/stays'
import type { Product } from '~/server/types/products'
import type { DashboardLocation } from '~/composables/useDashboardOrganization'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { getErrorMessage } from '~/utils/errors'
import { isValidTimezone } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard', tab: 'calendar' })

const route = useRoute()
const api = useDashboardApi()
const organizationId = await useDashboardOrganizationId()
const dashboard = useDashboardOrganization()
const hasProductScope = computed(() => Object.hasOwn(route.query, 'product_id'))
const productId = computed(() => typeof route.query.product_id === 'string' && route.query.product_id.trim() ? route.query.product_id : null)
const canReadSessions = computed(() => {
  const role = dashboard.organization.value?.role as keyof typeof organizationRoles | undefined
  return Boolean(role && (authClient.organization.checkRolePermission({ role, permissions: { products: ['update'] } }) || authClient.organization.checkRolePermission({ role, permissions: { products: ['assigned'] } })))
})
const isProduct = (value: unknown): value is Product => isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.kind === 'string' && Array.isArray(value.locations) && value.locations.every(entry => isRecord(entry) && typeof entry.location_id === 'string') && (value.booking === null || isRecord(value.booking))
type Homes = { homes: Pick<StayHome, 'product_id' | 'name' | 'timezone'>[]; manage: boolean }
const isHomes = (value: unknown): value is Homes => isRecord(value) && typeof value.manage === 'boolean' && Array.isArray(value.homes)
  && value.homes.every(home => isRecord(home) && typeof home.product_id === 'string' && typeof home.name === 'string' && typeof home.timezone === 'string' && isValidTimezone(home.timezone))
const { data: homes, error: homesError } = await useAsyncData(
  () => `calendar-homes:${String(route.params.orgSlug)}`,
  () => api('/api/dashboard/stay-homes', { validate: isHomes }),
)
const { data: products, error: productsError } = await useAsyncData(
  () => `calendar-offerings:${organizationId}:${dashboard.organization.value?.role ?? ''}`,
  () => canReadSessions.value ? api(`/api/editor/organizations/${organizationId}/products`, { validate: (value): value is { products: Product[] } => isRecord(value) && Array.isArray(value.products) && value.products.every(isProduct) }) : Promise.resolve({ products: [] }),
)
const knownHome = computed(() => homes.value?.homes.find(home => home.product_id === productId.value))
const { data: scoped, error: productError, pending } = await useAsyncData(
  () => `calendar-offering:${organizationId}:${productId.value ?? ''}:${Boolean(knownHome.value)}`,
  async () => {
    if (!productId.value || knownHome.value || !canReadSessions.value) return null
    if (productsError.value) throw productsError.value
    if (!products.value?.products.some(product => product.id === productId.value)) throw new Error('That offering is not available in this organization.')
    const response = await api(`/api/editor/organizations/${organizationId}/products/${productId.value}`, { validate: (value): value is { product: Product } => isRecord(value) && isProduct(value.product) })
    const product = response.product
    if (product.kind === 'stay') return { product, locations: [] as DashboardLocation[] }
    if (!['experience', 'service'].includes(product.kind) || !product.booking) throw new Error('This offering has no session availability. Choose a configured experience or legal consultation.')
    const locations = await api('/api/dashboard/locations', { query: { organization: 'true', status: 'all' }, validate: (value): value is { locations: DashboardLocation[] } => isRecord(value) && Array.isArray(value.locations) })
    return { product, locations: locations.locations }
  },
)
const scopePending = computed(() => hasProductScope.value && pending.value)
const scopeError = computed(() => {
  if (hasProductScope.value && !productId.value) return 'Choose one offering with a non-empty product_id.'
  if (productId.value && !knownHome.value && !canReadSessions.value) return 'That offering is not available in this organization.'
  if (Object.hasOwn(route.query, 'locationId') && (typeof route.query.locationId !== 'string' || !route.query.locationId.trim())) return 'Choose one location with a non-empty locationId.'
  return productError.value ? getErrorMessage(productError.value, 'The offering could not be loaded') : ''
})
const stayScope = computed(() => Boolean(knownHome.value || scoped.value?.product.kind === 'stay'))
const offeringItems = computed(() => [
  { label: 'All activity', value: AGENDA_FILTER_ALL },
  ...(homes.value?.homes ?? []).map(home => ({ label: `Availability: ${home.name}`, value: home.product_id })),
  ...(products.value?.products ?? []).filter(product => ['experience', 'service'].includes(product.kind) && product.booking).map(product => ({ label: `Availability: ${product.name}${product.active ? '' : ' · Paused'}`, value: product.id })),
])
const offeringsError = computed(() => homesError.value ? getErrorMessage(homesError.value, 'The places to stay could not be loaded') : productsError.value ? getErrorMessage(productsError.value, 'The offerings could not be loaded') : '')
</script>
