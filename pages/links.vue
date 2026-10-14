<template>
  <NuxtLayout :name="template.layout">
    <section v-if="linksPage" :class="templateClass">
      <div :class="shellClass">
        <div :class="identityClass">
          <img
            v-if="profileImageUrl"
            :src="profileImageUrl"
            :alt="brandName"
            :class="profileImageClass"
          >
          <p v-if="template.slug === 'blawby'" class="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--blawby-accent-strong)]">{{ linksPage.page.title }}</p>
          <h1 :class="headingClass">{{ linksPage.page.title }}</h1>
        </div>

        <nav id="featured-links" :aria-label="linksPage.page.title" class="mt-8">
          <ol class="space-y-3">
            <li v-for="item in linksPage.items" :key="item.id">
              <a
                :href="localizedDestination(item.destination)"
                :target="externalTarget(item.destination)"
                :rel="externalRel(item.destination)"
                :class="linkClass"
                :data-link-item-id="item.id"
                @click="trackLinkClick(item)"
              >
                <span class="min-w-0 flex-1">
                  <span :class="labelClass">{{ item.label }}</span>
                </span>
              </a>
            </li>
          </ol>
        </nav>
      </div>
    </section>
  </NuxtLayout>
</template>

<script setup lang="ts">
import { ApiClientError, publicApiRequest } from '~/utils/api-clients'
import { isPublicLinksPayload, isPublicLinksResponse, type PublicLinksItem, type PublicLinksPayload } from '~/utils/public-links-contract'

definePageMeta({ layout: false })

const { id: organizationId, template, social_image: organizationSocialImage } = useTenantOrganization().organization
const isTenant = template.slug !== 'platform'
const route = useRoute()
const { localePath } = useI18n()
const locale = typeof route.params.locale === 'string' ? route.params.locale : 'en'
const requestEvent = useRequestEvent()
if (!isTenant) {
  throw createError({ statusCode: 404, statusMessage: 'Links page not found' })
}

const { data, error } = await useAsyncData<PublicLinksPayload | null>(
  `public-links-page-${organizationId}-${locale}`,
  async (_nuxtApp, { signal }) => {
    if (import.meta.server) {
      if (!requestEvent) throw createError({ statusCode: 500, statusMessage: 'Request context unavailable' })
      const [{ cloudflareEnv }, { getPublicLinksPage }] = await Promise.all([
        import('~/server/utils/api-response'),
        import('~/server/utils/links-page'),
      ])
      const env = cloudflareEnv(requestEvent)
      const db = env.db
      if (!db) throw createError({ statusCode: 500, statusMessage: 'Database not available' })
      const response = await getPublicLinksPage(env, db, organizationId, locale)
      if (response !== null && !isPublicLinksPayload(response)) {
        throw new ApiClientError('Public links response did not match its contract', 502, 'INVALID_PUBLIC_LINKS_RESPONSE', null)
      }
      return response
    }
    return await publicApiRequest(`/api/public/links-page?locale=${encodeURIComponent(locale)}`, {
      signal,
      coalesceKey: `public-links-page-${organizationId}-${locale}`,
      validate: isPublicLinksResponse,
    })
  },
  { server: true, lazy: false },
)

if (error.value) throw error.value
if (!data.value) throw createError({ statusCode: 404, statusMessage: 'Links page not found' })
useState<PublicLinksPayload['localeRepresentations']>('public-locale-representations', () => []).value = data.value.localeRepresentations

const linksPage = computed(() => data.value)
const brandName = computed(() => linksPage.value?.organization.name || linksPage.value?.page.title || '')
const profileImageUrl = computed(() => linksPage.value?.organization.media.find(item => item.slot === 'logo')?.public_url || null)
const { trackLinkClick: recordLinkClick } = useOrganizationConversionTracking()

const templateClass = 'min-h-[calc(100vh-8rem)] bg-default px-4 py-10 sm:px-6 sm:py-14'
const shellClass = 'mx-auto max-w-md'
const identityClass = 'text-center'
const profileImageClass = 'mx-auto size-18 rounded-full object-cover shadow-sm'
const headingClass = computed(() => template.slug === 'blawby'
  ? 'mt-5 text-3xl font-semibold tracking-normal text-highlighted'
  : 'saya-display-md mt-5 text-default')
const linkClass = computed(() => template.slug === 'blawby'
  ? 'group flex min-h-14 items-center rounded-lg border border-default bg-elevated px-5 py-4 text-center text-highlighted no-underline shadow-sm transition hover:-translate-y-0.5 hover:border-secondary hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-secondary'
  : 'group flex min-h-14 items-center rounded-full border border-primary/25 bg-primary/8 px-5 py-4 text-center text-default no-underline shadow-sm transition hover:-translate-y-0.5 hover:bg-primary/12 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary')
const labelClass = 'block truncate text-base font-semibold'

function isHttpDestination(destination: string) {
  return /^https?:\/\//i.test(destination)
}

function externalTarget(destination: string) {
  return isHttpDestination(destination) ? '_blank' : undefined
}

function externalRel(destination: string) {
  return isHttpDestination(destination) ? 'noopener noreferrer' : undefined
}

function localizedDestination(destination: string) {
  return destination.startsWith('/') ? localePath(destination) : destination
}

function trackLinkClick(item: PublicLinksItem) {
  if (!import.meta.client) return
  recordLinkClick(item.id)
}

// A page about the business: its image is the organization's.
useSocialMetadata(() => ({
  path: '/links',
  socialImage: organizationSocialImage,
  title: linksPage.value?.page.title || brandName.value,
  description: linksPage.value?.organization.brand_description || '',
  discoverability: 'unlisted',
}))
</script>
