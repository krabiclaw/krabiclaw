<template>
  <div class="min-h-screen bg-default text-default">

    <!-- Loading skeleton -->
    <template v-if="pending">
      <div class="relative min-h-160 bg-muted">
        <div class="absolute inset-0 animate-pulse bg-muted" style="animation: sayaPulse 1.6s ease-in-out infinite" />
      </div>
    </template>

    <template v-else-if="location">
      <!-- Sub-nav (Level 2) -->
      <SayaSubNav
        :location-slug="slug"
        active="overview"
      />

      <!-- Full-bleed location hero -->
      <section class="relative min-h-160 overflow-hidden">
        <video
          v-if="heroMedia.isVideo"
          :src="heroMedia.url ?? undefined"
          autoplay
          muted
          loop
          playsinline
          class="absolute inset-0 h-full w-full object-cover opacity-50"
        />
        <div
          v-else-if="heroMedia.url"
          class="absolute inset-0 bg-cover bg-center opacity-50"
          :style="heroBackgroundStyle"
        />
        <!-- No real photo yet: same action-color + icon treatment as the homepage
             hero (SayaHomeHero.vue) — not a stock photo that isn't actually theirs. -->
        <div
          v-else
          class="absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,var(--ui-primary)_0%,color-mix(in_srgb,var(--ui-primary)_60%,black)_100%)]"
          aria-hidden="true"
        >
          <SayaIcon :name="locationHeroIcon" class="size-24 text-white/25" />
        </div>
        <div class="absolute inset-0" style="background: linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.2) 50%, rgba(0,0,0,0.3) 100%)" />
        <div class="relative flex min-h-160 items-end">
          <div class="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
            <NuxtLink :to="localePath('/locations')" class="saya-kicker mb-8 inline-block text-white/60 no-underline hover:text-white">
              ← {{ t('saya.footer.all_locations') }}
            </NuxtLink>
            <p class="saya-eyebrow mb-5 text-white/80">{{ addressPlaceName(location.address as PostalAddress | null) }}</p>
            <h1 class="saya-display-lg text-white">
              <em class="saya-italic">{{ heroTitle || location.title }}</em>
            </h1>
            <p v-if="heroSubtitle" class="saya-display mt-5 text-2xl text-white/70">
              <em class="saya-italic">{{ heroSubtitle }}</em>
            </p>
            <p v-else-if="!heroTitle" class="saya-display mt-5 text-2xl text-white/70">
              <em class="saya-italic">{{ organizationName }}</em>
            </p>
            <div v-if="activeClosureMessage" class="mt-8 flex items-center gap-2.5 text-sm uppercase tracking-widest text-white">
              <span class="size-1.5 rounded-full bg-red-400" />
              {{ activeClosureMessage }}
            </div>
            <div v-else-if="isOpenNow === true" class="mt-8 flex items-center gap-2.5 text-sm uppercase tracking-widest text-white">
              <span class="size-1.5 rounded-full bg-green-400" />
              {{ t('saya.location.open_now') }} · {{ todayHours }}
            </div>
            <div v-else-if="isOpenNow === false" class="mt-8 flex items-center gap-2.5 text-sm uppercase tracking-widest text-white">
              <span class="size-1.5 rounded-full bg-zinc-400" />
              {{ t('saya.location.closed') }} · {{ todayHours }}
            </div>
            <div v-else-if="todayHours" class="mt-8 flex items-center gap-2.5 text-sm uppercase tracking-widest text-white">
              <span class="size-1.5 rounded-full bg-amber-400" />
              {{ todayHours }}
            </div>
            <div v-else class="mt-8 flex items-center gap-2.5 text-sm uppercase tracking-widest text-white">
              <span class="size-1.5 rounded-full bg-zinc-300" />
              <a v-if="displayPhone" :href="`tel:${dialablePhone}`" class="text-white/80 no-underline hover:text-white">{{ t('saya.location.call_us') }} · {{ displayPhone }}</a>
              <span v-else>{{ t('saya.location.contact_us_for_hours') }}</span>
            </div>
            <div class="mt-10 flex flex-wrap gap-3">
              <SayaButton
                v-if="primaryCtaPath"
                :to="localePath(primaryCtaPath)"
                size="lg"
                class="bg-white! text-black! hover:bg-zinc-100!"
              >
                {{ primaryCtaLabel }}
              </SayaButton>
              <NuxtLink
                v-if="secondaryCtaPath"
                :to="localePath(secondaryCtaPath)"
                class="inline-flex items-center rounded-full border border-white/50 px-6 py-2.5 text-sm font-medium uppercase tracking-widest text-white transition hover:bg-white/10"
              >
                {{ secondaryCtaLabel }}
              </NuxtLink>
            </div>
          </div>
        </div>
      </section>

      <!-- Quick info strip -->
      <section class="border-b border-default">
        <div class="mx-auto grid max-w-7xl gap-12 px-4 py-14 sm:px-6 sm:grid-cols-2 lg:grid-cols-3 lg:px-8">
          <div>
            <p class="saya-eyebrow mb-4 text-muted">{{ t('saya.location.address') }}</p>
            <p class="text-sm leading-relaxed text-default">{{ formattedAddress }}</p>
            <a
              v-if="location.maps_url"
              :href="location.maps_url"
              target="_blank"
              rel="noopener noreferrer"
              class="mt-3 inline-block text-xs uppercase tracking-widest text-default no-underline transition hover:opacity-60"
            >
              {{ t('saya.location.get_directions') }} →
            </a>
          </div>
          <div>
            <p class="saya-eyebrow mb-4 text-muted">{{ t('saya.location.hours') }}</p>
            <div class="space-y-1">
              <div
                v-for="day in weekHours"
                :key="day.day"
                class="flex justify-between gap-4 text-sm"
                :class="day.today ? 'font-semibold text-default' : 'text-muted'"
              >
                <span>{{ day.day }}</span>
                <span>{{ day.hours }}</span>
              </div>
              <div v-if="!weekHours.length" class="text-sm text-muted">{{ t('saya.location.contact_us_for_hours') }}</div>
            </div>
          </div>
          <div>
            <p class="saya-eyebrow mb-4 text-muted">{{ t('saya.header.contact') }}</p>
            <a v-if="displayPhone" :href="`tel:${dialablePhone}`" class="block text-sm text-default no-underline hover:underline">
              {{ displayPhone }}
            </a>
            <a v-if="displayEmail" :href="`mailto:${displayEmail}`" class="mt-2 block text-sm text-muted no-underline hover:underline break-all">
              {{ displayEmail }}
            </a>
          </div>
        </div>
      </section>

      <TenantPageRenderer v-if="locationPageContent" :page="locationPageContent" />

      <!-- Parking & additional notes -->
      <section v-if="sanitizedParkingInfo || sanitizedExtraNotes" class="border-b border-default">
        <div class="mx-auto grid max-w-7xl gap-12 px-4 py-14 sm:px-6 lg:grid-cols-2 lg:px-8">
          <!-- eslint-disable vue/no-v-html -->
          <div v-if="sanitizedParkingInfo">
            <p class="saya-eyebrow mb-4 text-muted">{{ t('saya.location.parking') }}</p>
            <div class="prose prose-sm max-w-none text-default" v-html="sanitizedParkingInfo" />
          </div>
          <div v-if="sanitizedExtraNotes">
            <p class="saya-eyebrow mb-4 text-muted">{{ t('saya.location.additional_notes') }}</p>
            <div class="prose prose-sm max-w-none text-default" v-html="sanitizedExtraNotes" />
          </div>
          <!-- eslint-enable vue/no-v-html -->
        </div>
      </section>

      <LazySayaFeaturedContent
        v-for="group in collectionProductGroups"
        :key="group.surface"
        :data="{
          items: group.items,
          kicker: group.label,
          heading: `${group.label} · ${location.title}`,
          linkTarget: group.path
        }"
      />

      <!-- Location posts preview -->
      <template v-if="locationPosts.length">
        <SocialPosts :posts="locationPosts" />
        <div class="pb-20 text-center">
          <SayaButton :to="localePath(`/locations/${slug}/posts`)" variant="outline">{{ t('saya.posts.view_all') }}</SayaButton>
        </div>
      </template>

      <!-- Reviews preview -->
      <section v-if="reviewsPreview.length">
        <div class="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
          <div class="mb-16 max-w-2xl">
            <p class="saya-kicker mb-6">{{ t('saya.reviews.subtitle') }}</p>
            <h2 class="saya-display-md flex items-center gap-3 text-default">
              <SayaIcon name="star" solid class="size-8 text-primary" aria-hidden="true" />
              {{ location.rating ? Number(location.rating).toFixed(1) : '—' }}
              <span v-if="location.review_count" class="text-muted">· {{ t('saya.reviews_page.based_on', { count: location.review_count }) }}</span>
            </h2>
          </div>
          <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <SayaReviewCard
              v-for="review in reviewsPreview"
              :key="review.id"
             
              :review="review"
            />
          </div>
        </div>
      </section>

      <!-- Other locations rail (multi-location brands only) -->
      <section v-if="otherLocations.length" class="bg-inverted text-inverted">
        <div class="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
          <div class="mb-12 flex flex-wrap items-end justify-between gap-8">
            <div>
              <p class="saya-kicker mb-6">{{ locationIndexCopy.otherLocationsHeading }}</p>
              <h2 class="saya-display-md text-inverted"><em class="saya-italic">{{ organizationName }}</em></h2>
            </div>
            <NuxtLink
              :to="localePath('/locations')"
              class="border-b border-inverted/40 pb-1 text-xs uppercase tracking-widest text-inverted no-underline transition hover:opacity-70"
            >
              {{ t('saya.footer.all_locations') }} →
            </NuxtLink>
          </div>
          <div :class="['grid gap-6', otherLocations.length === 1 ? 'max-w-xl' : 'sm:grid-cols-2 lg:grid-cols-3']">
            <NuxtLink
              v-for="loc in otherLocations"
              :key="loc.id"
              :to="localePath(`/locations/${loc.slug}`)"
              class="block overflow-hidden border border-inverted/10 bg-inverted/5 no-underline transition hover:border-inverted/20"
            >
              <div class="aspect-video overflow-hidden bg-inverted/10">
                <video
                  v-if="locationMedia(loc)?.public_url && locationMedia(loc)?.kind === 'video'"
                  :src="locationMedia(loc)?.public_url"
                  class="h-full w-full object-contain"
                  autoplay muted loop playsinline
                />
                <img
                  v-else-if="locationMedia(loc)?.public_url"
                  :src="locationMedia(loc)?.public_url"
                  :alt="loc.title"
                  class="h-full w-full object-contain transition-transform duration-500 hover:scale-105"
                >
              </div>
              <div class="p-7">
                <p class="saya-eyebrow mb-3 text-inverted/50">{{ addressPlaceName(loc.address as PostalAddress | null) }}</p>
                <div class="saya-display saya-italic text-3xl text-inverted leading-none">{{ loc.title }}</div>
                <p class="mt-4 text-xs uppercase tracking-widest text-inverted/50">{{ t('saya.footer.visit_page') }}</p>
              </div>
            </NuxtLink>
          </div>
        </div>
      </section>

      <!-- Plan a visit CTA — map lives on /contact -->
      <section class="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <div class="flex flex-wrap items-center justify-between gap-8">
          <h2 class="saya-display-md saya-italic text-default">{{ t('saya.location.see_you_soon') }}</h2>
          <div class="flex flex-wrap gap-3">
            <SayaButton v-if="primaryCtaPath" :to="localePath(primaryCtaPath)" size="lg">
              {{ primaryCtaLabel }}
            </SayaButton>
            <NuxtLink
              :to="localePath(`/locations/${slug}/contact`)"
              class="inline-flex items-center rounded-full border border-default px-6 py-2.5 text-xs font-medium uppercase tracking-widest text-default transition hover:bg-muted"
            >
              {{ t('saya.location.plan_a_visit') }} →
            </NuxtLink>
          </div>
        </div>
      </section>

    </template>

    <!-- Not found -->
    <div v-else class="mx-auto max-w-xl px-4 py-24 text-center">
      <SayaIcon name="map-pin" class="mx-auto mb-4 size-12 text-muted" />
      <h1 class="saya-display-sm text-default">{{ t('saya.location.not_found') }}</h1>
      <SayaButton :to="localePath('/locations')" class="mt-8">{{ t('saya.location.view_all_locations') }}</SayaButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import SocialPosts from '~/components/social/SocialPosts.vue'
