<template>
  <!--
    One renderer per template, chosen here. Every Blawby page is a Blawby page:
    the practice areas were the only ones an allowlist of seven paths left out,
    so they rendered in the Saya markup on a Blawby site. Krabiclaw's own pages
    are Krabiclaw pages for the same reason — rendered through the Saya block
    loop they lost every section the marketing site had (#903).
  -->
  <template v-if="page">
    <ProductDetailPage v-if="linkedOffer" :key="`${linkedOffer.product.id}:${linkedOffer.location?.id ?? 'online'}:${Boolean(linkedOffer.scopeRequired)}`" :organization-id="organizationId" :organization-name="linkedOffer.brandName" :vertical="linkedOffer.product.kind === 'service' ? 'service' : linkedOffer.vertical" :product="linkedOffer.product" :booking="linkedOffer.booking" :location="linkedOffer.location" :locations="linkedOffer.locations" :online-available="linkedOffer.onlineAvailable" :scope-required="linkedOffer.scopeRequired" :currency="linkedOffer.currency" :page-document="page" :collection-name="linkedOffer.collectionName" :presentation="presentationForProduct(linkedOffer.vertical, linkedOffer.product, organization.theme_id)" :reviews="linkedOffer.reviews" :sessions="linkedOffer.sessions" :collection-siblings="linkedOffer.collectionSiblings">
      <template #actions>
        <BlawbyButton v-if="secondaryAction" class="mt-5" variant="outline" :to="secondaryAction.url">{{ secondaryAction.label }}</BlawbyButton>
      </template>
      <template #content="{ canBook }">
        <TenantPageRenderer :page="serviceContent(canBook)" />
      </template>
    </ProductDetailPage>
    <TenantPageRenderer v-else :page="page" />
  </template>
</template>

<script setup lang="ts">
import ProductDetailPage from '~/components/products/ProductDetailPage.vue'
import { presentationForProduct } from '~/utils/product-presentation'
import { blockTextOrNull, isInternalRoute } from '~/utils/tenant-page-block-data'
import { publicApiRequest, isRecord } from '~/utils/api-clients'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { normalizeTenantPagePath } from '~/utils/tenant-page-blocks'
import type { BlawbyDocumentPayload } from '~/utils/blawby-document-contract'

const props = defineProps<{ path: string; locale?: string | null }>()
const { previewAuthorized, organization } = useTenantOrganization()
const { id: organizationId, template } = organization
const isPlatform = template.slug === 'platform'
const { locale: i18nLocale, localePath } = useI18n()
// Page ownership is a resolved site, not a tenant type. Krabiclaw's own site is
// a site row with page documents like any other, and requiring `isTenant` here
// is what forced its marketing pages to be hardcoded components (#903).
if (!organizationId) throw showNotFound('Organization context is unavailable')

// Preview authorization belongs to the site, resolved once from the preview
// cookie by tenant resolution; the client's API call carries the same cookie.
const preview = previewAuthorized
const activeLocale = computed(() => {
  if (props.locale?.trim()) return props.locale.trim()
  return i18nLocale.value
})
/**
 * The path this instance is showing, normalized by the same function that
 * normalizes it on the way into the database
 * (`normalizeTenantPagePath`, utils/tenant-page-blocks.ts).
 *
 * A computed rather than a constant so the fetch key follows the prop: this
 * component is a child of one catch-all route that serves every page path, and
 * the key is the only thing that distinguishes one page's read from another's.
 */
const pagePath = computed(() => normalizeTenantPagePath(props.path))
const key = computed(() => `tenant-page-${organizationId}-${activeLocale.value}-${pagePath.value}-${preview ? 'preview' : 'published'}`)
const isPageResponse = (value: unknown): value is { success: true; page: PublicTenantPage } =>
  isRecord(value) && value.success === true && isRecord(value.page) && typeof value.page.path === 'string' && Array.isArray(value.page.blocks)

const requestEvent = useRequestEvent()
const blawbyDocument = inject<Ref<BlawbyDocumentPayload> | null>('blawby-document', null)
const { data, error, status, execute } = await useAsyncData(key, async () => {
  if (template.slug === 'blawby') {
    const page = blawbyDocument?.value.route.page
    if (!page || page.locale !== activeLocale.value
      || resolveTenantLocalePath(page.path, [activeLocale.value]).sourcePath !== pagePath.value) {
      throw createError({ statusCode: 500, statusMessage: 'Blawby layout did not provide the requested page' })
    }
    return { success: true as const, page }
  }
  if (import.meta.server) {
    if (!requestEvent) throw createError({ statusCode: 500, statusMessage: 'Request context unavailable' })
    const [{ cloudflareEnv }, { getPublicTenantPageForPath }] = await Promise.all([
      import('~/server/utils/api-response'),
      import('~/server/utils/public-tenant-pages'),
    ])
    const env = cloudflareEnv(requestEvent)
    const db = env.db
    if (!db) throw createError({ statusCode: 503, statusMessage: 'Database not available' })
    const page = await getPublicTenantPageForPath(env, db, organizationId, pagePath.value, { locale: activeLocale.value, preview })
    if (!page) throw createError({ statusCode: 404, statusMessage: 'Tenant page not found' })
    return { success: true as const, page }
  }
  const query: Record<string, string> = { path: pagePath.value }
  const endpoint = activeLocale.value === 'en'
    ? `/api/public/pages`
    : `/api/public/localized-pages/${encodeURIComponent(activeLocale.value)}`
  return await publicApiRequest<{ success: true; page: PublicTenantPage }>(endpoint, {
    query,
    validate: isPageResponse,
    coalesceKey: key.value,
  })
}, {
  server: true,
  lazy: false,
  getCachedData(cacheKey) {
    return useNuxtApp().payload.data[cacheKey] as { success: true; page: PublicTenantPage } | undefined
  },
})

// Nuxt can defer a child request until mount while the previous route is
// still hydrating. Await that same request before requiring its document.
if (status.value === 'idle' || status.value === 'pending') await execute({ dedupe: 'defer' })
// A throw from setup only reaches the error page during the server render; on
// a client navigation it leaves a blank screen (DESIGN.md), so the client
// raises it with showError first.
if (error.value) {
  if (import.meta.server) throw error.value
  throw showError(error.value)
}
// A client navigation can tear this instance down while its request is still in
// flight: Nuxt drops the async data and the awaited call returns empty with no
// error. That is not a page that failed to load, it is a page nobody is looking
// at any more, and turning it into a 500 put an uncaught error on every visitor
// who clicked twice quickly. Only a settled request with no page is a failure.
if (!data.value?.page && status.value === 'success') {
  throw createError({ statusCode: 500, statusMessage: 'Tenant page data was not returned' })
}

const page = computed(() => data.value?.page ?? null)
// A service document owns content and SEO; its explicit root binding owns the
// Product supplying Price, Session and Booking. Never derive it from a slug.
const linkedOffer = await usePublicPageProduct(pagePath, activeLocale, computed(() => page.value?.product_id ?? null))
const secondaryAction = computed(() => {
  const hero = page.value?.blocks.find(block => block.type === 'hero')
  const label = blockTextOrNull(hero?.data.secondary_label)
  const url = blockTextOrNull(hero?.data.secondary_url)
  return label && url ? { label, url: isInternalRoute(url) ? localePath(url) : url } : null
})
// ProductDetailPage owns bookability. Only its rendered booking section receives
// authored scheduling links; unavailable products keep the site's scheduling URL.
function serviceContent(canBook: boolean): PublicTenantPage {
  if (!page.value) throw createError({ statusCode: 500, statusMessage: 'Service document was not returned' })
  const schedulePath = blawbyDocument?.value.shell.consultation.schedule_path
  return { ...page.value, blocks: page.value.blocks.filter(block => block.type !== 'hero').map(block => {
    const data = { ...block.data }
    if (canBook && (block.type === 'booking_cta' || block.type === 'contact_cta' || block.type === 'cta') && schedulePath && data.url === schedulePath) data.url = '#consultations'
    return { ...block, data }
  }) }
}

// The locale representations of the page this instance is showing, written the
// way every other public route writes them (pages/blog/[slug].vue,
// pages/posts/[slug].vue, pages/links.vue, layouts/blawby.vue): once, in setup.
//
// Not a watcher, and above all not a `watchEffect`: calling `useState` inside
// the effect read the payload entry the effect then wrote, so the effect was
// its own dependency and re-triggered forever. Vue's own guidance is the
// reason -- "watchEffect ... automatically tracks every reactive property
// accessed during its synchronous execution", while `watch` "won't track
// anything accessed inside the callback"
// (https://vuejs.org/guide/essentials/watchers, "watch vs. watchEffect").
// In the production build that warning is compiled out, so the only symptom
// was a pegged tab with an empty console.
//
// Setup is enough because Nuxt keys <NuxtPage> by the matched route path with
// its params interpolated (nuxt/dist/pages/runtime/utils.js:9), so a hop
// between two paths this catch-all serves mounts a new instance.
//
// Guarded by the same abandoned-instance condition as the check above: a page
// nobody is looking at any more has nothing to announce.
if (data.value?.page) {
  if (!data.value.page.localeRepresentations) {
    throw createError({ statusCode: 500, statusMessage: 'Tenant page locale representations were not returned' })
  }
  useState<PublicLocaleRepresentation[]>('public-locale-representations', () => []).value = data.value.page.localeRepresentations
}

useSocialMetadata(() => page.value && ({
  path: page.value.path,
  // Krabiclaw's own brand name is the platform name: its layout's title
  // template and useSocialMetadata already state it once for every platform
  // surface, so the page names only itself. A tenant states its own name.
  title: isPlatform ? page.value.title : `${page.value.title} | ${organization.name}`,
  description: page.value.summary || '',
  socialImage: page.value.social_image,
  contentBlocks: page.value.blocks,
  schemaPageType: isPlatform && page.value.path === '/' ? 'SoftwareApplication' : undefined,
  softwareApplication: isPlatform && page.value.path === '/' ? {
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'All (Web / Cloud-based)',
  } : undefined,
  breadcrumbs: page.value.path === '/' ? undefined : [
    { name: isPlatform ? 'Home' : organization.name, url: '/' },
    { name: page.value.title, url: page.value.path },
  ],
  professionalService: template.slug === 'blawby' ? {
    recipe: linkedOffer.value?.product.kind === 'service' ? 'service-detail' : page.value.recipe,
    offering: linkedOffer.value?.product.kind === 'service' ? {
      name: linkedOffer.value.product.name,
      description: linkedOffer.value.product.description,
      schemaType: presentationForProduct(linkedOffer.value.vertical, linkedOffer.value.product, organization.theme_id).structuredDataType,
    } : undefined,
  } : undefined,
}))
</script>
