<template>
  <ProductCollectionPage :products="items" :collections="collections" :locations="catalogLocations" :location-id="place?.id" :currency="currency" :presentation="presentation" :vertical="vertical" :title="title" :brand-name="brand" />
</template>

<script setup lang="ts">
import ProductCollectionPage from './ProductCollectionPage.vue'
import { isCurrencyCode } from '~/shared/currencies'
import type { PostalAddress } from '~/utils/postal-address'
import type { Product, PublicMenuProduct } from '~/server/types/products'
import { presentationForSurface, productSurfaceOf, resolveProductPresentation } from '~/utils/product-presentation'
import { isPublicMenuProduct, isPublicProduct } from '~/utils/public-resource-contracts'

const props = defineProps<{ surface: 'menu' | 'products' | 'experiences' | 'stays'; scoped?: boolean }>()
const { t } = useI18n()
const { social_image: siteImage } = useTenantOrganization().organization
const { products, collections, locations, location, config, organization, sections, data } = await usePublicPageData({
  ...(props.surface === 'menu' ? { datasets: props.scoped ? ['location', 'menu_cards'] : ['menu_cards'] } as const : {}),
  validateProduct: (value): value is Product | PublicMenuProduct => props.surface === 'menu' ? isPublicMenuProduct(value) : isPublicProduct(value),
})
const catalogLocations = computed(() => locations.value.map(({ id, slug, title, sections, address, public_area }) => ({
  id, slug, title, sections, ...(props.surface === 'stays' ? { address: address as PostalAddress | null, public_area } : {}),
})))
const place = computed(() => props.scoped ? location.value : null)
const items = computed(() => products.value.filter(product => productSurfaceOf(null, product) === props.surface))
const brand = String(organization.value?.name ?? '').trim()
const vertical = String(organization.value?.vertical ?? '')
const currency = config.value.default_currency
if (!isCurrencyCode(currency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
if (!brand) throw createError({ statusCode: 500, statusMessage: 'Organization brand is unavailable' })
if (props.scoped && !place.value) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
if (props.surface === 'experiences' && !resolveProductPresentation(vertical)) throw createError({ statusCode: 404 })
if (props.surface === 'menu' ? (props.scoped ? !place.value?.sections.menu : sections.value?.menu === false) : data.value && !items.value.length) {
  throw createError({ statusCode: 404 })
}
const presentation = presentationForSurface(vertical, props.surface)
if (presentation.locationCollectionSegment !== props.surface) throw createError({ statusCode: 404 })
const name = computed(() => place.value?.title ?? brand)
const title = computed(() => props.surface === 'menu' ? `${name.value} Menu`
  : props.surface === 'products' && place.value ? `${name.value} Products`
  : t(`site.${props.surface}.collection_title`, { organization: name.value }))
useSocialMetadata(() => {
  const locationPath = place.value ? `/locations/${encodeURIComponent(place.value.slug)}` : null
  const path = locationPath ? `${locationPath}/${props.surface}` : presentation.collectionPath
  return {
    path, title: title.value, socialImage: place.value ? place.value.social_image ?? null : siteImage,
    description: props.surface === 'menu' ? `Full menu ${locationPath ? 'for' : 'at'} ${name.value}.`
      : props.surface === 'products' && locationPath ? `Products at ${name.value}.` : t(`site.${props.surface}.meta_description`, { organization: name.value }),
    breadcrumbs: locationPath
      ? [{ name: 'Locations', url: '/locations' }, { name: name.value, url: locationPath }, { name: props.surface[0]!.toUpperCase() + props.surface.slice(1), url: path }]
      : props.surface === 'menu' ? [{ name: 'Menu', url: path }] : undefined,
  }
})
</script>
