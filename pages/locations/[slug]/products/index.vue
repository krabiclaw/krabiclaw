<template>
  <ProductCollectionPage :products="offerings" :collections="collections" :locations="productLocations" :location-id="locationId" :currency="currency" :presentation="presentation" :vertical="vertical" :title="`${locationTitle} Products`" :brand-name="brandName" />
</template>

<script setup lang="ts">
import ProductCollectionPage from '~/components/products/ProductCollectionPage.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { presentationForSurface, productSurfaceOf } from '~/utils/product-presentation'

definePageMeta({ layout: 'tenant' })
const { products, collections, locations, location, config, organization, data: pagePayload } = await usePublicPageData({ lazy: false })
// Practice areas and consultations use the products surface. Dishes,
// experiences and homes each have their own surface.
const offerings = computed(() => products.value.filter(product => productSurfaceOf(null, product) === 'products'))
// A surface with no offerings has no indexable page. Its navigation follows
// the same rule.
// Only a loaded payload can say the catalog is empty. A navigation the router
// has already left behind resolves with none at all, and answering that with
// a 404 put an uncaught error on every guest who clicked twice quickly.
if (pagePayload.value && offerings.value.length === 0) throw createError({ statusCode: 404 })
const currentLocation = location.value
if (!currentLocation) throw createError({ statusCode: 404 })
const brandName = organization.value?.name
if (typeof brandName !== 'string' || brandName.trim().length === 0) throw createError({ statusCode: 500, statusMessage: 'Organization brand is unavailable' })
const vertical = String(organization.value?.vertical ?? '')
const presentation = presentationForSurface(vertical, 'products')
if (presentation.locationCollectionSegment !== 'products') throw createError({ statusCode: 404 })
const rawCurrency = config.value.default_currency
if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
const currency = rawCurrency
const locationId = currentLocation.id
const locationTitle = currentLocation.title
const productLocations = computed(() => locations.value.map(item => ({ id: item.id, slug: item.slug, title: item.title })))
useSocialMetadata(() => ({
  path: `/locations/${encodeURIComponent(currentLocation.slug)}/products`,
  title: `${locationTitle} Products`,
  description: `Products at ${locationTitle}.`,
  socialImage: location.value?.social_image ?? null,
  breadcrumbs: [
    { name: 'Locations', url: '/locations' },
    { name: locationTitle, url: `/locations/${encodeURIComponent(currentLocation.slug)}` },
    { name: 'Products', url: `/locations/${encodeURIComponent(currentLocation.slug)}/products` },
  ],
}))
</script>
