<template>
  <ProductCollectionPage :products="experiences" :collections="collections" :locations="productLocations" :currency="currency" :presentation="presentation" :vertical="vertical" :title="collectionTitle" :brand-name="brandName" />
</template>

<script setup lang="ts">
import ProductCollectionPage from '~/components/products/ProductCollectionPage.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { EXPERIENCE_PRESENTATION, isExperience, resolveProductPresentation } from '~/utils/product-presentation'

const { products, collections, locations, config, organization, data: pagePayload } = await usePublicPageData({ lazy: false })
const vertical = String(organization.value?.vertical ?? '')
// Every vertical that has a catalog can run experiences — a restaurant's
// teppanyaki counter is one, and its menu is not where a guest books a seat.
if (organization.value && !resolveProductPresentation(vertical)) throw createError({ statusCode: 404 })
const presentation = EXPERIENCE_PRESENTATION
const rawCurrency = config.value.default_currency
if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
const currency = rawCurrency
const brandName = String(organization.value?.name ?? '').trim()
if (!brandName) throw createError({ statusCode: 500, statusMessage: 'Organization brand is unavailable' })
const { t } = useI18n()
// The page shows what a guest can book. A product the merchant sells over the
// counter is on the vertical's own surface, not here.
const experiences = computed(() => products.value.filter(isExperience))
// A site with nothing to book has no experiences page, rather than an
// indexable empty one.
// Only a loaded payload can say the catalog is empty. A navigation the router
// has already left behind resolves with none at all, and answering that with
// a 404 put an uncaught error on every guest who clicked twice quickly.
if (pagePayload.value && experiences.value.length === 0) throw createError({ statusCode: 404 })
const collectionTitle = computed(() => t('saya.experiences.collection_title', { organization: brandName }))
const productLocations = computed(() => locations.value.map(location => ({ id: String(location.id), slug: String(location.slug), title: String(location.title) })))
// A page about the business: its image is the organization's.
const { socialImage } = useTenantOrganization()
useSocialMetadata(() => ({ socialImage, path: presentation.collectionPath, title: collectionTitle.value, description: t('saya.experiences.meta_description', { organization: brandName }), brand: { organizationName: brandName } }))
</script>
