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
import { isExperience } from '~/utils/product-presentation'

const props = defineProps<{
  locationSlug: string
  active: 'overview' | 'menu' | 'products' | 'experiences' | 'posts' | 'reviews' | 'photos' | 'qa' | 'contact'
}>()

const { products, location } = await usePublicPageData({ lazy: false })
const { localePath, t } = useI18n()


const items = computed(() => {
  const list = [
    { key: 'overview', label: t('saya.subnav.overview'), href: `/locations/${props.locationSlug}` }
  ]
  // Two surfaces, each shown only when this branch has something on it: what
  // the branch sells over the counter, and what a guest can book a seat on.
  const here = location.value
    ? products.value.filter(product => product.locations.some(entry => entry.location_id === location.value?.id && entry.published))
    : []
  if (here.some(product => product.kind === 'dish')) {
    list.push({ key: 'menu', label: t('saya.subnav.menu'), href: `/locations/${props.locationSlug}/menu` })
  }
  if (here.some(product => product.kind === 'item' || product.kind === 'service' || product.kind === 'stay')) {
    list.push({ key: 'products', label: t('saya.footer.products'), href: `/locations/${props.locationSlug}/products` })
  }
  if (here.some(isExperience)) {
    list.push({
      key: 'experiences',
      label: t('saya.footer.experiences'),
      href: `/locations/${props.locationSlug}/experiences`,
    })
  }
  list.push(
    { key: 'posts',    label: t('saya.subnav.posts'),   href: `/locations/${props.locationSlug}/posts` },
    { key: 'reviews',  label: t('saya.subnav.reviews'), href: `/locations/${props.locationSlug}/reviews` },
    { key: 'photos',   label: t('saya.subnav.photos'),  href: `/locations/${props.locationSlug}/photos` },
    { key: 'qa',       label: t('saya.subnav.qa'),      href: `/locations/${props.locationSlug}/qa` },
    { key: 'contact',  label: t('saya.subnav.visit'),   href: `/locations/${props.locationSlug}/contact` }
  )
  return list
})
</script>
