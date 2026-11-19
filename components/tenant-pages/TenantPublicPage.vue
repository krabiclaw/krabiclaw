<template>
  <!-- Every site's authored pages use the shared page renderer. -->
  <template v-if="page">
    <ProductDetailPage v-if="linkedOffer" :key="`${linkedOffer.product.id}:${linkedOffer.location?.id ?? 'online'}:${Boolean(linkedOffer.scope_required)}`" :organization-id="organizationId" :organization-name="linkedOffer.organization_name" :vertical="linkedOffer.product.kind === 'service' ? 'service' : linkedOffer.vertical" :product="linkedOffer.product" :booking="linkedOffer.booking" :location="linkedOffer.location" :locations="linkedOffer.locations" :online-available="linkedOffer.online_available" :scope-required="linkedOffer.scope_required" :currency="linkedOffer.currency" :page-document="page" :collection-name="linkedOffer.collection_name" :presentation="presentationForProduct(linkedOffer.product, organization.theme_id)" :reviews="linkedOffer.reviews" :sessions="linkedOffer.sessions" :collection-siblings="linkedOffer.collection_siblings" :stay-checkout-available="linkedOffer.stay_checkout_available" :stay-confirmation-mode="linkedOffer.stay_confirmation_mode">
      <template #actions>
        <TenantButton v-if="secondaryAction" class="mt-5" variant="outline" :to="secondaryAction.url">{{ secondaryAction.label }}</TenantButton>
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
import { isRecord } from '~/utils/api-clients'
import { loadPublicResourcePayload } from '~/composables/loadPublicResourcePayload'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { normalizeTenantPagePath } from '~/utils/tenant-page-blocks'

const props = defineProps<{ path: string; locale?: string | null }>()
const { previewAuthorized, organization } = useTenantOrganization()
const { id: organizationId, site } = organization
const isPlatform = site.slug === 'platform'
const { locale: i18nLocale, localePath } = useI18n()
// Page ownership is a resolved site, not a tenant type. Blawby's own site is
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
const { consultation } = useOrganizationShellState()
const { data, error, status, execute } = await useAsyncData(key, (_nuxtApp, { signal }) => {
  const query = { path: pagePath.value, locale: activeLocale.value }
  return loadPublicResourcePayload({
    organizationId, resourceKind: 'document', url: `/api/public/pages?${new URLSearchParams(query)}`,
    key: key.value, query, validate: isPageResponse, failureMessage: 'Public page failed', signal, requestEvent,
  })
}, { dedupe: 'defer' })

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
useHead(() => ({ htmlAttrs: { lang: page.value?.locale ?? activeLocale.value } }))
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
  const schedulePath = consultation.value?.schedule_path
  return { ...page.value, blocks: page.value.blocks.filter(block => block.type !== 'hero').map(block => {
    const data = { ...block.data }
    if (canBook && (block.type === 'booking_cta' || block.type === 'contact_cta' || block.type === 'cta') && schedulePath && data.url === schedulePath) data.url = '#consultations'
    return { ...block, data }
  }) }
}

if (data.value?.page) {
  if (!data.value.page.locale_representations) {
    throw createError({ statusCode: 500, statusMessage: 'Tenant page locale representations were not returned' })
  }
  useState<PublicLocaleRepresentation[]>('public-locale-representations', () => []).value = data.value.page.locale_representations
}

useSocialMetadata(() => page.value && ({
  path: page.value.path,
  // Blawby's own brand name is the platform name: its layout's title
  // site and useSocialMetadata already state it once for every platform
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
  professionalService: !isPlatform && isLegalPractice(organization.vertical) ? {
    recipe: linkedOffer.value?.product.kind === 'service' ? 'service-detail' : page.value.recipe,
    offering: linkedOffer.value?.product.kind === 'service' ? {
      name: linkedOffer.value.product.name,
      description: linkedOffer.value.product.description,
    } : undefined,
  } : undefined,
}))
</script>
