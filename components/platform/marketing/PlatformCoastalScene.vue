<template>
  <section class="kc-product-scene" :class="{ 'kc-product-scene--closing': closing, 'kc-product-scene--featured': featured && !closing, 'kc-product-scene--compact': block.data.layout === 'compact' }" :data-parity-section="closing ? 'cta' : 'hero'">
    <img v-if="imageUrl" :src="imageUrl" alt="" class="kc-product-scene__art" :loading="closing ? 'lazy' : 'eager'" :fetchpriority="closing ? 'auto' : 'high'" decoding="async">
    <div class="kc-product-scene__content">
    <div class="kc-product-scene__copy">
      <p v-if="!closing && text(block.data.eyebrow)" class="kc-product-scene__eyebrow">{{ text(block.data.eyebrow) }}</p>
      <component :is="closing ? 'h2' : 'h1'">{{ text(block.data.title) }}</component>
      <p>{{ text(closing ? block.data.description : block.data.subtitle) }}</p>
      <div class="kc-product-scene__actions">
        <PlatformAccountCta v-if="label && url" :label="label" :to="url" size="xl" class="kc-product-scene__primary" />
        <PlatformButton v-if="secondaryLabel && secondaryUrl" :to="secondaryUrl" variant="ghost" size="xl" class="kc-product-scene__secondary">{{ secondaryLabel }}</PlatformButton>
      </div>
    </div>
    <figure v-if="featured && !closing" class="kc-product-scene__featured">
      <img :src="mediaStillUrl(featured)!" :alt="featured.alt_text || ''" :width="featured.width ?? undefined" :height="featured.height ?? undefined" class="kc-product-capture" :class="['kc-product-capture--' + text(block.data.image_ratio), 'kc-product-capture--' + text(block.data.image_position)]" fetchpriority="high" decoding="async">
      <figcaption v-if="text(block.data.caption)">{{ text(block.data.caption) }}</figcaption>
    </figure>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockMedia, blockText as text } from '~/utils/tenant-page-block-data'
import { mediaStillUrl } from '~/shared/media-placement-contract'
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage; closing?: boolean; defaultArt?: string }>()
const image = computed(() => blockMedia(props.block, 'media')[0])
const featured = computed(() => blockMedia(props.block, 'featured').find(media => mediaStillUrl(media)))
const imageUrl = computed(() => image.value ? mediaStillUrl(image.value) : props.defaultArt)
const label = computed(() => text(props.closing ? props.block.data.label : props.block.data.cta_label))
const url = computed(() => text(props.closing ? props.block.data.url : props.block.data.cta_url))
const secondaryLabel = computed(() => text(props.block.data.secondary_label))
const secondaryUrl = computed(() => text(props.block.data.secondary_url))
</script>

<style scoped>
.kc-product-scene { position: relative; min-height: clamp(36rem, 55vw, 54rem); overflow: hidden; isolation: isolate; background: #0e1931; color: #f8f7f3; text-align: center; }
.kc-product-scene__art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center bottom; z-index: -2; }
.kc-product-scene::before { content: ''; position: absolute; inset: 0; background: linear-gradient(#07122988, #0b163030 36%, transparent 65%, #090b10); z-index: -1; }
.kc-product-scene__copy { padding: clamp(4rem, 7vw, 7rem) 1.5rem; }
.kc-product-scene h1, .kc-product-scene h2 { max-width: 64rem; margin: auto; font-size: clamp(2.9rem, 5.5vw, 5.5rem); font-weight: 600; letter-spacing: -.045em; line-height: 1.02; white-space: pre-line; text-wrap: balance; }
.kc-product-scene p { color: #e4e4ec; font-size: clamp(1.05rem, 1.6vw, 1.55rem); line-height: 1.45; margin: 1.8rem auto; max-width: 40rem; white-space: pre-line; }
.kc-product-scene__actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 1rem; }
.kc-product-scene__secondary { border-radius: 0; border-bottom: 1px solid currentColor; padding: .4rem 0; }
.kc-product-scene .kc-product-scene__eyebrow { margin: 0 0 1.5rem; font-size: .8rem; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
.kc-product-scene--featured { min-height: 0; text-align: left; }
.kc-product-scene--featured .kc-product-scene__content { width: min(calc(100% - 3rem), 75rem); margin: auto; padding: clamp(3rem, 5vw, 5rem) 0; display: grid; grid-template-columns: 1fr 1fr; gap: clamp(2rem, 5vw, 5rem); align-items: center; }
.kc-product-scene--featured .kc-product-scene__copy { padding: 0; }
.kc-product-scene--featured h1 { font-size: clamp(2.6rem, 4.3vw, 4.5rem); }
.kc-product-scene--featured .kc-product-scene__copy > p:not(.kc-product-scene__eyebrow) { margin: 1.5rem 0; max-width: 31rem; font-size: clamp(1.05rem, 1.5vw, 1.4rem); }
.kc-product-scene--featured .kc-product-scene__actions { justify-content: flex-start; }
.kc-product-scene__featured { min-width: 0; width: min(100%, 29rem); justify-self: end; margin: 0; }
.kc-product-scene__featured img { display: block; width: 100%; border-radius: 1.4rem; box-shadow: 0 1rem 3rem #0004; }
.kc-product-scene__featured figcaption { margin-top: 1rem; text-align: right; font-size: .8rem; color: #d6d8e2; }
.kc-product-scene--compact { min-height: 0; text-align: left; }
.kc-product-scene--compact .kc-product-scene__copy { width: min(calc(100% - 3rem), 75rem); padding: 3rem 0; margin: auto; }
.kc-product-scene--compact h2 { margin: 0; font-size: clamp(2rem, 3.5vw, 3.5rem); }
.kc-product-scene--compact p { margin: 1rem 0 1.5rem; font-size: 1.15rem; }
.kc-product-scene--compact .kc-product-scene__actions { justify-content: flex-start; }
.kc-product-scene--closing .kc-product-scene__art { object-position: 50% bottom; }
.kc-product-scene--closing { min-height: clamp(25rem, 40vw, 40rem); }
.kc-product-scene--closing .kc-product-scene__copy { padding-top: clamp(5rem, 8vw, 8rem); }
.kc-product-scene--closing.kc-product-scene--compact { min-height: 0; }
.kc-product-scene--closing.kc-product-scene--compact .kc-product-scene__copy { padding: 3rem 0; }
@media (max-width: 900px) {
  .kc-product-scene--featured .kc-product-scene__content { grid-template-columns: 1fr; gap: 2.5rem; }
  .kc-product-scene__featured { width: min(100%, 31rem); justify-self: center; }
  .kc-product-scene--featured h1 { max-width: 15ch; margin: 0; font-size: clamp(2.8rem, 7vw, 4rem); }
  .kc-product-scene--featured .kc-product-scene__copy > p:not(.kc-product-scene__eyebrow) { max-width: 36rem; }
}
@media (max-width: 767px) {
  .kc-product-scene__art { object-position: 58% bottom; }
  .kc-product-scene--closing .kc-product-scene__art { object-position: 92% bottom; }
  .kc-product-scene:not(.kc-product-scene--featured):not(.kc-product-scene--compact) { min-height: 30rem; }
}
</style>
