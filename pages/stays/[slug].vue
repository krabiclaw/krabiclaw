<template>
  <NuxtLayout :name="template.layout">
    <ProductDetailPage :organization-id="organizationId" :vertical="detail.vertical" :product="detail.product" :location="detail.location" :organization-name="detail.brandName" :reviews="detail.reviews" :booking="detail.booking" :sessions="detail.sessions" :collection-name="detail.collectionName" :collection-siblings="detail.collectionSiblings" :currency="detail.currency" :presentation="presentation" :stay-checkout-available="detail.stayCheckoutAvailable" />
  </NuxtLayout>
</template>

<script setup lang="ts">
import ProductDetailPage from '~/components/products/ProductDetailPage.vue'
import { STAY_PRESENTATION } from '~/utils/product-presentation'
import { composeProductSeoDescription } from '~/utils/product-seo'

definePageMeta({ layout: false })
const { template } = useTenantOrganization().organization
const resolved = await usePublicProductDetail('stays')
const organizationId = resolved.organizationId
const detail = computed(() => resolved.detail.value)
const presentation = STAY_PRESENTATION
const { t } = useI18n()
/** The offer this page quotes: the home's location, the site currency, now. */
const priceSelection = computed(() => ({
  currency: detail.value.currency,
  location_id: detail.value.location?.id ?? null,
  at: new Date().toISOString(),
}))
useSocialMetadata(() => ({
  path: presentation.productPath('', detail.value.product.slug),
  title: detail.value.product.name,
  description: composeProductSeoDescription({
    product: detail.value.product,
    locationTitle: detail.value.location?.title ?? detail.value.brandName,
    priceSelection: priceSelection.value,
  }, t),
  socialImage: detail.value.product.social_image,
  breadcrumbs: [
    { name: 'Places to stay', url: presentation.collectionPath },
    { name: detail.value.product.name, url: presentation.productPath('', detail.value.product.slug) },
  ],
}))
</script>
