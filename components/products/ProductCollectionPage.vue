<template>
  <div class="min-h-screen bg-default text-default">
    <template v-if="isMenu">
      <SayaSubNav
        v-if="currentLocation"
        :location-slug="currentLocation.slug"
        active="menu"
      />

      <header class="mx-auto max-w-7xl px-4 pb-10 pt-12 text-center sm:px-6 lg:px-8">
        <NuxtLink
          v-if="currentLocation"
          :to="localePath(`/locations/${encodeURIComponent(currentLocation.slug)}`)"
          class="saya-kicker mb-8 inline-block text-muted no-underline hover:text-default"
        >
          ← {{ t('saya.location.back_to', { title: currentLocation.title }) }}
        </NuxtLink>
        <p v-else-if="collectionLabel" class="saya-kicker mb-4">{{ collectionLabel }}</p>
        <div class="flex flex-col gap-2">
          <h1 class="saya-display-md text-default">{{ currentLocation?.title ?? brandName }}</h1>
          <p v-if="currentLocation && menuUpdated" class="text-sm text-muted">
            {{ t('saya.menu_page.updated', { date: menuUpdated }) }}
          </p>
        </div>
        <div v-if="locations.length > 1 && !locationId" class="mt-8 flex flex-wrap justify-center gap-3">
          <NuxtLink
            v-for="location in locations"
            :key="location.id"
            :to="localePath(productLocationCollectionPath(vertical, location.slug))"
            class="inline-flex items-center gap-2 rounded-full border border-default px-5 py-2.5 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
          >
            <SayaIcon name="map-pin" class="size-3.5 opacity-70" />
            {{ location.title }}
          </NuxtLink>
        </div>
      </header>
    </template>

    <template v-else>
      <SayaSubNav
        v-if="currentLocation && subNavTab"
        :location-slug="currentLocation.slug"
        :active="subNavTab"
      />
      <header class="mx-auto max-w-7xl px-4 pb-10 pt-16 sm:px-6 lg:px-8">
        <div class="max-w-2xl">
          <p v-if="collectionLabel" class="saya-kicker mb-4">{{ collectionLabel }}</p>
          <h1 class="saya-display-md text-default">{{ title }}</h1>
        </div>
        <div v-if="locations.length > 1 && !locationId && !isStays" class="mt-8 flex flex-wrap gap-3">
          <NuxtLink
            v-for="location in locations"
            :key="location.id"
            :to="localePath(`/locations/${encodeURIComponent(location.slug)}/${presentation.locationCollectionSegment}`)"
            class="inline-flex items-center gap-2 rounded-full border border-default px-5 py-2.5 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
          >
            <SayaIcon name="map-pin" class="size-3.5 opacity-70" />
            {{ location.title }}
          </NuxtLink>
        </div>
      </header>
    </template>

    <div v-if="products.length === 0 && (isMenu || emptyCollectionMessage)" class="mx-auto max-w-xl px-4 py-24 text-center sm:px-6">
      <p v-if="currentLocation && isMenu || emptyCollectionMessage" class="saya-display saya-italic text-3xl">
        {{ currentLocation && isMenu ? t('saya.menu_page.coming_soon_title') : emptyCollectionMessage }}
      </p>
      <p v-if="currentLocation && isMenu" class="mt-4 text-sm text-muted">
        {{ t('saya.menu_page.coming_soon_desc', { location: currentLocation.title }) }}
      </p>
    </div>

    <div v-else-if="isMenu">
      <SayaFilterTabs
        v-model="activeCategory"
        :tabs="categoryTabs"
        :enable-scroll-detection="true"
        @height="categoryNavHeight = $event"
      />

      <div class="mx-auto max-w-3xl px-4 py-20 sm:px-6 lg:px-8">
        <section
          v-for="group in groups"
          :id="`cat-${group.id}`"
          :key="group.id"
          class="mb-24"
          :style="{ scrollMarginTop: `${categoryNavHeight}px` }"
        >
          <div class="mb-8 border-b border-default pb-6">
            <!-- A section's own picture introduces it. -->
            <img v-if="mediaStillUrl(group.image)" :src="mediaStillUrl(group.image)!" :alt="group.image!.alt_text || group.category" class="mb-8 aspect-[16/9] w-full rounded-lg object-cover" loading="lazy" decoding="async">
            <p v-if="showLocations && group.location_id" class="saya-kicker mb-2">{{ locationTitle(group.location_id) }}</p>
            <h2 class="saya-display saya-italic text-5xl text-default">{{ group.category }}</h2>
            <p v-if="group.description" class="mt-4 text-sm leading-relaxed text-muted">{{ group.description }}</p>
          </div>

          <div class="flex flex-col gap-7">
            <article
              v-for="product in group.products"
              :key="product.id"
              class="flex items-start gap-5"
            >
              <NuxtLink
                v-if="product.image && isAvailable(product, group.location_id) && productHref(product, group.location_id)"
                :to="productHref(product, group.location_id)!"
                class="shrink-0"
              >
                <SayaMenuItemPreview :item="previewItem(product)" />
              </NuxtLink>
              <SayaMenuItemPreview
                v-else-if="product.image"
                :item="previewItem(product)"
                disabled
              />

              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-2">
                  <div class="flex items-baseline gap-2 text-base font-medium text-default">
                    <NuxtLink
                      v-if="isAvailable(product, group.location_id) && productHref(product, group.location_id)"
                      :to="productHref(product, group.location_id)!"
                      class="text-default no-underline underline-offset-2 hover:underline"
                    >
                      {{ product.name }}
                    </NuxtLink>
                    <span v-else class="text-default opacity-50">{{ product.name }}</span>
                    <span v-if="product.details.featured === true" class="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      {{ t('saya.posts.featured') }}
                    </span>
                    <SayaBadgeUnavailable
                      v-if="!isAvailable(product, group.location_id)"
                      :text="t('saya.menu_page.unavailable')"
                    />
                    <span
                      v-for="tag in dietaryTags(product)"
                      :key="tag"
                      class="inline-flex shrink-0 items-center rounded-full border border-default px-2 py-0.5 text-xs font-medium text-muted"
                    >
                      {{ tag }}
                    </span>
                  </div>
                  <template v-if="priceLabel(product, group.location_id)">
                    <div class="saya-dotted-leader" />
                    <div class="flex shrink-0 items-baseline gap-1.5 tabular-nums text-base text-default">
                      <span v-if="compareAtPrice(product, group.location_id)" class="text-sm text-muted line-through">{{ compareAtPrice(product, group.location_id) }}</span>
                      <span>{{ priceLabel(product, group.location_id) }}</span>
                    </div>
                  </template>
                </div>
                <p v-if="product.description" class="mt-1.5 max-w-xl text-sm leading-relaxed text-muted">
                  {{ product.description }}
                </p>
                <ProductVariantPrices
                  v-if="product.variants.filter(variant => variant.active).length > 1 || new Set(product.variants.filter(variant => variant.active).flatMap(variant => variant.prices.filter(price => price.active).map(price => price.currency))).size > 1"
                  :product="product"
                  :location-ids="priceScopes(product, group.location_id)"
                  :currency="currency"
                  class="mt-2 text-sm"
                />
              </div>
            </article>
          </div>
        </section>

        <section class="border-t border-default pt-12">
          <p class="saya-kicker mb-4">{{ t('saya.menu_page.allergens_title') }}</p>
          <p class="text-sm leading-relaxed text-muted">
            {{ t('saya.menu_page.allergens_desc') }}
          </p>
        </section>
      </div>
    </div>

    <div v-else class="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
      <section v-for="group in groups" :key="group.id" class="mb-20">
        <div class="mb-8 border-b border-default pb-6">
          <img v-if="mediaStillUrl(group.image)" :src="mediaStillUrl(group.image)!" :alt="group.image!.alt_text || group.category" class="mb-8 aspect-[16/9] w-full rounded-lg object-cover" loading="lazy" decoding="async">
          <p v-if="showLocations && group.location_id" class="saya-kicker mb-2">{{ locationTitle(group.location_id) }}</p>
          <h2 class="saya-display saya-italic text-5xl">{{ group.category }}</h2>
          <p v-if="group.description" class="mt-4 text-sm leading-relaxed text-muted">{{ group.description }}</p>
        </div>
        <div class="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          <article v-for="product in group.products" :key="product.id">
            <component :is="productHref(product, group.location_id) ? NuxtLinkComponent : 'div'" :to="productHref(product, group.location_id) ?? undefined" class="group block text-default no-underline">
              <div class="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted">
                <template v-if="coverUrl(product)">
                  <img
                    :src="coverUrl(product)!"
                    :alt="product.image!.alt_text || product.name"
                    class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  >
                  <span
                    v-if="product.image!.kind === 'video'"
                    class="absolute inset-0 flex items-center justify-center bg-black/10"
                    aria-hidden="true"
                  >
                    <span class="flex size-12 items-center justify-center rounded-full bg-black/55 text-white">
                      <SayaIcon name="play" class="ml-0.5 size-5" />
                    </span>
                  </span>
                </template>
                <div v-else class="flex h-full items-center justify-center">
                  <SayaIcon name="sparkles" class="size-12 text-dimmed" />
                </div>
                <SayaBadgeUnavailable
                  v-if="!isAvailable(product, group.location_id)"
                  overlay
                  :text="t('saya.menu_page.unavailable')"
                />
              </div>
              <div class="mt-5">
                <h3 class="text-lg font-semibold transition-colors group-hover:text-primary">{{ product.name }}</h3>
                <p v-if="product.stay && placeName(product.stay.location_id)" class="mt-1 text-xs font-medium uppercase tracking-wide text-muted">{{ placeName(product.stay.location_id) }}</p>
                <p v-else-if="!product.stay && showLocations && productLocationId(product, group.location_id)" class="mt-1 text-xs font-medium uppercase tracking-wide text-muted">{{ locationTitle(productLocationId(product, group.location_id)!) }}</p>
                <p v-if="product.description" class="mt-1 line-clamp-2 text-sm leading-6 text-muted">{{ product.description }}</p>

                <div class="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">
                  <span v-if="priceLabel(product, group.location_id)" class="flex items-center gap-1">
                    <SayaIcon name="banknotes" class="size-3.5" />
                    {{ product.stay ? t('stay.price_per_night', { price: priceLabel(product, group.location_id) }) : priceLabel(product, group.location_id) }}
                  </span>
                  <template v-if="product.stay">
                    <span class="flex items-center gap-1">
                      <SayaIcon name="user-group" class="size-3.5" />
                      {{ t('stay.sleeps', { count: product.stay.max_guests }) }}
                    </span>
                    <span v-if="product.stay.bedrooms !== null">{{ t('stay.bedrooms', { count: product.stay.bedrooms }) }}</span>
                    <span v-if="product.stay.beds !== null">{{ t('stay.beds', { count: product.stay.beds }) }}</span>
                    <span v-if="product.stay.bathrooms !== null">{{ t('stay.bathrooms', { count: product.stay.bathrooms }) }}</span>
                  </template>
                  <span v-if="product.booking?.duration_minutes" class="flex items-center gap-1">
                    <SayaIcon name="clock" class="size-3.5" />
                    {{ durationLabel(product.booking.duration_minutes) }}
                  </span>
                  <span v-if="product.booking?.default_capacity" class="flex items-center gap-1">
                    <SayaIcon name="user-group" class="size-3.5" />
                    {{ product.booking.default_capacity }} {{ verticalCopy.guestsMaxLabel }}
                  </span>
                </div>

                <div v-if="productHref(product, group.location_id)" class="mt-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary">
                  {{ product.stay ? t(productCtaKey(product.kind)) : verticalCopy.viewExperienceCta }}
                  <SayaIcon name="arrow-right" class="size-3.5 transition-transform group-hover:translate-x-1" />
                </div>
              </div>
            </component>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Collection, Product, ProductPresentation } from '~/server/types/products'
