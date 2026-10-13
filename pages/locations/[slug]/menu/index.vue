<template>
  <ProductCollectionPage :products="goods" :collections="collections" :locations="productLocations" :location-id="locationId" :currency="currency" :presentation="presentation" :vertical="vertical" :title="`${locationTitle} Menu`" :brand-name="brandName" />
</template>

<script setup lang="ts">
import ProductCollectionPage from '~/components/products/ProductCollectionPage.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { presentationForSurface } from '~/utils/product-presentation'

definePageMeta({ layout: 'saya' })
const { template } = useTenantOrganization()
if (template.slug === 'blawby') throw createError({ statusCode: 404 })
const { products, collections, locations, location, config, organization } = await usePublicPageData({ lazy: false })
// What the merchant sells over the counter. Anything a guest books a seat on
// is an Experience and has its own surface, so it is not listed twice.
const goods = computed(() => products.value.filter(product => product.kind === 'dish'))
const currentLocation = location.value
if (!currentLocation) throw createError({ statusCode: 404 })
const brandName = organization.value?.name
if (typeof brandName !== 'string' || brandName.trim().length === 0) throw createError({ statusCode: 500, statusMessage: 'Organization brand is unavailable' })
const vertical = String(organization.value?.vertical ?? '')
const presentation = presentationForSurface(vertical, 'menu')
if (presentation.locationCollectionSegment !== 'menu') throw createError({ statusCode: 404 })
const rawCurrency = config.value.default_currency
if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
const currency = rawCurrency
const locationId = currentLocation.id
const locationTitle = currentLocation.title
const productLocations = computed(() => locations.value.map(item => ({ id: item.id, slug: item.slug, title: item.title })))
useSocialMetadata(() => ({
  path: `/locations/${encodeURIComponent(currentLocation.slug)}/menu`,
  title: `${locationTitle} Menu`,
  description: `Full menu for ${locationTitle}.`,
  socialImage: location.value?.social_image ?? null,
  brand: { organizationName: brandName },
  breadcrumbs: [
    { name: 'Locations', url: '/locations' },
    { name: locationTitle, url: `/locations/${encodeURIComponent(currentLocation.slug)}` },
    { name: 'Menu', url: `/locations/${encodeURIComponent(currentLocation.slug)}/menu` },
  ],
}))
</script>
