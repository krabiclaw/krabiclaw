<template>
  <ProductDetailPage :organization-id="organizationId" :vertical="detail.vertical" :product="detail.product" :location="detail.location" :reviews="detail.reviews" :booking="detail.booking" :sessions="detail.sessions" :collection-name="detail.collectionName" :collection-siblings="detail.collectionSiblings" :currency="detail.currency" :presentation="presentation" />
</template>

<script setup lang="ts">
import ProductDetailPage from '~/components/products/ProductDetailPage.vue'
import { presentationForSurface } from '~/utils/product-presentation'
import { composeProductSeoDescription } from '~/utils/product-seo'

definePageMeta({ layout: 'saya' })
const resolved = await usePublicProductDetail('menu')
const organizationId = resolved.organizationId
const detail = computed(() => {
  const value = resolved.detail.value
  if (!value.location) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
  return { ...value, location: value.location }
})
const presentation = presentationForSurface(detail.value.vertical, 'menu')
if (presentation.locationCollectionSegment !== 'menu') throw createError({ statusCode: 404 })
const { t } = useI18n()
/** The offer context this page quotes: this location, the site currency, now. */
const priceSelection = computed(() => ({
  currency: detail.value.currency,
  location_id: detail.value.location.id,
  at: new Date().toISOString(),
}))
useSocialMetadata(() => ({
  path: presentation.productPath(detail.value.location.slug, detail.value.product.slug),
  // A product with no applicable offer is not being sold here, so it points at
  // the index instead of competing with it. Data-driven: nothing lists which
  // products this applies to.
  // The page's own title, not a second SEO field on the product: page-level SEO
  // belongs to the canonical document, and two editable titles drifted apart.
  title: detail.value.product.name,
  description: composeProductSeoDescription({
    product: detail.value.product,
    locationTitle: detail.value.location.title,
    priceSelection: priceSelection.value,
  }, t),
  socialImage: detail.value.product.social_image,
  breadcrumbs: [
    { name: 'Locations', url: '/locations' },
    { name: detail.value.location.title, url: `/locations/${detail.value.location.slug}` },
    { name: 'Menu', url: `/locations/${detail.value.location.slug}/menu` },
    { name: detail.value.product.name, url: presentation.productPath(detail.value.location.slug, detail.value.product.slug) },
  ],
}))
</script>