import { useSchemaOrg } from '#imports'
import type { CurrencyCode } from '~/shared/currencies'
import { formatProductMoney, formatProductPriceRange, summarizeProductPrices } from '~/utils/product-money'
import { minorAmountToMajor, type Price } from '~/shared/prices'
import { PRICING_NOTE_HANDLE } from '~/shared/product-details'
import { groupProductsByCollection, productCtaKey, productLocationCollectionPath } from '~/utils/product-presentation'
import { addressPlaceName, type PostalAddress } from '~/utils/postal-address'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { extractDietarySchemaUrls } from '~/utils/product-seo'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { resolveSeoUrl } from '~/utils/social-metadata'
import ProductVariantPrices from '~/components/products/ProductVariantPrices.vue'

interface LocationSummary { id: string; slug: string; title: string; address?: PostalAddress | null }

// Resolved once: a dynamic `:is` given the string 'NuxtLink' renders a literal
// <NuxtLink> element that no browser follows, so the card looked linked in the
// markup and was not.
const NuxtLinkComponent = resolveComponent('NuxtLink')
const requestURL = useRequestURL()

const props = defineProps<{
  products: Product[]
  collections: Collection[]
  locations: LocationSummary[]
  locationId?: string | null
  currency: CurrencyCode
  presentation: ProductPresentation
  vertical: string
  title: string
  brandName: string
}>()

