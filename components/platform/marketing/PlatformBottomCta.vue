<template>
  <section v-if="page.path === '/plugin'" class="kc-mcp-cta" data-parity-section="cta">
    <div><h2>{{ title }}</h2><p v-if="description">{{ description }}</p></div>
    <div class="kc-mcp-cta__actions">
      <PlatformAccountCta v-if="label && url" :label="label" :to="url" size="xl" class="kc-mcp-cta__start" />
      <NuxtLink v-if="secondaryLabel && secondaryUrl" :to="secondaryUrl">{{ secondaryLabel }} <span aria-hidden="true">↗</span></NuxtLink>
    </div>
  </section>
  <PlatformCoastalScene v-else-if="page.recipe === 'products'" :block="block" :page="page" closing />
  <section v-else-if="page.path === '/pricing'" class="kc-pricing-cta" data-parity-section="cta">
    <img v-if="mediaStillUrl(media)" :src="mediaStillUrl(media)!" :alt="media?.alt_text ?? ''" loading="lazy" decoding="async">
    <div><h2>{{ title }}</h2><p v-if="description">{{ description }}</p><PlatformAccountCta v-if="label" :label="label" :to="url || '/signup'" size="lg" /></div>
  </section>
  <div v-else
    class="rounded-3xl border border-default bg-elevated text-center shadow-sm"
    :class="size === 'lg' ? 'p-10 sm:p-16 max-w-4xl mx-auto flex flex-col items-center gap-6' : 'p-8 sm:p-12 space-y-6'"
    data-parity-section="cta"
  >
    <h2 class="font-extrabold text-default m-0" :class="size === 'lg' ? 'text-3xl sm:text-4xl' : 'text-3xl'">{{ title }}</h2>
    <p v-if="description" class="text-muted m-0" :class="size === 'lg' ? 'text-base sm:text-lg max-w-xl leading-relaxed' : 'text-base max-w-lg mx-auto'">{{ description }}</p>
    <div class="flex gap-4" :class="size === 'lg' ? 'flex-wrap' : 'justify-center'">
      <PlatformAccountCta v-if="label" :label="label" :to="url || '/signup'" size="lg" :class="size === 'lg' ? 'shadow-sm' : ''" />
      <PlatformButton v-if="secondaryLabel && secondaryUrl" :to="secondaryUrl" variant="outline" size="lg">{{ secondaryLabel }}</PlatformButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import PlatformCoastalScene from '~/components/platform/marketing/PlatformCoastalScene.vue'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockMedia } from '~/utils/tenant-page-block-data'
import { mediaStillUrl } from '~/shared/media-placement-contract'
/**
 * The closing call to action: a title, a line, the account button and an
 * outline button. The vertical pages draw it large; About draws it at the
 * size of its other cards.
 */
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

const media = computed(() => blockMedia(props.block, 'media')[0] ?? null)
const title = computed(() => blockText(props.block.data.title))
const description = computed(() => blockTextOrNull(props.block.data.description))
const label = computed(() => blockTextOrNull(props.block.data.label))
const url = computed(() => blockTextOrNull(props.block.data.url))
const secondaryLabel = computed(() => blockTextOrNull(props.block.data.secondary_label))
const secondaryUrl = computed(() => blockTextOrNull(props.block.data.secondary_url))
/**
 * A page whose whole job is to sell one vertical closes large; a prompt inside
 * a page that is about something else reads at the size of its other cards.
 */
const LARGE_PAGES = new Set(['/', '/restaurants', '/experiences', '/legal'])
const size = computed<'md' | 'lg'>(() => (LARGE_PAGES.has(props.page.path) ? 'lg' : 'md'))
</script>

<style scoped>
.kc-pricing-cta { position: relative; min-height: 30rem; background: #171b31; color: white; display: grid; place-items: center; text-align: center; overflow: hidden; padding: 4rem 1.5rem; }
.kc-pricing-cta > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.kc-pricing-cta::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, rgb(14 18 36 / 70%), rgb(14 18 36 / 45%)); }
.kc-pricing-cta > div { position: relative; z-index: 1; max-width: 35rem; }
.kc-pricing-cta h2 { font-size: clamp(2.5rem, 5vw, 4rem); font-weight: 400; letter-spacing: -.04em; line-height: 1.1; }
.kc-pricing-cta p { margin-bottom: 2rem; }
</style>

<style scoped>
.kc-mcp-cta { display: grid; grid-template-columns: 1.3fr 1fr; align-items: center; gap: 5rem; padding: clamp(4rem, 7.5vw, 7.5rem) max(7%, calc((100% - 86rem) / 2)); background: #eeb5a2; color: #171b31; }
.kc-mcp-cta h2 { margin: 0; max-width: 17ch; font-size: clamp(2.7rem, 5vw, 5rem); font-weight: 400; letter-spacing: -.045em; line-height: 1.04; white-space: pre-line; text-wrap: balance; }
.kc-mcp-cta p { max-width: 35rem; margin: 1.5rem 0 0; color: #5c4541; font-size: clamp(1.05rem, 1.5vw, 1.4rem); line-height: 1.6; }
.kc-mcp-cta__actions { display: flex; flex-direction: column; align-items: center; justify-self: end; gap: 1.5rem; }
.kc-mcp-cta :deep(.kc-mcp-cta__start) { background: #171b31; color: #fff; border-radius: 999px; padding: 1rem 2rem; }
.kc-mcp-cta__actions > a { color: #171b31; font-size: .95rem; text-decoration: none; }
.kc-mcp-cta__actions > a:hover { text-decoration: underline; }
@media (max-width: 767px) {
  .kc-mcp-cta { grid-template-columns: 1fr; gap: 2rem; }
  .kc-mcp-cta__actions { align-items: start; justify-self: start; }
}
</style>
