<template>
  <section class="kc-product-scene" :class="{ 'kc-product-scene--closing': closing, 'kc-product-scene--screenshots': screenshots.length && !closing, 'kc-product-scene--lodging': page.path === '/lodging' || page.path.startsWith('/lodging/') }" :data-parity-section="closing ? 'cta' : 'hero'">
    <img v-if="imageUrl" :src="imageUrl" alt="" class="kc-product-scene__art" :loading="closing ? 'lazy' : 'eager'" :fetchpriority="closing ? 'auto' : 'high'" decoding="async">
    <div class="kc-product-scene__content">
    <div class="kc-product-scene__copy">
      <p v-if="!closing && text(block.data.eyebrow)" class="kc-product-scene__eyebrow">{{ text(block.data.eyebrow) }}</p>
      <component :is="closing ? 'h2' : 'h1'">{{ text(block.data.title) }}</component>
      <p>{{ text(closing ? block.data.description : block.data.subtitle) }}</p>
      <div class="kc-product-scene__actions">
        <PlatformAccountCta v-if="label && url" :label="label" :to="url" size="xl" class="kc-product-scene__primary" />
        <PlatformButton v-if="secondaryLabel && secondaryUrl" :to="secondaryUrl" variant="outline" size="xl" class="kc-product-scene__secondary">{{ secondaryLabel }}</PlatformButton>
      </div>
    </div>
    <div v-if="screenshots.length && !closing" class="kc-product-scene__screenshots">
      <figure v-for="(screenshot, index) in screenshots" :key="screenshot.asset_id" :class="{ 'kc-product-scene__screenshot--portrait': screenshot.height && screenshot.width && screenshot.height > screenshot.width }">
        <img :src="mediaStillUrl(screenshot)!" :alt="screenshot.alt_text || ''" :width="screenshot.width ?? undefined" :height="screenshot.height ?? undefined" :fetchpriority="index === 0 ? 'high' : 'auto'" decoding="async">
      </figure>
      <p v-if="screenshotCaption" class="kc-product-scene__caption">{{ screenshotCaption }}</p>
    </div>
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
const proofStories = computed(() => props.page.path === '/lodging' ? props.page.blocks.filter(block => block.type === 'media_text' && blockMedia(block, 'media').some(media => mediaStillUrl(media))) : [])
const screenshots = computed(() => proofStories.value.flatMap(block => blockMedia(block, 'media')).filter(media => mediaStillUrl(media)).slice(0, 2))
const screenshotCaption = computed(() => text(proofStories.value[0]?.data.caption))
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
.kc-product-scene .kc-product-scene__eyebrow { margin: 0 0 1.5rem; font-size: .8rem; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
.kc-product-scene--screenshots { min-height: 48rem; text-align: left; }
.kc-product-scene--screenshots .kc-product-scene__content { width: min(86%, 78rem); margin: auto; padding: clamp(5rem, 8vw, 8rem) 0; display: grid; grid-template-columns: .9fr 1.1fr; gap: 3rem; align-items: center; }
.kc-product-scene--screenshots .kc-product-scene__copy { padding: 0; }
.kc-product-scene--screenshots h1 { font-size: clamp(3rem, 5.2vw, 5rem); }
.kc-product-scene--screenshots .kc-product-scene__copy > p:not(.kc-product-scene__eyebrow) { margin: 2rem 0; max-width: 31rem; font-size: clamp(1.05rem, 1.5vw, 1.35rem); }
.kc-product-scene--screenshots .kc-product-scene__actions { justify-content: flex-start; }
.kc-product-scene--lodging .kc-product-scene__primary { background: #ff7768; border-color: #ff7768; color: #171920; border-radius: 999px; }
.kc-product-scene--lodging .kc-product-scene__secondary { background: transparent; border-color: #f8f7f380; color: #f8f7f3; border-radius: 999px; }
.kc-product-scene__screenshots { position: relative; min-width: 0; height: 37rem; margin-bottom: 3rem; }
.kc-product-scene__screenshots figure { position: absolute; width: 78%; right: 0; bottom: 2.5rem; margin: 0; border: 1px solid #ffffff30; border-radius: 1.1rem; overflow: hidden; box-shadow: 0 1.5rem 4rem #0006; }
.kc-product-scene__screenshots figure:first-child { width: 90%; top: 0; bottom: auto; right: 0; }
.kc-product-scene__screenshots figure.kc-product-scene__screenshot--portrait { width: 46%; max-width: 17rem; right: auto; left: 0; border: .45rem solid #252936; border-radius: 2rem; }
.kc-product-scene__screenshots img { display: block; width: 100%; height: auto; }
.kc-product-scene .kc-product-scene__caption { position: absolute; top: 100%; right: 0; margin: 1rem 0 0; font-size: .8rem; color: #e4e4ec; }
.kc-product-scene--closing .kc-product-scene__art { object-position: 50% bottom; }
.kc-product-scene--closing { min-height: clamp(25rem, 40vw, 40rem); }
.kc-product-scene--closing .kc-product-scene__copy { padding-top: clamp(5rem, 8vw, 8rem); }
@media (max-width: 767px) { .kc-product-scene__art { object-position: 58% bottom; } .kc-product-scene--closing .kc-product-scene__art { object-position: 92% bottom; } .kc-product-scene { min-height: 37rem; }
.kc-product-scene--screenshots .kc-product-scene__content { width: calc(100% - 3rem); grid-template-columns: 1fr; gap: 3.5rem; padding: 4rem 0 3rem; }
.kc-product-scene--screenshots h1 { font-size: clamp(2.8rem, 10vw, 4.5rem); }
.kc-product-scene__screenshots { height: clamp(24rem, 65vw, 35rem); }
.kc-product-scene__screenshots figure.kc-product-scene__screenshot--portrait { max-width: 13rem; }
.kc-product-scene--closing { min-height: 30rem; } }
</style>