const { localePath, t, locale } = useI18n()
const verticalCopy = computed(() => getVerticalCopy(props.vertical, locale.value))
const { formatDate } = useLocaleDate()
const isMenu = computed(() => props.presentation.structuredDataType === 'MenuItem')
const isExperiences = computed(() => props.presentation.locationCollectionSegment === 'experiences')
// Homes have no per-branch index: each is its own page, named by its own slug.
const isStays = computed(() => props.presentation.locationCollectionSegment === 'stays')
const subNavTab = computed(() => {
  const segment = props.presentation.locationCollectionSegment
  return segment === 'stays' ? null : segment
})
const collectionLabel = computed(() => {
  if (isMenu.value) return t('saya.footer.menu')
  if (isStays.value) return t('saya.footer.stays')
  return isExperiences.value ? t('saya.footer.experiences') : t('saya.footer.products')
})
const emptyCollectionMessage = computed(() => (isExperiences.value
  ? t('saya.experiences.empty')
  : t('saya.products.empty')))
const locationMap = computed(() => new Map(props.locations.map(location => [location.id, location])))
const showLocations = computed(() => !props.locationId && props.locations.length > 1)
const currentLocation = computed(() => {
  if (!props.locationId) return null
  const location = locationMap.value.get(props.locationId)
  if (!location) throw new Error(`Product location is missing: ${props.locationId}`)
  return location
})
/**
 * Where a product's page lives.
 *
 * The page is scoped to one location when the route says so; otherwise the
 * product must be offered at exactly one of this site's locations for its
 * route to be unambiguous. Several, and there is no single path — the product
 * is linked from each location's own collection instead.
 */
