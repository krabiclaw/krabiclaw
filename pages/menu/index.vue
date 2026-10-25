<template>
  <ProductCollectionPage :products="goods" :collections="collections" :locations="productLocations" :currency="currency" :presentation="presentation" :vertical="vertical" :title="`${brandName} Menu`" :brand-name="brandName" />
</template>

<script setup lang="ts">
import ProductCollectionPage from '~/components/products/ProductCollectionPage.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { presentationForSurface } from '~/utils/product-presentation'

definePageMeta({ layout: 'tenant' })
const { social_image: organizationSocialImage } = useTenantOrganization().organization
const { products, collections, locations, config, organization, sections } = await usePublicPageData({ lazy: false })
// A section with nothing on it is not a page; the navigation hides it by the same flag.
if (sections.value?.menu === false) throw createError({ statusCode: 404 })
// What the merchant sells over the counter. Anything a guest books a seat on
// is an Experience and has its own surface, so it is not listed twice.
const goods = computed(() => products.value.filter(product => product.kind === 'dish'))
const vertical = String(organization.value?.vertical ?? '')
const presentation = presentationForSurface(vertical, 'menu')
if (presentation.locationCollectionSegment !== 'menu') throw createError({ statusCode: 404 })
const rawCurrency = config.value.default_currency
if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
const currency = rawCurrency
const brandName = organization.value?.name
if (typeof brandName !== 'string' || brandName.trim().length === 0) throw createError({ statusCode: 500, statusMessage: 'Organization brand is unavailable' })
const productLocations = computed(() => locations.value.map(location => ({ id: location.id, slug: location.slug, title: location.title, sections: location.sections })))
// A page about the business: its image is the organization's.
useSocialMetadata(() => ({
  socialImage: organizationSocialImage,
  path: presentation.collectionPath,
  title: `${brandName} Menu`,
  description: `Full menu at ${brandName}.`,
  breadcrumbs: [
    { name: 'Menu', url: presentation.collectionPath },
  ],
}))
</script>
