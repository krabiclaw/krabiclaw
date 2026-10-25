<template>
  <section :id="block.id" class="kc-product-story" :class="{ 'kc-product-story--gallery': examples.length > 1 && !appScreens, 'kc-product-story--photos': block.data.example_type === 'posts', 'kc-product-story--lodging': lodging, 'kc-product-story--screens': appScreens, 'kc-product-story--screens-pair': appScreens && examples.length > 1, 'kc-product-story--text': !examples.length }" data-parity-section="product-story">
    <div class="kc-product-story__inner">
      <div class="kc-product-story__heading">
        <p v-if="text(block.data.eyebrow)" class="kc-product-eyebrow">{{ text(block.data.eyebrow) }}</p>
        <h2>{{ text(block.data.title) }}</h2>
      </div>
      <div class="kc-product-story__copy">
        <p>{{ text(block.data.body) }}</p>
        <NuxtLink v-if="text(block.data.label) && text(block.data.url)" :to="route(text(block.data.url))" class="kc-product-link">{{ text(block.data.label) }} <span aria-hidden="true">↗</span></NuxtLink>
      </div>
      <div v-if="examples.length" class="kc-product-story__pictures">
        <figure v-for="(example, index) in examples" :key="index" :class="'kc-product-story__picture--' + (index + 1)">
          <video
            v-if="mediaPlaybackUrl(example.image)"
            :src="mediaPlaybackUrl(example.image)!"
            :poster="mediaStillUrl(example.image)!"
            :width="example.image.width ?? undefined"
            :height="example.image.height ?? undefined"
            :aria-label="example.image.alt_text || example.title"
            controls
            playsinline
            preload="none"
          />
          <img v-else :src="mediaStillUrl(example.image)!" :alt="example.image.alt_text || example.title" :width="example.image.width ?? undefined" :height="example.image.height ?? undefined" loading="lazy" decoding="async">
        </figure>
      </div>
      <div v-if="text(block.data.caption)" class="kc-product-story__caption">
        <p>{{ text(block.data.caption) }}</p>
        <ul v-if="examples.length > 1 && block.data.example_type !== 'posts'" :aria-label="appScreens ? 'App screens' : 'Featured businesses'">
          <li v-for="(example, index) in examples" :key="index">{{ example.title }}</li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockMedia, blockRecords, blockText as text, isInternalRoute } from '~/utils/tenant-page-block-data'
import { mediaStillUrl, mediaPlaybackUrl } from '~/shared/media-placement-contract'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const lodging = computed(() => props.page.path === '/lodging' || props.page.path.startsWith('/lodging/'))
const appScreens = computed(() => props.block.data.example_type === 'app_screens')
const { localePath } = useI18n()
function route(url: string) { return isInternalRoute(url) ? localePath(url) : url }
const examples = computed(() => {
  const items = blockRecords(props.block.data.items).flatMap((item, index) => {
  const image = blockMedia(props.block, `items.${index}.image`)[0]
  return image && mediaStillUrl(image) ? [{ title: text(item.title), image }] : []
  })
  return items.length ? items : blockMedia(props.block, 'media').filter(image => mediaStillUrl(image)).map(image => ({ title: text(props.block.data.title), image }))
})
</script>