const productLocationId = (product: Product, collectionLocationId: string | null = null): string | null => {
  if (props.locationId) return props.locationId
  // A location's collection is that branch's menu, so a dish offered at two
  // branches is linked, priced and labelled as the branch whose section it is
  // being read in. Only under a site-wide collection is there nothing to say
  // which branch it belongs to, and then it has no single route.
  if (collectionLocationId && locationMap.value.has(collectionLocationId)
    && product.locations.some(entry => entry.location_id === collectionLocationId && entry.published)) return collectionLocationId
  const here = product.locations.filter(entry => entry.published && locationMap.value.has(entry.location_id))
  return here.length === 1 ? here[0]!.location_id : null
}
const locationSlug = (id: string) => {
  const location = locationMap.value.get(id)
  if (!location) throw new Error(`Product location is missing: ${id}`)
  return location.slug
}
/** Where a home is, as a guest reads it: the town in its location's address. */
const placeName = (id: string) => addressPlaceName(locationMap.value.get(id)?.address ?? null)
const locationTitle = (id: string) => {
  const location = locationMap.value.get(id)
  if (!location) throw new Error(`Product location is missing: ${id}`)
  return location.title
}
/**
 * Whether a customer can buy this here.
 *
 * Three separate facts, all of which must hold: the merchant is selling it,
 * this location offers it, and it has an applicable price. None of them
 * substitutes for another, and none of them is a stock statement.
 */
