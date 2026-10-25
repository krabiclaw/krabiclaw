<template>
  <!--
    One idea at feature scale: words on the left, the picture or video that
    shows them on the right, in one dark card. The badges name the assistants
    a KrabiClaw site is edited from.
  -->
  <PlatformProductStory v-if="page.recipe === 'products'" :block="block" :page="page" />
  <section v-else-if="page.path === '/pricing'" class="kc-pricing-benefit" :class="{ 'kc-pricing-benefit--reverse': benefitIndex % 2 === 1 }" data-parity-section="media-feature">
    <div class="kc-pricing-benefit__inner">
      <div><h2>{{ title }}</h2><p v-if="body">{{ body }}</p></div>
      <img v-if="mediaStillUrl(media)" :src="mediaStillUrl(media)!" :alt="media?.alt_text ?? ''" loading="lazy" decoding="async">
    </div>
  </section>
  <section v-else class="kc-media-feature" data-parity-section="media-feature">
    <div class="kc-media-feature__card">
      <div class="kc-media-feature__copy">
        <ul class="kc-media-feature__badges" aria-label="Works with">
          <li v-for="client in CLIENTS" :key="client.icon" class="kc-media-feature__badge" :title="client.name">
            <Icon :name="client.icon" class="kc-media-feature__badge-icon" :style="{ color: client.color }" />
            <span class="sr-only">{{ client.name }}</span>
          </li>
        </ul>

        <h2 v-if="title" class="kc-media-feature__title">{{ title }}</h2>

        <p v-if="body" class="kc-media-feature__body">
          <template v-for="(part, index) in bodyParts" :key="index">
            <NuxtLink v-if="part.link" :to="route(url!)" class="kc-media-feature__link">{{ part.text }}</NuxtLink>
            <template v-else>{{ part.text }}</template>
          </template>
        </p>
        <NuxtLink v-if="label && url && !linkInBody" :to="route(url)" class="kc-media-feature__link">{{ label }}</NuxtLink>
      </div>

      <div class="kc-media-feature__media">
        <MediaPreview
          v-if="media?.kind === 'video' && media.public_url"
          :item="{ url: media.public_url, kind: 'video', poster: media.thumbnail_url || undefined, alt: media.alt_text || undefined }"
          :controls="reducedMotion === 'reduce'"
        />
        <img
          v-else-if="mediaStillUrl(media)"
          :src="mediaStillUrl(media)!"
          :alt="media?.alt_text ?? ''"
          loading="lazy"
          decoding="async"
        >
        <!-- Nothing chosen yet: the frame keeps its shape and weight, empty. -->
        <div v-else class="kc-media-feature__frame" aria-hidden="true" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import PlatformProductStory from '~/components/platform/marketing/PlatformProductStory.vue'
import MediaPreview from '~/components/MediaPreview.vue'
import { usePreferredReducedMotion } from '@vueuse/core'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockMedia, blockTextOrNull, isInternalRoute } from '~/utils/tenant-page-block-data'
import { mediaStillUrl } from '~/shared/media-placement-contract'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const benefitIndex = computed(() => props.page.blocks.filter(block => block.type === 'media_text').findIndex(block => block.id === props.block.id))
const reducedMotion = usePreferredReducedMotion()
const { localePath } = useI18n()
function route(url: string) { return isInternalRoute(url) ? localePath(url) : url }

const CLIENTS = [
  { name: 'ChatGPT', icon: 'simple-icons:openai', color: '#000000' },
  { name: 'Claude', icon: 'simple-icons:claude', color: '#D97757' },
  { name: 'MCP', icon: 'simple-icons:modelcontextprotocol', color: '#000000' },
] as const

const title = computed(() => blockTextOrNull(props.block.data.title))
const body = computed(() => blockTextOrNull(props.block.data.body))
const label = computed(() => blockTextOrNull(props.block.data.label))
const url = computed(() => blockTextOrNull(props.block.data.url))
const media = computed(() => blockMedia(props.block, 'media')[0] ?? null)

/** The link's words, where the body already says them, become the link. */
const linkInBody = computed(() => Boolean(label.value && url.value && body.value?.includes(label.value)))
const bodyParts = computed(() => {
  const text = body.value ?? ''
  if (!linkInBody.value) return [{ text, link: false }]
  const at = text.indexOf(label.value!)
  return [
    { text: text.slice(0, at), link: false },
    { text: label.value!, link: true },
    { text: text.slice(at + label.value!.length), link: false },
  ].filter(part => part.text)
})
</script>