<style scoped>
.kc-product-story { background: #f6f4ef; color: #171920; padding: clamp(4rem, 8.5vw, 8.5rem) 0; }
.kc-product-story__inner { width: min(86%, 86rem); margin: auto; display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: 2rem 5rem; }
.kc-product-story h2 { margin: 0; font-size: clamp(2.8rem, 5.3vw, 5.2rem); font-weight: 600; letter-spacing: -.045em; line-height: 1.02; white-space: pre-line; }
.kc-product-story__copy { align-self: end; max-width: 32rem; }
.kc-product-story__copy > p { font-size: clamp(1rem, 1.6vw, 1.55rem); line-height: 1.55; color: #606168; margin: 0; }
.kc-product-story__pictures { grid-column: 2; grid-row: 1 / 3; }
.kc-product-story__pictures figure { margin: 0; }
.kc-product-story__pictures img, .kc-product-story__pictures video { display: block; max-width: 100%; width: 100%; height: auto; max-height: 38rem; object-fit: contain; }
.kc-product-story__heading { grid-column: 1; }
.kc-product-story__copy { grid-column: 1; }
.kc-product-story__caption { grid-column: 1 / -1; border-top: 1px solid #cbc9c3; padding-top: 1.5rem; margin-top: 2rem; display: flex; gap: 2rem; justify-content: space-between; color: #606168; font-size: .95rem; }
.kc-product-story__caption p { margin: 0; white-space: pre-line; }
.kc-product-story__caption ul { margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 2rem; list-style: none; font-weight: 600; color: #24262c; }
.kc-product-story--gallery .kc-product-story__copy { grid-column: 2; }
.kc-product-story--gallery .kc-product-story__pictures { grid-column: 1 / -1; grid-row: auto; position: relative; height: clamp(23rem, 41vw, 41rem); margin-top: 2rem; }
.kc-product-story--gallery figure { position: absolute; width: 48%; filter: drop-shadow(0 1rem 1.5rem #19171424); }
.kc-product-story--gallery .kc-product-story__picture--1 { left: 0; top: 4%; transform: rotate(-3deg); }
.kc-product-story--gallery .kc-product-story__picture--2 { left: 39%; top: 24%; transform: rotate(2deg); }
.kc-product-story--gallery .kc-product-story__picture--3 { right: 0; top: 0; width: 17%; transform: rotate(4deg); }
.kc-product-story--photos .kc-product-story__picture--1 { width: 52%; transform: none; }
.kc-product-story--photos .kc-product-story__picture--2 { left: auto; right: 4%; top: 0; width: 38%; }
.kc-product-story--photos .kc-product-story__picture--3 { right: auto; left: 50%; top: 55%; width: 16%; transform: rotate(-7deg); }
:global(.kc-products-page > .tenant-page-block:nth-child(even) .kc-product-story:not(.kc-product-story--lodging)) { background: #0b0d13; color: #f8f7f3; }
:global(.kc-products-page > .tenant-page-block:nth-child(even) .kc-product-story:not(.kc-product-story--lodging) .kc-product-eyebrow), :global(.kc-products-page > .tenant-page-block:nth-child(even) .kc-product-story:not(.kc-product-story--lodging) .kc-product-link) { color: #ff7768; }
:global(.kc-products-page > .tenant-page-block:nth-child(even) .kc-product-story:not(.kc-product-story--lodging) .kc-product-story__copy > p), :global(.kc-products-page > .tenant-page-block:nth-child(even) .kc-product-story:not(.kc-product-story--lodging) .kc-product-story__caption) { color: #b3b5be; }
:global(.kc-products-page > .tenant-page-block:nth-child(even) .kc-product-story:not(.kc-product-story--lodging) .kc-product-story__pictures) { grid-column: 1; }
:global(.kc-products-page > .tenant-page-block:nth-child(even) .kc-product-story:not(.kc-product-story--lodging) .kc-product-story__heading), :global(.kc-products-page > .tenant-page-block:nth-child(even) .kc-product-story:not(.kc-product-story--lodging) .kc-product-story__copy) { grid-column: 2; }
.kc-product-story--lodging { padding: clamp(5rem, 11vw, 10rem) 0; }
.kc-product-story--lodging .kc-product-story__inner { width: min(86%, 75rem); gap: 2rem 5rem; }
.kc-product-story--lodging h2 { font-size: clamp(2.6rem, 4.6vw, 4.5rem); }
.kc-product-story--lodging .kc-product-story__copy > p { font-size: clamp(1rem, 1.5vw, 1.35rem); white-space: pre-line; }
.kc-product-story--lodging .kc-product-story__pictures img { border-radius: 1.1rem; box-shadow: 0 1.5rem 3rem #151a2514; }
.kc-product-story--lodging .kc-product-story__caption { border: 0; padding-top: 0; margin-top: 1.5rem; }
.kc-product-story--screens .kc-product-story__pictures { display: flex; justify-content: center; align-items: start; gap: 1.5rem; }
.kc-product-story--screens .kc-product-story__pictures figure { width: min(100%, 19rem); border: .5rem solid #252936; border-radius: 2rem; overflow: hidden; box-shadow: 0 1.5rem 3rem #10152526; }
.kc-product-story--screens .kc-product-story__pictures img { max-height: none; border-radius: 0; box-shadow: none; }
.kc-product-story--lodging.kc-product-story--screens-pair { background: radial-gradient(ellipse at 0% 0%, #242e50, #0c1525 75%); color: #f8f7f3; }
.kc-product-story--lodging.kc-product-story--screens-pair .kc-product-story__copy > p, .kc-product-story--lodging.kc-product-story--screens-pair .kc-product-story__caption { color: #c4c8d4; }
.kc-product-story--lodging.kc-product-story--screens-pair .kc-product-link, .kc-product-story--lodging.kc-product-story--screens-pair .kc-product-eyebrow { color: #ff7768; }
.kc-product-story--screens-pair .kc-product-story__caption ul { color: inherit; }
.kc-product-story--lodging.kc-product-story--text .kc-product-story__copy { grid-column: 2; grid-row: 1; align-self: center; }
.kc-product-story--lodging.kc-product-story--text { padding: clamp(4rem, 7vw, 7rem) 0; }
@media (max-width: 767px) {
  .kc-product-story__inner { display: flex; flex-direction: column; align-items: stretch; gap: 2rem; }
  .kc-product-story__copy { align-self: auto; }
  .kc-product-story__pictures { order: 2; }
  .kc-product-story__pictures img, .kc-product-story__pictures video { max-height: 28rem; }
  .kc-product-story__caption { order: 3; flex-direction: column; gap: 1rem; }
  .kc-product-story__caption ul { gap: 1rem; font-size: .8rem; }
  .kc-product-story--gallery .kc-product-story__pictures { height: 21rem; margin-top: 0; }
  .kc-product-story--gallery figure { width: 66%; }
  .kc-product-story--gallery .kc-product-story__picture--2 { left: 24%; top: 42%; }
  .kc-product-story--gallery .kc-product-story__picture--3 { width: 25%; }
  .kc-product-story--photos .kc-product-story__picture--1 { width: 68%; }
  .kc-product-story--photos .kc-product-story__picture--2 { right: 0; top: 40%; width: 42%; }
  .kc-product-story--photos .kc-product-story__picture--3 { left: 38%; top: 55%; width: 20%; }
  .kc-product-story--lodging { padding: 4.5rem 0; }
  .kc-product-story--lodging .kc-product-story__inner { width: calc(100% - 3rem); gap: 2rem; }
  .kc-product-story--screens .kc-product-story__pictures { flex-direction: column; align-items: center; }
  .kc-product-story--screens .kc-product-story__pictures figure { width: min(100%, 18rem); }
}
</style>
