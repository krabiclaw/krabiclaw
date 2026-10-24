<template>
  <DashboardLeafPanel
    v-if="nightlyPrice"
    id="product-price"
    title="Nightly price"
    lead="Your base price for one night."
    desktop-cancel
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || p.photoError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.product.value && p.form.variants[0]" class="space-y-5">
      <UFormField :label="`Per night (${p.currency})`">
        <UInput v-model="p.form.variants[0].price_major" inputmode="decimal" class="w-full" :ui="{ base: 'py-6 text-4xl text-center font-semibold' }" data-testid="product-price" />
      </UFormField>
      <UButton
        :to="{ name: 'dashboard-orgSlug-calendar', params: { orgSlug: String(route.params.orgSlug) }, query: { product_id: p.product.value.id } }"
        label="Open nightly calendar"
        icon="i-lucide-calendar-days"
        color="neutral"
        variant="outline"
      />
    </div>
  </DashboardLeafPanel>
  <DashboardIndexPanel v-else id="product-pricing" :title="p.sectionLabels.price" :auto-open="firstAmount">
    <UAlert v-if="p.loadError.value || p.saveError.value" class="mb-6" color="error" variant="soft" :description="p.loadError.value || p.saveError.value || ''" />
    <EditorNavigationList v-if="p.product.value && !p.loadError.value" :groups="groups" :active-item="activeItem" @act="act" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const { priceLabel } = useCatalogPrice(p.locationId, p.allOrganizationLocations)
const nightlyPrice = computed(() => p.product.value?.kind === 'stay' && p.form.variants.length === 1)
watchEffect(() => {
  if (nightlyPrice.value && level.child.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
const priceLocations = computed(() => p.locationId.value || nightlyPrice.value ? [] : p.allOrganizationLocations.value.filter(location => p.product.value?.locations.some(entry => entry.location_id === location.id)))
const firstAmount = computed(() => !priceLocations.value.length && p.product.value?.variants.length === 1 ? p.sectionPath(`price/amounts/${encodeURIComponent(p.product.value.variants[0]!.id)}`) : null)
const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'prices',
  items: [
    ...p.form.variants.map(variant => ({
      id: `price-${variant.id ?? variant.key}`,
      label: p.form.variants.length === 1 ? p.locationId.value ? 'Amount' : 'Shared price' : `${variant.name}${p.locationId.value ? '' : ' · Shared price'}`,
      summary: variant.price_major ? `${variant.price_major} ${p.currency}` : p.form.variants.length === 1 && typeof p.product.value?.details.pricing_note === 'string' ? p.product.value.details.pricing_note : p.locationId.value ? 'No price set' : 'No shared price set',
      ...(variant.id ? { to: p.sectionPath(`price/amounts/${encodeURIComponent(variant.id)}`) } : {}),
    })),
    ...priceLocations.value.map(location => ({
      id: `location-${location.id}`,
      label: `Price at ${location.title}`,
      summary: `${p.product.value ? priceLabel(p.product.value, true, location.id) || 'No price set' : ''}${location.status === 'active' ? '' : ' · Location inactive'}`,
      to: router.resolve({ path: level.path.value, query: { ...route.query, location_id: location.id } }).fullPath,
    })),
    ...p.form.options.map(option => ({
      id: `option-${option.id}`,
      label: option.name || 'Choice',
      summary: option.values.map(value => value.value).join(', ') || undefined,
      to: p.sectionPath(`price/choices/${encodeURIComponent(option.id)}`),
    })),
    ...(p.form.kind !== 'stay' && p.form.options.length < PRODUCT_LIMITS.options ? [{ id: 'add', icon: 'i-lucide-plus', label: 'Add a choice', action: {} }] : []),
  ],
}])
const activeItem = computed(() => typeof route.params.optionId === 'string' ? `option-${route.params.optionId}` : typeof route.params.variantId === 'string' ? `price-${route.params.variantId}` : null)

function act(id: string) {
  if (id !== 'add') return
  p.addOption()
  void navigateTo(p.sectionPath(`price/choices/${encodeURIComponent(p.form.options.at(-1)!.id)}`))
}
</script>
