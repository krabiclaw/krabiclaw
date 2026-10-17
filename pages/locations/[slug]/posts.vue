<template>
  <div class="min-h-screen bg-default text-default">

    <template v-if="location">
      <!-- Sub-nav (Level 2) -->
      <SayaSubNav
        :location-slug="slug"
        active="posts"
      />

      <!-- Compact Page header -->
      <header class="mx-auto max-w-7xl px-4 pt-12 pb-10 sm:px-6 lg:px-8 text-center">
        <NuxtLink :to="localePath(`/locations/${slug}`)" class="saya-kicker mb-8 inline-block text-muted no-underline hover:text-default">
          ← {{ t('saya.location.back_to', { title: location?.title }) }}
        </NuxtLink>

        <div class="flex flex-col gap-2">
          <h1 class="saya-display-md text-default">
            <em class="saya-italic">{{ t('saya.location.posts_from', { title: location?.title }) }}</em>
          </h1>
        </div>
      </header>
    </template>

    <SocialPosts :posts="feed.posts.value" />
    <div v-if="feed.hasMore.value || feed.failed.value" class="flex flex-col items-center gap-3 pb-20">
      <p v-if="feed.failed.value" role="alert" class="text-sm text-error">{{ t('social_posts.load_failed') }}</p>
      <button v-if="feed.hasMore.value" type="button" class="rounded-full border border-default px-6 py-2.5 text-sm font-medium text-default transition hover:bg-muted disabled:opacity-60" :disabled="feed.loading.value" :aria-busy="feed.loading.value" @click="feed.loadMore">{{ t('social_posts.load_more') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import SocialPosts from '~/components/social/SocialPosts.vue'
const { localePath, t } = useI18n()

definePageMeta({ layout: 'tenant' })

const route = useRoute()
const { organization } = useTenantOrganization()
const slug = computed(() => String(route.params.slug))
const organizationName = computed(() => String((organization as ApiValue)?.name ?? '').trim())

const { location } = await usePublicPageData()
// A slug naming no location is a URL that does not exist. Rendering the page
// around a null location answered 200 with an empty shell — a soft 404 a
// crawler indexes. The sibling menu and product indexes already refuse it.
if (!location.value) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
// A section with nothing on it is not a page; the navigation hides it by the same flag.
if (!location.value.sections.posts) throw createError({ statusCode: 404 })

const feed = await useSocialPostFeed(() => ({ locationId: location.value!.id }))

useSocialMetadata(() => ({
  path: `/locations/${slug.value}/posts`,
  title: `Updates · ${location.value?.title || slug.value}`,
  description: `Latest news and updates from ${location.value?.title || slug.value} at ${organizationName.value}.`,
  socialImage: location.value?.social_image ?? null,
  breadcrumbs: [
    { name: 'Locations', url: '/locations' },
    { name: location.value?.title ?? slug.value, url: `/locations/${slug.value}` },
    { name: 'Updates', url: `/locations/${slug.value}/posts` },
  ],
}))
</script>
