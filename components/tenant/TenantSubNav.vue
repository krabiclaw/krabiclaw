<template>
  <div class="border-b border-default bg-default">
    <div class="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
      <div class="flex h-14 items-center gap-2 overflow-x-auto scrollbar-none">
        <NuxtLink
          v-for="item in items"
          :key="item.key"
          :to="localePath(item.href)"
          :aria-current="active === item.key ? 'page' : undefined"
          :class="[
            'shrink-0 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-[0.2em] transition-all',
            active === item.key
              ? 'bg-inverted text-inverted'
              : 'text-muted hover:bg-muted hover:text-default'
          ]"
        >
          {{ item.label }}
        </NuxtLink>
      </div>

      <!-- Fade indicators for mobile scroll -->
      <div class="pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-r from-default to-transparent lg:hidden" />
      <div class="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-default to-transparent lg:hidden" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PublicLocationSection } from '~/utils/public-resource-contracts'

const props = defineProps<{
  locationSlug: string
  active: 'overview' | 'menu' | 'products' | 'experiences' | 'posts' | 'reviews' | 'photos' | 'qa' | 'contact'
}>()

const { location } = await usePublicPageData({ lazy: false })
const { localePath, t } = useI18n()

const SECTION_TABS: Array<{ key: PublicLocationSection, label: string }> = [
  { key: 'menu', label: 'site.subnav.menu' },
  { key: 'products', label: 'site.footer.products' },
  { key: 'experiences', label: 'site.footer.experiences' },
  { key: 'posts', label: 'site.subnav.posts' },
  { key: 'reviews', label: 'site.subnav.reviews' },
  { key: 'photos', label: 'site.subnav.photos' },
  { key: 'qa', label: 'site.subnav.qa' },
]

const items = computed(() => [
  { key: 'overview', label: t('site.subnav.overview'), href: `/locations/${props.locationSlug}` },
  ...SECTION_TABS.filter(tab => location.value?.sections[tab.key] === true)
    .map(tab => ({ key: tab.key, label: t(tab.label), href: `/locations/${props.locationSlug}/${tab.key}` })),
  { key: 'contact', label: t('site.subnav.visit'), href: `/locations/${props.locationSlug}/contact` },
])
</script>