import { formatOpeningHours, getIsOpenNow, getActiveSpecialClosure, formatClosureMessage } from '~/utils/formatters'
import { getTodayHoursLabel, schemaOpeningHours } from '~/shared/reservation-hours'
import { formatProductMoney } from '~/utils/product-money'
import { catalogSurfaces, countCatalog, presentationForProduct, productSurfaceOf } from '~/utils/product-presentation'
import { selectPrice, type Price } from '~/shared/prices'
import { isCurrencyCode } from '~/shared/currencies'
import type { Product } from '~/server/types/products'
import { resolveSocialImageUrl } from '~/utils/social-metadata'
import { addressPlaceName, formatPostalAddress, schemaPostalAddress, type PostalAddress } from '~/utils/postal-address'
import { loadDomPurify } from '~/utils/dom-purify-loader'
import { sanitizeHtmlForSsr } from '~/utils/markdown'

const DOMPurify = import.meta.client ? await loadDomPurify() : { sanitize: sanitizeHtmlForSsr }

const { resolveMedia } = useMedia()
definePageMeta({ layout: 'saya' })

const route = useRoute()
const { organizationId, organization } = useTenantOrganization()
const { locale, localePath, t } = useI18n()
const locationIndexCopy = computed(() => getVerticalCopy((organization as ApiValue)?.vertical, locale.value))
if (!organizationId) throw createError({ statusCode: 404 })

