<template>
  <NuxtLayout :name="template.layout">
    <ProductCollectionPage :products="experiences" :collections="collections" :locations="productLocations" :location-id="locationId" :currency="currency" :presentation="presentation" :vertical="vertical" :title="collectionTitle" :brand-name="brandName" />
  </NuxtLayout>
</template>

<script setup lang="ts">
import ProductCollectionPage from '~/components/products/ProductCollectionPage.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { EXPERIENCE_PRESENTATION, isExperience, resolveProductPresentation } from '~/utils/product-presentation'

definePageMeta({ layout: false })
const { template } = useTenantOrganization().organization
const { products, collections, locations, location, config, organization, data: pagePayload } = await usePublicPageData({ lazy: false })
const currentLocation = location.value
if (!currentLocation) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
const vertical = String(organization.value?.vertical ?? '')
if (organization.value && !resolveProductPresentation(vertical)) throw createError({ statusCode: 404 })
const presentation = EXPERIENCE_PRESENTATION
const rawCurrency = config.value.default_currency
if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
const currency = rawCurrency
const brandName = String(organization.value?.name ?? '').trim()
if (!brandName) throw createError({ statusCode: 500, statusMessage: 'Organization brand is unavailable' })
const { t } = useI18n()
const experiences = computed(() => products.value.filter(isExperience))
// A site with nothing to book has no experiences page, rather than an
// indexable empty one.
// Only a loaded payload can say the catalog is empty. A navigation the router
// has already left behind resolves with none at all, and answering that with
// a 404 put an uncaught error on every guest who clicked twice quickly.
if (pagePayload.value && experiences.value.length === 0) throw createError({ statusCode: 404 })
const locationId = currentLocation.id
const collectionTitle = computed(() => t('site.experiences.collection_title', { organization: currentLocation.title }))
const productLocations = computed(() => locations.value.map(item => ({ id: String(item.id), slug: String(item.slug), title: String(item.title), sections: item.sections })))
useSocialMetadata(() => ({
  path: `/locations/${encodeURIComponent(currentLocation.slug)}/experiences`,
  title: collectionTitle.value,
  description: t('site.experiences.meta_description', { organization: currentLocation.title }),
  socialImage: currentLocation.social_image ?? null,
  breadcrumbs: [
    { name: 'Locations', url: '/locations' },
    { name: currentLocation.title, url: `/locations/${encodeURIComponent(currentLocation.slug)}` },
    { name: 'Experiences', url: `/locations/${encodeURIComponent(currentLocation.slug)}/experiences` },
  ],
}))
</script>
