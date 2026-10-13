<template>
  <AppSection v-if="items.length" padding="xl">
    <div class="mb-16 max-w-2xl">
      <p class="saya-kicker mb-6">{{ kicker }}</p>
      <h2 class="saya-display-md text-default">{{ heading }}</h2>
    </div>
    <div :class="['grid gap-8', items.length > 1 ? 'md:grid-cols-2' : '']">
      <NuxtLink
        v-for="(item, index) in items"
        :key="item.id"
        :ref="(el: Element | { $el?: Element } | null) => { const node = el && ('$el' in el ? el.$el : el); locCardRefs[index] = (node as HTMLElement) ?? null }"
        :to="localePath(item.url)"
        class="group block overflow-hidden border border-default text-default no-underline transition hover:border-muted"
      >
        <div class="aspect-video overflow-hidden bg-muted">
          <!-- Poster image always ships in the SSR HTML; the video swaps in when the card scrolls into view. -->
          <template v-if="item.media?.kind === 'video' && item.media.public_url && visibleLocCards.has(index)">
            <ClientOnly>
              <video
                :src="item.media.public_url ?? undefined"
                :poster="item.media.thumbnail_url || undefined"
                autoplay muted loop playsinline preload="none"
                class="aspect-video w-full object-contain"
              />
            </ClientOnly>
          </template>
          <UImage
            v-else-if="mediaStillUrl(item.media)"
            :src="mediaStillUrl(item.media) || undefined"
            :alt="item.media?.alt_text || item.title"
            loading="lazy"
            class="aspect-video w-full object-contain transition-transform duration-500 group-hover:scale-105"
          />
          <div v-else class="flex h-full w-full items-center justify-center" aria-hidden="true">
            <svg viewBox="0 0 24 24" class="size-10 text-muted" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><g><path d="M15 10.5a3 3 0 1 1-6 0a3 3 0 0 1 6 0"/><path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0"/></g></svg>
          </div>
        </div>
        <div class="p-8 pb-9">
          <div v-if="item.city" class="saya-eyebrow mb-5 flex items-center gap-2 text-muted">
            <span class="size-1.5 rounded-full bg-accented" />
            {{ item.city }}
          </div>
          <div class="saya-display saya-italic text-4xl text-default leading-none">{{ item.title }}</div>
          <div class="mt-6 border-t border-default pt-5">
            <span class="saya-eyebrow text-muted">{{ visitLocationCta }}</span>
          </div>
        </div>
      </NuxtLink>
    </div>
  </AppSection>
</template>

<script setup lang="ts">
import AppSection from '~/components/ui/AppSection.vue'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords } from '~/utils/tenant-page-block-data'
import { mediaStillUrl } from '~/shared/media-placement-contract'

// Saya's locations grid. The block names the locations and the loader resolves
// each one's title, town, route and picture, so the card shows what the block
// selected rather than every location the site happens to have.
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath, locale, t } = useI18n()
const { organization } = useTenantOrganization()

const homeCopy = computed(() => getVerticalCopy(organization.vertical, locale.value))
const items = computed(() => blockRecords(props.block.data.items).map((item) => {
  const media = blockRecords(item.media)[0] ?? null
  return {
    id: blockText(item.id),
    title: blockText(item.title),
    city: blockText(item.city),
    url: blockText(item.url),
    media: media
      ? {
          public_url: blockText(media.public_url) || null,
          thumbnail_url: blockText(media.thumbnail_url) || null,
          kind: blockText(media.kind) || null,
          alt_text: blockText(media.alt_text) || null,
        }
      : null,
  }
}).filter(item => item.id && item.title && item.url))

// The block's own title wins; the vertical's phrasing is the fallback, because
// it counts the locations ("Two places to find us").
const heading = computed(() => blockText(props.block.data.title) || homeCopy.value.locationGroupLine(items.value.length) || t('saya.home.locations_heading'))
const kicker = computed(() => blockText(props.block.data.description) || homeCopy.value.findUsKicker)
const visitLocationCta = computed(() => homeCopy.value.visitLocationCta)

// Location card videos load when they scroll into view; the poster is in the
// SSR HTML from the first byte.
const locCardRefs: (HTMLElement | null)[] = []
const visibleLocCards = ref(new Set<number>())
onMounted(() => {
  if (!('IntersectionObserver' in window)) return
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const index = locCardRefs.indexOf(entry.target as HTMLElement)
      if (index >= 0) {
        visibleLocCards.value = new Set([...visibleLocCards.value, index])
        observer.unobserve(entry.target)
      }
    }
  }, { rootMargin: '200px' })
  // Keyed on the items themselves: a reorder or a same-length replacement
  // renders different cards, and watching the count alone left those cards
  // unobserved, so their videos never started.
  watch(() => items.value.map(item => item.id).join('|'), () => {
    // The set is keyed by index, so a different list of cards must not inherit
    // the old one's visibility.
    visibleLocCards.value = new Set()
    observer.disconnect()
    nextTick(() => locCardRefs.forEach(el => el && observer.observe(el)))
  }, { immediate: true })
  onUnmounted(() => observer.disconnect())
})
</script>