const slug = computed(() => String(route.params.slug))
const organizationName = computed(() => String((organization as ApiValue)?.name ?? '').trim())

const {
  location,
  locations,
  getField: getContentField,
  getHero: getContentHero,
  products,
  collections,
  locationReviews,
  tenantPage,
  pending,
  config: pageConfig,
} = await usePublicPageData()
// A slug naming no location is a URL that does not exist. Rendering the page
// around a null location answered 200 with an empty shell — a soft 404 a
// crawler indexes. The sibling menu and product indexes already refuse it.
if (!location.value) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
const { posts: locationPosts } = await useSocialPostFeed(() => ({ locationId: location.value!.id }), { limit: 3 })

const locationProducts = computed(() => products.value.filter(product =>
  product.locations.some(entry => entry.location_id === location.value?.id && entry.published && entry.active)))
const productSurfaces = computed(() => catalogSurfaces((organization as ApiValue)?.vertical, countCatalog(locationProducts.value)))
const productCollectionPath = computed(() => {
  if (!location.value) return null
  return `/locations/${location.value.slug}/${productSurfaces.value[0]}`
})
const locationMedia = (location: ApiRecord) => Array.isArray(location.media)
  ? (location.media as ApiRecord[]).find(item => item.slot === 'hero') ?? null
  : null
