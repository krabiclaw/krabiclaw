<template>
  <ProductCollectionPage v-if="presentation" :products="goods" :collections="collections" :locations="productLocations" :currency="currency" :presentation="presentation" :vertical="vertical" :title="collectionTitle" :brand-name="brandName" />
</template>

<script setup lang="ts">
import ProductCollectionPage from '~/components/products/ProductCollectionPage.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { presentationForSurface, productSurfaceOf } from '~/utils/product-presentation'

const { template, social_image: socialImage } = useTenantOrganization().organization
if (template.slug === 'blawby') throw createError({ statusCode: 404 })
const { t } = useI18n()
const { products, collections, locations, config, organization, data: pagePayload } = await usePublicPageData({ lazy: false })
// What the merchant sells over the counter. A dish, an Experience and a home
// each have their own surface, so none is listed twice.
const goods = computed(() => products.value.filter(product => productSurfaceOf(null, product) === 'products'))
// A surface with nothing on it is not a page: a studio that sells no
// merchandise has no /products, rather than an indexable empty one. The
// navigation hides it for the same reason.
// Only a loaded payload can say the catalog is empty. A navigation the router
// has already left behind resolves with none at all, and answering that with
// a 404 put an uncaught error on every guest who clicked twice quickly.
if (pagePayload.value && goods.value.length === 0) throw createError({ statusCode: 404 })
const vertical = String(organization.value?.vertical ?? '')
// Same rule for the vertical: only a loaded site can say how it presents its
// catalog, and `presentationForSurface` throws outright without one.
const presentation = organization.value ? presentationForSurface(vertical, 'products') : null
if (presentation && presentation.locationCollectionSegment !== 'products') throw createError({ statusCode: 404 })
const rawCurrency = config.value.default_currency
if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
const currency = rawCurrency
const brandName = String(organization.value?.name ?? '').trim()
const collectionTitle = computed(() => t('saya.products.collection_title', { organization: brandName }))
const productLocations = computed(() => locations.value.map(location => ({ id: String(location.id), slug: String(location.slug), title: String(location.title) })))
// A page about the business: its image is the organization's.
useSocialMetadata(() => presentation && ({ socialImage, path: presentation.collectionPath, title: collectionTitle.value, description: t('saya.products.meta_description', { organization: brandName }) }))
</script>
