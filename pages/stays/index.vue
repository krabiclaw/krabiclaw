<template>
  <NuxtLayout :name="template.layout">
    <ProductCollectionPage :products="stays" :collections="collections" :locations="productLocations" :currency="currency" :presentation="presentation" :vertical="vertical" :title="collectionTitle" :brand-name="brandName" />
  </NuxtLayout>
</template>

<script setup lang="ts">
import ProductCollectionPage from '~/components/products/ProductCollectionPage.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { productSurfaceOf, STAY_PRESENTATION } from '~/utils/product-presentation'
import type { PostalAddress } from '~/utils/postal-address'

definePageMeta({ layout: false })
const { template, social_image: socialImage } = useTenantOrganization().organization
const { t } = useI18n()
const { products, collections, locations, config, organization, data: pagePayload } = await usePublicPageData({ lazy: false })
const vertical = String(organization.value?.vertical ?? '')
const presentation = STAY_PRESENTATION
const stays = computed(() => products.value.filter(product => productSurfaceOf(vertical, product) === 'stays'))
// A site with no published home has no index of them. Only a loaded payload
// can say so; a navigation the router already left resolves with none.
if (pagePayload.value && stays.value.length === 0) throw createError({ statusCode: 404 })
const rawCurrency = config.value.default_currency
if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
const currency = rawCurrency
const brandName = String(organization.value?.name ?? '').trim()
if (!brandName) throw createError({ statusCode: 500, statusMessage: 'Organization brand is unavailable' })
const collectionTitle = computed(() => t('saya.stays.collection_title', { organization: brandName }))
const productLocations = computed(() => locations.value.map(location => ({
  id: String(location.id),
  slug: String(location.slug),
  title: String(location.title),
  address: (location.address ?? null) as PostalAddress | null,
})))
useSocialMetadata(() => ({ socialImage, path: presentation.collectionPath, title: collectionTitle.value, description: t('saya.stays.meta_description', { organization: brandName }) }))
</script>