<style scoped>
.kc-media-feature {
  padding: clamp(2rem, 5vw, 4rem) 0;
  background: var(--ui-bg);
}

.kc-media-feature__card {
  display: grid;
  grid-template-columns: 45fr 55fr;
  align-items: center;
  gap: clamp(2rem, 4vw, 4rem);
  width: min(100% - clamp(2rem, 6vw, 6rem), 118rem);
  min-height: clamp(34rem, 48vw, 46rem);
  margin: 0 auto;
  padding: clamp(2rem, 5vw, 5rem);
  border-radius: 2rem;
  background:
    radial-gradient(110% 90% at 0% 0%, color-mix(in srgb, var(--kc-navy-500) 55%, transparent) 0%, transparent 60%),
    linear-gradient(120deg, var(--kc-navy) 0%, var(--kc-navy-700) 50%, #05060d 100%);
  color: #fff;
  overflow: hidden;
}

.kc-media-feature__copy {
  display: flex;
  flex-direction: column;
  align-self: stretch;
}

.kc-media-feature__badges {
  display: flex;
  margin: 0 0 auto;
  padding: 0;
  list-style: none;
}

.kc-media-feature__badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: clamp(3.75rem, 5.5vw, 5.25rem);
  aspect-ratio: 1;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
}

.kc-media-feature__badge + .kc-media-feature__badge {
  margin-left: calc(clamp(3.75rem, 5.5vw, 5.25rem) * -0.22);
}

.kc-media-feature__badge-icon {
  width: 46%;
  height: 46%;
}

.kc-media-feature__title {
  margin: clamp(3rem, 8vw, 7rem) 0 0;
  color: #fff;
  font-size: clamp(2.6rem, 5vw, 5rem);
  font-weight: 300;
  letter-spacing: -0.03em;
  line-height: 1.04;
  text-wrap: balance;
}

.kc-media-feature__body {
  max-width: 34ch;
  margin: clamp(1.5rem, 2.5vw, 2.25rem) 0 0;
  color: rgb(255 255 255 / 64%);
  font-size: clamp(1.1rem, 1.6vw, 1.6rem);
  line-height: 1.5;
  white-space: pre-line;
}

.kc-media-feature__link {
  color: rgb(255 255 255 / 88%);
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.kc-media-feature__link:hover {
  color: #fff;
}

.kc-media-feature__media {
  position: relative;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  border-radius: 1.5rem;
}

.kc-media-feature__media video,
.kc-media-feature__media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.kc-media-feature__frame {
  width: 100%;
  height: 100%;
  border: 1px solid rgb(255 255 255 / 8%);
  border-radius: inherit;
  background:
    radial-gradient(60% 70% at 70% 35%, rgb(235 110 90 / 16%) 0%, transparent 70%),
    radial-gradient(50% 60% at 25% 75%, color-mix(in srgb, var(--kc-teal) 14%, transparent) 0%, transparent 70%),
    linear-gradient(160deg, rgb(255 255 255 / 5%) 0%, rgb(0 0 0 / 25%) 100%);
}

@media (max-width: 899px) {
  .kc-media-feature__card {
    grid-template-columns: 1fr;
    min-height: 0;
    padding: clamp(1.75rem, 6vw, 3rem);
  }

  .kc-media-feature__title {
    margin-top: 2.5rem;
    font-size: clamp(2.6rem, 10vw, 3.1rem);
  }
}
</style>

<style scoped>
.kc-pricing-benefit { background: #f9f8f4; color: #252b43; padding: 0 1.5rem; }
.kc-pricing-benefit__inner { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4.5rem; align-items: center; max-width: 62rem; margin: auto; padding: 3rem 0; border-bottom: 1px solid #e3e8ef; }
.kc-pricing-benefit h2 { font-size: clamp(1.75rem, 2.5vw, 2.4rem); font-weight: 600; line-height: 1.2; letter-spacing: -.025em; margin: 0; }
.kc-pricing-benefit p { color: #646878; max-width: 50ch; line-height: 1.6; margin: .65rem 0 0; }
.kc-pricing-benefit img { order: -1; width: 100%; max-height: 19rem; aspect-ratio: 3 / 2; object-fit: contain; }
.kc-pricing-benefit--reverse img { order: 1; }
@media (max-width: 700px) {
  .kc-pricing-benefit__inner { grid-template-columns: 1fr; gap: 1rem; padding: 2rem 0; }
  .kc-pricing-benefit img, .kc-pricing-benefit--reverse img { order: 1; max-height: 16rem; }
}
</style>
