<template>
  <NuxtLayout :name="template.layout">
  <ProductDetailPage :key="`${detail.product.id}:${detail.location?.id ?? 'online'}:${Boolean(detail.scopeRequired)}`" :organization-id="organizationId" :vertical="detail.vertical" :product="detail.product" :location="detail.location" :organization-name="detail.brandName" :reviews="detail.reviews" :booking="detail.booking" :sessions="detail.sessions" :collection-name="detail.collectionName" :collection-siblings="detail.collectionSiblings" :currency="detail.currency"  :presentation="presentation" :scope-required="detail.scopeRequired" :locations="detail.locations" :online-available="detail.onlineAvailable" :stay-checkout-available="detail.stayCheckoutAvailable">
  </ProductDetailPage>
  </NuxtLayout>
</template>

<script setup lang="ts">
import ProductDetailPage from '~/components/products/ProductDetailPage.vue'
import { EXPERIENCE_PRESENTATION } from '~/utils/product-presentation'
import { composeProductSeoDescription } from '~/utils/product-seo'

definePageMeta({ layout: false })
const { template } = useTenantOrganization().organization
const resolved = await usePublicProductDetail('experiences')
const organizationId = resolved.organizationId
const detail = computed(() => resolved.detail.value)
const presentation = EXPERIENCE_PRESENTATION
const { t } = useI18n()
/** The offer context this page quotes: the branch that runs it, the site currency, now. */
const priceSelection = computed(() => ({
  currency: detail.value.currency,
  location_id: detail.value.location?.id ?? null,
  at: new Date().toISOString(),
}))
useSocialMetadata(() => ({
  path: presentation.productPath(detail.value.location?.slug ?? '', detail.value.product.slug),
  // An experience with no applicable offer is not being sold, so it points at
  // the index instead of competing with it.
  title: detail.value.product.name,
  description: composeProductSeoDescription({
    product: detail.value.product,
    locationTitle: detail.value.location?.title ?? detail.value.brandName,
    priceSelection: priceSelection.value,
  }, t),
  socialImage: detail.value.product.social_image,
  breadcrumbs: detail.value.location ? [
    { name: 'Locations', url: '/locations' },
    { name: detail.value.location.title, url: `/locations/${detail.value.location.slug}` },
    { name: 'Experiences', url: `/locations/${detail.value.location.slug}/experiences` },
    { name: detail.value.product.name, url: presentation.productPath(detail.value.location.slug, detail.value.product.slug) },
  ] : [
    { name: 'Experiences', url: '/experiences' },
    { name: detail.value.product.name, url: presentation.productPath('', detail.value.product.slug) },
  ],
}))
</script>