const isAvailable = (product: Product, collectionLocationId: string | null = null): boolean => {
  if (!product.active) return false
  const id = productLocationId(product, collectionLocationId)
  // Under a site-wide collection a product offered at several branches has no
  // single one to name, and the question becomes whether any branch this page
  // covers offers it. Skipping the check entirely there made a product offered
  // nowhere read as available.
  const offeredHere = id
    ? product.locations.some(entry => entry.location_id === id && entry.active)
    : product.locations.some(entry => entry.active && entry.published && locationMap.value.has(entry.location_id))
  if (!offeredHere && !product.booking?.held_online && !product.order_url) return false
  // On sale means the merchant is selling it here. A product priced in words —
  // "Market price" — is on sale; an amount is what online checkout needs, and
  // that is a different question.
  return priceFor(product, collectionLocationId) !== null
    || typeof product.details[PRICING_NOTE_HANDLE] === 'string'
}

const productHref = (product: Product, collectionLocationId: string | null = null): string | null => {
  const id = productLocationId(product, collectionLocationId)
  if (product.kind === 'experience') return localePath(props.presentation.productPath('', product.slug)) + (id ? `?location_id=${encodeURIComponent(id)}` : '')
  if (product.kind === 'stay') return localePath(props.presentation.productPath('', product.slug))
  if (product.page?.path) return localePath(product.page.path)
  return id ? localePath(props.presentation.productPath(locationSlug(id), product.slug)) : null
}

/**
 * The offer this page shows, resolved once through the one selection contract.
 *
 * A product with several applicable prices shows their actual range.
 */
const priceScopes = (product: Product, collectionLocationId: string | null = null) => {
  const locationId = productLocationId(product, collectionLocationId)
  return locationId ? [locationId] : [
    ...product.locations.filter(location => location.published && locationMap.value.has(location.location_id)).map(location => location.location_id),
    ...(product.booking?.held_online || product.order_url ? [null] : []),
  ]
}
const pricesFor = (product: Product, collectionLocationId: string | null = null) => {
  const at = new Date().toISOString()
  return summarizeProductPrices(product.variants, priceScopes(product, collectionLocationId).map(location_id => ({ currency: props.currency, location_id, at })))
}
const priceFor = (product: Product, collectionLocationId: string | null = null): Price | null => pricesFor(product, collectionLocationId).lowest
/**
 * What this card says about price.
 *
 * An amount when the product has one, the merchant's own words when it is
 * priced in words instead, and nothing at all when it states neither. A
 * missing amount never becomes zero, "Free" or "Market price" here.
 */
const priceLabel = (product: Product, collectionLocationId: string | null = null): string | null => {
  const amount = formatProductPriceRange(pricesFor(product, collectionLocationId), locale.value)
  if (amount) return amount
  const note = product.details[PRICING_NOTE_HANDLE]
  return typeof note === 'string' && note.trim() ? note : null
}
// One section per collection, in the merchant's order — see
// groupProductsByCollection for what membership does and does not imply.
const groups = computed(() => {
  const grouped = groupProductsByCollection(props.products, props.collections)
    .map(group => ({ id: group.id, category: group.name, description: group.description, image: group.image, sort_order: group.sort_order, location_id: group.location_id, products: group.products }))
  const included = new Set(grouped.flatMap(group => group.products.map(product => product.id)))
  const ungrouped = props.products.filter(product => !included.has(product.id))
  if (ungrouped.length) grouped.push({ id: 'catalog', category: props.presentation.collectionLabel, description: null, image: null, sort_order: grouped.length, location_id: null, products: ungrouped })
  return grouped
})
const categoryTabs = computed(() => groups.value.map(group => ({
  key: group.id,
  label: showLocations.value && group.location_id ? `${locationTitle(group.location_id)} · ${group.category}` : group.category,
  sectionId: `cat-${group.id}`,
})))
const userSelectedCategory = ref('')
const activeCategory = computed({
  get: () => userSelectedCategory.value || groups.value[0]?.id || '',
  set: (value: string) => {
    userSelectedCategory.value = value
  },
})
const categoryNavHeight = ref(44)
const menuUpdated = computed<string | null>(() => {
  const latest = props.products.reduce<string | null>((current, product) => {
    if (!current || product.updated_at > current) return product.updated_at
    return current
  }, null)
  return latest ? formatDate(latest) : null
})

