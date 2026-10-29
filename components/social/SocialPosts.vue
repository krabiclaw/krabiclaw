<template>
  <section v-if="view.posts.length || !block" class="bg-default text-default" :data-social-posts="block ? 'block' : 'feed'">
    <div class="tenant-container py-16 sm:py-20">
      <div v-if="view.title || view.description || view.callToAction" class="mb-10 flex flex-wrap items-end justify-between gap-6">
        <div class="max-w-3xl">
          <h2 v-if="view.title" class="font-[family-name:var(--font-heading)] [font-weight:var(--font-heading-weight)] text-3xl leading-tight text-highlighted sm:text-5xl">{{ view.title }}</h2>
          <p v-if="view.description" class="mt-3 text-xl leading-relaxed text-muted sm:text-2xl">{{ view.description }}</p>
        </div>
        <NuxtLink v-if="view.callToAction" :to="route(view.callToAction.url)" class="inline-flex items-center gap-2 text-sm font-semibold text-highlighted no-underline hover:underline">{{ view.callToAction.label }}<span aria-hidden="true">→</span></NuxtLink>
      </div>

      <UCarousel v-if="block" :items="view.posts" loop dots align="start" :ui="{ item: 'basis-[85%] ps-6 sm:basis-1/2 lg:basis-1/3', container: '-ms-6 items-start', dots: 'gap-2', dot: 'gallery-dot' }">
        <template #default="{ item }"><SocialPostCard :post="item" @open="openPost(item.id)" /></template>
      </UCarousel>
      <div v-else class="mx-auto flex max-w-2xl flex-col gap-10 sm:gap-12">
        <SocialPostCard v-for="post in view.posts" :key="post.id" :post="post" @open="openPost(post.id)" />
      </div>
      <MediaLightbox v-model:open="viewerOpen" v-model:index="viewerIndex" :items="gallery" />
      <p v-if="!block && !view.posts.length" class="rounded-[calc(var(--ui-radius)*2)] border border-dashed border-default p-10 text-center text-muted">{{ t('social_posts.empty') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { provideMediaPreviews } from '~/components/MediaPreview.vue'
import SocialPostCard from '~/components/social/SocialPostCard.vue'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { PublicSocialPost } from '~/server/utils/post-management'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { socialPostsBlockView } from '~/utils/social-post-block'
import { isInternalRoute } from '~/utils/tenant-page-block-data'

const props = defineProps<{
  block?: TenantPageBlock
  page?: PublicTenantPage
  /** The feed, when this draws /posts rather than a page block. */
  posts?: PublicSocialPost[]
}>()
const { t, localePath } = useI18n()
const view = computed(() => props.block ? socialPostsBlockView(props.block) : { title: null, description: null, callToAction: null, posts: props.posts ?? [] })
const gallery = computed(() => view.value.posts.flatMap(post => post.media.map(media => ({ url: media.public_url, kind: media.kind, alt: media.alt_text ?? '', poster: media.thumbnail_url ?? undefined, description: post.body ?? undefined }))))
const viewerOpen = ref(false)
provideMediaPreviews(viewerOpen)
const viewerIndex = ref(0)
function openPost(postId: string) {
  const post = view.value.posts.find(item => item.id === postId)
  if (!post) return
  if (!post.media.length) {
    void navigateTo(localePath(`/posts/${post.slug}`))
    return
  }
  viewerIndex.value = galleryIndex(postId)
  viewerOpen.value = true
}
function galleryIndex(postId: string) {
  let index = 0
  for (const post of view.value.posts) {
    if (post.id === postId) return index
    index += post.media.length
  }
  return 0
}
function route(url: string) { return isInternalRoute(url) ? localePath(url) : url }
</script>
