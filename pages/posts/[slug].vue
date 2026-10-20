<template>
  <SocialPostDetail v-if="post" :post="post" :brand="postBrand" />
</template>

<script setup lang="ts">
import SocialPostDetail from '~/components/social/SocialPostDetail.vue'
import { isPublicSocialPost, type PublicSocialPost } from '~/utils/public-resource-contracts'
import { publicApiRequest, isRecord } from '~/utils/api-clients'

definePageMeta({ middleware: 'template-layout' })

type DetailPost = PublicSocialPost & { localeRepresentations: Array<{ locale: string; label: string; route_path: string; source: 'source' | 'localized' }> }

const isPublicPostResponse = (value: unknown): value is { post: DetailPost } =>
  isRecord(value) && isPublicSocialPost(value.post) && Array.isArray((value.post as unknown as Record<string, unknown>).localeRepresentations)

const route = useRoute()
const requestEvent = useRequestEvent()
const { organization, previewAuthorized } = useTenantOrganization()
const { id: organizationId } = organization
const isPlatform = organization.template.slug === 'platform'
const { locale } = useI18n()

const slug = computed(() => String(route.params.slug))
const organizationName = organization.name
const postBrand = { name: organization.name, logoUrl: organization.logos.find(logo => logo.slot === 'logo')?.url ?? null }

// One reader for the server render and client navigation: the SSR path calls
// it directly and the client asks the public API, which calls the same one.
const { data, error } = await useAsyncData(
  () => `public-post-${organizationId}-${locale.value}-${slug.value}-${previewAuthorized ? 'preview' : 'published'}`,
  async () => {
    let post: DetailPost | null
    if (import.meta.server) {
      if (!requestEvent) throw createError({ statusCode: 500, statusMessage: 'Request context unavailable' })
      const [{ cloudflareEnv }, { getPublicSocialPost }] = await Promise.all([
        import('~/server/utils/api-response'),
        import('~/server/utils/post-management'),
      ])
      const env = cloudflareEnv(requestEvent)
      if (!env.DB) throw createError({ statusCode: 503, statusMessage: 'Database not available' })
      post = await getPublicSocialPost(env, env.DB, organizationId, slug.value, locale.value, previewAuthorized)
    } else {
      post = (await publicApiRequest<{ post: DetailPost }>(`/api/public/posts/${encodeURIComponent(slug.value)}`, {
        query: { locale: locale.value }, validate: isPublicPostResponse,
      })).post
    }
    if (!post) throw createError({ statusCode: 404, statusMessage: 'Post not found' })
    return { post }
  },
)
if (error.value) throw error.value
useState<DetailPost['localeRepresentations']>('public-locale-representations', () => []).value = data.value?.post.localeRepresentations ?? []

const post = computed(() => data.value?.post ?? null)
// A post without a title is described by its own words, and titled by the
// business that wrote it; nothing is invented for it.
const seoTitle = computed(() => post.value?.title || post.value?.body?.split('\n').find(line => line.trim())?.slice(0, 70) || organizationName)
const seoDescription = computed(() => post.value?.body || post.value?.title || '')
useSocialMetadata(() => post.value && ({
  path: post.value.path,
  // A tenant's page names the business, as its other pages do; KrabiClaw's template adds its own name.
  title: isPlatform || seoTitle.value === organizationName ? seoTitle.value : `${seoTitle.value} | ${organizationName}`,
  description: seoDescription.value,
  pageType: 'article',
  author: organizationName,
  article: { type: 'Article', authorType: 'Organization', inLanguage: locale.value, imageUrl: post.value.social_image?.url },
  socialImage: post.value.social_image,
  publishedAt: post.value.published_at,
  discoverability: post.value.status === 'draft' ? 'private' : post.value.visibility,
  breadcrumbs: [
    { name: seoTitle.value, url: post.value.path },
  ],
}))
</script>