const primaryCtaPath = computed(() => locationIndexCopy.value.ctaRoute)
const primaryCtaLabel = computed(() => locationIndexCopy.value.reserveCta)

const secondaryCtaPath = computed(() => (locationProducts.value.length > 0 ? productCollectionPath.value : null))

const secondaryCtaLabel = computed(() => locationProducts.value.length > 0
  ? productSurfaces.value[0] === 'experiences' ? t('saya.menu_page.view_experiences')
    : productSurfaces.value[0] === 'menu' ? t('saya.hero.view_menu') : t('saya.footer.products')
  : null)

const locationPageContent = computed(() => {
  const page = tenantPage.value
  if (!page) return null
  const blocks = page.blocks.filter(block => block.type !== 'hero' && !['parking.info', 'extra.notes'].includes(String(block.data.field ?? '')))
  return blocks.length ? { ...page, blocks } : null
})


// Contact details are location-owned; missing or placeholder values stay absent.
const displayPhone = computed(() => {
  const p = location.value?.phone
  return p && !p.includes('example.com') ? p : null
})
const dialablePhone = computed(() => displayPhone.value?.replace(/[^\d+]/g, '') ?? '')
const displayEmail = computed(() => {
  const e = location.value?.email
  return e || null
})

// Other locations for the "Sister rooms" rail
const otherLocations = computed(() => locations.value.filter((l: ApiRecord) => l.slug !== slug.value))

// Reviews preview from bootstrap
const reviewsPreview = computed(() => locationReviews.value.slice(0, 3))


// Neutral default until the owner picks a brand color in onboarding.
const locationHeroIcon = computed(() => (organization as ApiValue)?.vertical === 'experience' ? 'sparkles' : 'map-pin')

