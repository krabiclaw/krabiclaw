<template>
  <span v-if="shown.length" class="inline-flex min-w-0 max-w-full" data-site-logo>
    <span v-for="entry in shown" :key="entry.logo.slot" :class="[frameClass(entry.logo), entry.modeClass]" :data-logo-slot="entry.logo.slot" :data-logo-shape="entry.logo.presentation.shape">
      <img
        :src="source(entry.logo)"
        :alt="alt"
        :class="imageClass(entry.logo)"
        :style="entry.logo.presentation.shape === 'original' ? undefined : { objectPosition: `${entry.logo.presentation.focus.x * 100}% ${entry.logo.presentation.focus.y * 100}%` }"
        :loading="loading"
        decoding="async"
      >
    </span>
  </span>
  <slot v-else />
</template>

<script setup lang="ts">
import type { SiteLogo } from '~/shared/media-placement-contract'
import { cfImageVariant } from '~/utils/cf-image'

// The site's logo as its owner presents it: whole (`original`), or cropped to
// a square or circle around a focal point. With a dark-ground logo, each shows
// only in its own mode. One component for every template's header and footer;
// the default slot is what shows when the site has no logo.
const props = withDefaults(defineProps<{
  alt: string
  size: 'sm' | 'md' | 'lg'
  loading: 'eager' | 'lazy'
  forceDark?: boolean
}>(), {
  forceDark: false,
})
const { logos } = useTenantOrganization().organization
const logo = logos.find(item => item.slot === 'logo') ?? null
const dark = logos.find(item => item.slot === 'logo_dark') ?? null
const shown = computed(() => {
  if (props.forceDark) {
    if (dark) return [{ logo: dark, modeClass: 'inline-flex' }]
    if (logo) return [{ logo, modeClass: 'inline-flex' }]
    return []
  }
  if (logo && dark) {
    return [{ logo, modeClass: 'inline-flex dark:hidden' }, { logo: dark, modeClass: 'hidden dark:inline-flex' }]
  }
  if (logo) return [{ logo, modeClass: 'inline-flex' }]
  if (dark) return [{ logo: dark, modeClass: 'inline-flex' }]
  return []
})

const HEIGHT = { sm: 'h-10', md: 'h-14', lg: 'h-16' } as const
const BOX = { sm: 'size-10', md: 'size-14', lg: 'size-16' } as const
const MAX_WIDTH = { sm: 'max-w-40', md: 'max-w-56', lg: 'max-w-40 sm:max-w-56' } as const
const PIXELS = { sm: 80, md: 112, lg: 128 } as const

// The display comes only from the mode class; a second display utility here
// would beat `hidden` and show both logos.
function frameClass(entry: SiteLogo) {
  if (entry.presentation.shape === 'original') return 'min-w-0'
  return ['overflow-hidden', BOX[props.size], entry.presentation.shape === 'circle' ? 'rounded-full' : 'rounded-md']
}
function imageClass(entry: SiteLogo) {
  return entry.presentation.shape === 'original'
    ? [HEIGHT[props.size], 'min-w-0 w-auto object-contain', MAX_WIDTH[props.size]]
    : 'size-full object-cover'
}
// Twice the rendered height, for sharp edges on dense screens.
function source(entry: SiteLogo) {
  return cfImageVariant(entry.url, { height: PIXELS[props.size], fit: 'scale-down' }) ?? entry.url
}
</script>
