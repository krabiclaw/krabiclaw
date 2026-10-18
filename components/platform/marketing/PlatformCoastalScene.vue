<template>
  <section class="kc-product-scene" :class="{ 'kc-product-scene--closing': closing }" :data-parity-section="closing ? 'cta' : 'hero'">
    <img v-if="imageUrl" :src="imageUrl" alt="" class="kc-product-scene__art" :loading="closing ? 'lazy' : 'eager'" :fetchpriority="closing ? 'auto' : 'high'" decoding="async">
    <div class="kc-product-scene__copy">
      <component :is="closing ? 'h2' : 'h1'">{{ text(block.data.title) }}</component>
      <p>{{ text(closing ? block.data.description : block.data.subtitle) }}</p>
      <div class="kc-product-scene__actions">
        <PlatformAccountCta v-if="label && url" :label="label" :to="url" size="xl" />
        <PlatformButton v-if="closing && secondaryLabel && secondaryUrl" :to="secondaryUrl" variant="outline" size="xl">{{ secondaryLabel }}</PlatformButton>
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
.kc-product-scene--closing .kc-product-scene__art { object-position: 50% bottom; }
.kc-product-scene--closing { min-height: clamp(25rem, 40vw, 40rem); }
.kc-product-scene--closing .kc-product-scene__copy { padding-top: clamp(5rem, 8vw, 8rem); }
@media (max-width: 767px) { .kc-product-scene__art { object-position: 58% bottom; } .kc-product-scene--closing .kc-product-scene__art { object-position: 92% bottom; } .kc-product-scene { min-height: 37rem; }
.kc-product-scene--closing { min-height: 30rem; } }
</style>