watch(groups, () => {
  userSelectedCategory.value = ''
})

/**
 * What the card shows for a cover. A video's poster frame stands in for the
 * video itself — the same asset, not a second one — and a card with no cover
 * shows the empty state rather than borrowing a gallery photograph.
 */
function coverUrl(product: Product): string | null {
  const cover = product.image
  if (!cover) return null
  return cover.kind === 'video' ? cover.thumbnail_url : cover.public_url
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return t('saya.experience_detail.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest
    ? t('saya.experience_detail.hours_minutes', { hours, minutes: rest })
    : t('saya.experience_detail.hours', { count: hours })
}

function previewItem(product: Product) {
  return {
    name: product.name,
    media: product.image ? [product.image] : [],
  }
}

/**
 * Dietary marks come from the product's dietary_notes field.
 * A site that has not defined it shows none, rather than a guess.
 */
function dietaryTags(product: Product): string[] {
  const notes = product.details['dietary_notes']
  if (!Array.isArray(notes)) return []
  return notes.filter(note => note === 'V' || note === 'VG' || note === 'GF')
}

function compareAtPrice(product: Product, collectionLocationId: string | null = null): string | null {
  const price = priceFor(product, collectionLocationId)
  if (!price || price.compare_at_unit_amount === null) return null
  return formatProductMoney({ ...price, unit_amount: price.compare_at_unit_amount, compare_at_unit_amount: null })
}

function offerFor(product: Product, collectionLocationId: string | null = null) {
  const { lowest, highest, count } = pricesFor(product, collectionLocationId)
  if (!lowest || !highest) return undefined
  return lowest.unit_amount === highest.unit_amount
    ? { '@type': 'Offer', price: minorAmountToMajor(lowest.unit_amount, lowest.currency), priceCurrency: lowest.currency }
    : { '@type': 'AggregateOffer', lowPrice: minorAmountToMajor(lowest.unit_amount, lowest.currency), highPrice: minorAmountToMajor(highest.unit_amount, highest.currency), priceCurrency: lowest.currency, offerCount: count }
}

useSchemaOrg(computed(() => props.presentation.structuredDataType === 'MenuItem'
  ? {
      '@type': 'Menu',
      name: props.title,
      hasMenuSection: groups.value.map(group => ({
        '@type': 'MenuSection',
        name: group.category,
        description: group.description ?? undefined,
        image: mediaStillUrl(group.image) ? resolveSeoUrl(mediaStillUrl(group.image)!, requestURL.origin) : undefined,
        hasMenuItem: group.products.map(product => {
          const dietUrls = extractDietarySchemaUrls(product)
          return {
            '@type': 'MenuItem',
            name: product.name,
            description: product.description,
            ...(dietUrls.length ? { suitableForDiet: dietUrls } : {}),
            // The same branch the card is priced for: a menu section belongs to
            // one location, and structured data that disagreed with the visible
            // price would be the page contradicting itself.
            offers: offerFor(product, group.location_id),
          }
        }),
      })),
    }
  : {
      '@type': 'ItemList',
      name: props.title,
      itemListElement: props.products.map((product, index) => {
        const href = productHref(product)
        const absoluteProductUrl = href ? resolveSeoUrl(href, requestURL.origin) : null
        return {
          '@type': 'ListItem',
          position: index + 1,
          item: {
            '@type': 'Product',
            ...(absoluteProductUrl ? {
              '@id': `${absoluteProductUrl}#product`,
              url: absoluteProductUrl,
            } : {}),
            name: product.name,
            description: product.description,
            image: product.image?.public_url ? resolveSeoUrl(product.image.public_url, requestURL.origin) : undefined,
            offers: offerFor(product),
          },
        }
      }),
    }))
</script>
