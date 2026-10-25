<template>
  <!--
    One post's page, on every template: its media beside its words on a wide
    screen and above them on a phone, who posted it and when, its call to
    action, and where else it was posted. A text-only post is one readable
    column. The template's tokens give it its colours, heading face and radius.
  -->
  <article class="mx-auto w-full max-w-7xl px-4 pb-16 pt-[calc(1.5rem+var(--header-overlap,0px))] sm:px-6 sm:pt-[calc(2.5rem+var(--header-overlap,0px))] lg:px-8">
    <div class="mb-5 flex items-center justify-between gap-4">
      <NuxtLink :to="localePath(backTo)" class="inline-flex items-center gap-2 text-sm font-medium text-muted no-underline transition hover:text-default">
        <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" aria-hidden="true"><path d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
        {{ t('social_posts.back') }}
      </NuxtLink>
      <SocialPostShare :title="post.title" button-class="inline-flex items-center gap-2 rounded-[var(--ui-radius)] border border-default bg-default px-4 py-2 text-sm font-semibold text-default transition hover:bg-elevated" />
    </div>

    <div :class="['overflow-hidden rounded-[calc(var(--ui-radius)*3)] border border-default bg-default', post.media.length ? 'lg:grid lg:grid-cols-[minmax(0,1.65fr)_minmax(340px,0.85fr)]' : 'mx-auto max-w-3xl']">
      <section v-if="post.media.length" class="min-w-0 bg-black" :aria-label="t('social_posts.media_label', { count: post.media.length })">
        <MediaGallery :items="post.media.map(media => ({ url: media.public_url, kind: media.kind, alt: media.alt_text ?? '', poster: media.thumbnail_url ?? undefined, description: post.body ?? undefined }))" :title="post.title || t('site.photos.gallery_title')" />
      </section>

      <section class="flex min-w-0 flex-col px-5 py-6 sm:px-7 sm:py-8">
        <div class="flex min-w-0 items-center gap-3">
          <img v-if="brand.logoUrl" :src="brand.logoUrl" :alt="`${brand.name} logo`" class="size-12 shrink-0 rounded-full border border-default bg-white object-contain p-1">
          <div class="min-w-0">
            <p class="truncate font-semibold text-default">{{ brand.name }}</p>
            <NuxtLink v-if="post.location" :to="localePath(`/locations/${post.location.slug}`)" class="mt-0.5 block truncate text-sm text-muted no-underline transition hover:text-default">{{ post.location.title }}</NuxtLink>
            <time v-if="post.published_at" :datetime="post.published_at" class="mt-0.5 block text-xs text-dimmed">{{ formatDate(post.published_at) }}</time>
          </div>
        </div>

        <h1 v-if="post.title" class="mt-7 font-[family-name:var(--font-heading)] text-3xl leading-tight text-highlighted [font-weight:var(--font-heading-weight)] sm:text-4xl">{{ post.title }}</h1>
        <p v-if="post.body" :class="['whitespace-pre-line text-base leading-7 text-default', post.title ? 'mt-5' : 'mt-7']">{{ post.body }}</p>

        <NuxtLink v-if="post.call_to_action" :to="route(post.call_to_action.url)" class="mt-6 inline-flex items-center justify-center rounded-[var(--ui-radius)] bg-primary px-5 py-3 text-sm font-semibold text-on-primary no-underline transition hover:opacity-90">
          {{ post.call_to_action.label }}
        </NuxtLink>

        <div v-if="post.publications.length" class="mt-6 border-t border-default pt-5">
          <SocialPostChannels :publications="post.publications" item-class="inline-flex items-center gap-2 rounded-full border border-default px-3 py-1.5 text-sm font-medium text-default no-underline transition hover:bg-elevated" />
        </div>
      </section>
    </div>
  </article>
</template>

<script setup lang="ts">
import MediaGallery from '~/components/MediaGallery.vue'
import SocialPostChannels from '~/components/social/SocialPostChannels.vue'
import SocialPostShare from '~/components/social/SocialPostShare.vue'
import type { PublicSocialPost } from '~/server/utils/post-management'
import { isInternalRoute } from '~/utils/tenant-page-block-data'

const props = defineProps<{ post: PublicSocialPost; brand: { name: string; logoUrl: string | null } }>()
const { localePath, t } = useI18n()
const { formatDate } = useLocaleDate()
const backTo = computed(() => props.post.location ? `/locations/${props.post.location.slug}/posts` : '/posts')
function route(url: string) { return isInternalRoute(url) ? localePath(url) : url }
</script>
