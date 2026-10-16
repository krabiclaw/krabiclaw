<template>
  <div class="min-h-screen">
    <header class="mx-auto max-w-7xl px-4 pt-[calc(4rem+var(--header-overlap,0px))] sm:px-6 lg:px-8">
      <h1 class="font-[family-name:var(--font-heading)] text-4xl leading-tight text-highlighted [font-weight:var(--font-heading-weight)] sm:text-5xl">{{ t('social_posts.title') }}</h1>
      <nav v-if="locations.length > 1" class="mt-8 flex flex-wrap gap-3" :aria-label="t('social_posts.by_location')">
        <NuxtLink
          v-for="loc in locations"
          :key="loc.id"
          :to="localePath(`/locations/${loc.slug}/posts`)"
          class="inline-flex items-center rounded-full border border-default px-5 py-2.5 text-sm text-muted no-underline transition hover:bg-elevated hover:text-default"
        >
          {{ loc.title }}
        </NuxtLink>
      </nav>
    </header>

    <SocialPosts :posts="feed.posts.value" />
    <div v-if="feed.hasMore.value || feed.failed.value" class="flex flex-col items-center gap-3 pb-20">
      <p v-if="feed.failed.value" role="alert" class="text-sm text-error">{{ t('social_posts.load_failed') }}</p>
      <button v-if="feed.hasMore.value" type="button" class="rounded-full border border-default px-6 py-2.5 text-sm font-medium text-default transition hover:bg-muted disabled:opacity-60" :disabled="feed.loading.value" :aria-busy="feed.loading.value" @click="feed.loadMore">{{ t('social_posts.load_more') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import SocialPosts from '~/components/social/SocialPosts.vue'
definePageMeta({ middleware: 'template-layout' })

const { organization } = useTenantOrganization()
const isPlatform = organization.template.slug === 'platform'
const { t, localePath } = useI18n()

const { locations, sections } = await usePublicPageData()
// A section with nothing on it is not a page; the navigation hides it by the same flag.
if (sections.value?.posts === false) throw createError({ statusCode: 404 })
const feed = await useSocialPostFeed(() => ({ locationId: null }))
const organizationName = organization.name

useSocialMetadata(() => ({
  path: '/posts',
  // KrabiClaw's own pages carry the product name through their template.
  title: isPlatform ? t('social_posts.title') : `${t('social_posts.title')} | ${organizationName}`,
  description: t('social_posts.meta_description', { organization: organizationName }),
  socialImage: organization.social_image,
  breadcrumbs: [
    { name: t('social_posts.title'), url: '/posts' },
  ],
}))
</script>