// Sanitize hero background URL to prevent CSS injection
const heroBackgroundStyle = computed(() => {
  const raw = String(heroMedia.value?.url || '').trim()
  if (!raw) return {}

  let safeHref = ''
  try {
    if (raw.startsWith('/')) {
      safeHref = encodeURI(raw)
    } else {
      const parsed = new URL(raw)
      if (!['http:', 'https:'].includes(parsed.protocol)) return {}
      safeHref = encodeURI(parsed.href)
    }
  } catch {
    return {}
  }

  if (/["'\\);]/.test(safeHref) || safeHref.includes('/*') || safeHref.includes('*/')) {
    return {}
  }

  return { backgroundImage: `url("${safeHref}")` }
})

// Every other product surface refuses to render rather than quote a price in a
// currency nobody set. This page used to degrade to null instead, which showed
// the location with every price silently missing and no way to tell why.
//
// The currency is on the page payload's config, which is where the shell query
// puts it (server/utils/public-shell-query.ts) and where every sibling surface
// reads it. `useTenantOrganization`'s site is the tenant-resolution context — brand
// name, media, vertical — and has never carried a currency, so reading it here
// was always undefined and took both of Pottery House's location pages down.
const rawCurrency = pageConfig.value.default_currency
if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
const currency = rawCurrency

/** The offer this location shows for a product, through the one contract. */
function offerFor(product: Product): Price | null {
  if (!location.value) return null
  const selection = { currency, location_id: String(location.value.id), at: new Date().toISOString() }
  const offers = product.variants.flatMap(variant => selectPrice(variant.prices, selection) ?? [])
  return offers.reduce<Price | null>((lowest, offer) => (!lowest || offer.unit_amount < lowest.unit_amount ? offer : lowest), null)
}

/**
 * The teaser strip: the top of what the merchant put in this location's
 * collections, in the order they put it.
 *
 * Each product kind keeps its own surface and uses the merchant's order.
 */
const collectionProductGroups = computed(() => {
  if (!location.value) return []
  const here = new Set(locationProducts.value.map(product => product.id))
  const ordered = collections.value
    .filter(collection => collection.location_id === null || collection.location_id === location.value!.id)
    .sort((left, right) => left.sort_order - right.sort_order)
    .flatMap((collection) => {
      const positions = new Map<string, number>()
      for (const product of locationProducts.value) {
        const membership = product.collections.find(entry => entry.collection_id === collection.id)
        if (membership) positions.set(product.id, membership.sort_order)
      }
      return [...positions.keys()]
        .sort((left, right) => positions.get(left)! - positions.get(right)!)
        .map(id => ({ id, collectionName: collection.name }))
    })
  const seen = new Set<string>()
  const entries = ordered
    .filter(entry => here.has(entry.id) && !seen.has(entry.id) && seen.add(entry.id))
  return productSurfaces.value.flatMap(surface => {
    const items = entries.filter(entry => {
      const product = locationProducts.value.find(row => row.id === entry.id)
      return product && productSurfaceOf((organization as ApiValue)?.vertical, product) === surface
    }).slice(0, 4).flatMap((entry) => {
      const product = locationProducts.value.find(row => row.id === entry.id)
      if (!product) return []
      const presentation = presentationForProduct((organization as ApiValue)?.vertical, product)
      const offer = offerFor(product)
      return [{
        name: product.name,
        category: entry.collectionName,
        description: product.description,
        price: formatProductMoney(offer),
        compareAtPrice: offer?.compare_at_unit_amount
          ? formatProductMoney({ ...offer, unit_amount: offer.compare_at_unit_amount, compare_at_unit_amount: null })
          : null,
        // A card draws a still, so a video cover is shown as its own poster.
        image: resolveSocialImageUrl(product.image),
        alt: product.image?.alt_text || product.name,
        href: localePath(presentation.productPath(slug.value, product.slug)),
        ctaText: t(product.kind === 'experience' ? 'saya.common.view_experience' : product.kind === 'dish' ? 'saya.common.view_dish' : 'saya.common.view_item'),
        unavailable: !product.active || offer === null,
      }]
    })
    return items.length ? [{ surface, items, label: t(`saya.footer.${surface}`), path: `/locations/${location.value!.slug}/${surface}` }] : []
  })
})

const contentHero = computed(() => getContentHero({ title: '', subtitle: '', image: '', video: '' }))
const heroMedia = computed(() => {
  if (contentHero.value.video) return resolveMedia({ public_url: contentHero.value.video, thumbnail_url: contentHero.value.thumbnail_url, kind: contentHero.value.videoKind || 'video' })
  if (contentHero.value.image) return resolveMedia({ public_url: contentHero.value.image, kind: contentHero.value.imageKind || 'image' })
  return resolveMedia(location.value ? locationMedia(location.value as ApiRecord) : null)
})
// The full-bleed hero is this route's LCP element when it is an image.
useHeroLcpPreload(computed(() => heroMedia.value.isVideo ? null : (heroMedia.value.url ?? null)))

const locationSocialCard = computed(() => location.value?.social_image ?? null)
const heroTitle = computed(() => contentHero.value.title || null)
const heroSubtitle = computed(() => contentHero.value.subtitle || null)

const parkingInfo = computed(() => getContentField('parking.info', '') ?? '')
const extraNotes = computed(() => getContentField('extra.notes', '') ?? '')
const sanitizedParkingInfo = computed(() => DOMPurify.sanitize(parkingInfo.value))
const sanitizedExtraNotes = computed(() => DOMPurify.sanitize(extraNotes.value))

// Derived location data
const formattedAddress = computed(() => formatPostalAddress((location.value?.address ?? null) as PostalAddress | null))

const weekHours = computed(() => formatOpeningHours(location.value?.opening_hours ?? null, locale.value, t('saya.location.closed'), location.value?.timezone))
const todayHours = computed(() => getTodayHoursLabel(location.value?.opening_hours ?? null, t('saya.location.closed'), location.value?.timezone, new Date(), location.value?.special_hours ?? null, locale.value))
const isOpenNow = computed(() => getIsOpenNow(location.value?.opening_hours ?? null, location.value?.timezone, location.value?.special_hours ?? null))

const activeClosure = computed(() => getActiveSpecialClosure(location.value?.special_hours, location.value?.timezone))
const activeClosureMessage = computed(() => locale.value === 'en'
  ? formatClosureMessage(activeClosure.value)
  : activeClosure.value ? locationIndexCopy.value.temporarilyUnavailableLabel : '')



const tenantOrigin = useRequestURL().origin.replace(/\/$/, '')
useSocialMetadata(() => ({
  path: location.value?.canonical_url || `/locations/${slug.value}`,
  title: location.value?.seo_title || location.value?.title || '',
  description: location.value?.seo_description || '',
  socialImage: locationSocialCard.value,
  brand: {
    organizationName: organizationName.value,
  },
  breadcrumbs: [
    { name: t('saya.header.locations'), url: '/locations' },
    { name: location.value?.title ?? slug.value, url: `/locations/${slug.value}` },
  ],
}))

useSchemaOrg([
  computed(() => {
    const loc = location.value
    // nuxt-schema-org's own UnheadSchemaOrg plugin explicitly filters out non-object and null
    // nodes before building the graph, so undefined is the correct, filtered "no schema" value
    // here — the vendored UseSchemaOrgInput type just doesn't include it in its union.
    if (!loc) return undefined as unknown as Record<string, unknown>
    const isRestaurant = (organization as ApiValue)?.vertical === 'restaurant'
    return {
      '@type': getBusinessSchemaTypes((organization as ApiValue)?.vertical),
      name: `${organizationName.value} — ${loc.title}`,
      description: formattedAddress.value,
      address: schemaPostalAddress((location.value?.address ?? null) as PostalAddress | null),
      telephone: loc.phone,
      url: `${tenantOrigin}${localePath(`/locations/${loc.slug}`)}`,
      ...(loc.maps_url ? { hasMap: loc.maps_url } : {}),
      openingHoursSpecification: schemaOpeningHours(loc.opening_hours ?? null),
      ...(isRestaurant ? {
        hasMenu: `${tenantOrigin}${localePath(`/locations/${loc.slug}/menu`)}`,
        acceptsReservations: true,
        reservationUrl: `${tenantOrigin}${localePath('/reservations')}`,
        potentialAction: {
          '@type': 'ReserveAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${tenantOrigin}${localePath('/reservations')}` },
          result: { '@type': 'Reservation' },
        },
      } : {}),
      ...(loc.latitude && loc.longitude ? { geo: { '@type': 'GeoCoordinates', latitude: loc.latitude, longitude: loc.longitude } } : {}),
      ...(loc.rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: loc.rating, reviewCount: loc.review_count ?? 0 } } : {})
    }
  }),
])
</script>
