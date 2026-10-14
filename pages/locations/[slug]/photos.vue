<template>
  <div class="min-h-screen bg-default text-default">


    <template v-if="location">
      <!-- Sub-nav (Level 2) -->
      <SayaSubNav 
        :location-slug="slug" 
        active="photos" 
      />

      <!-- Compact Page header -->
      <header class="mx-auto max-w-7xl px-4 pt-12 pb-10 sm:px-6 lg:px-8 text-center">
        <NuxtLink :to="localePath(`/locations/${slug}`)" class="saya-kicker mb-8 inline-block text-muted no-underline hover:text-default">
          ← {{ t('saya.location.back_to', { title: location?.title }) }}
        </NuxtLink>
        
        <div class="flex flex-col gap-2">
          <h1 class="saya-display-md text-default">{{ t('saya.photos.title') }}</h1>
          <p class="text-sm text-muted">
            {{ location?.title }}
          </p>
        </div>
      </header>


    <!-- Category filter tabs -->
    <SayaFilterTabs
      v-model="activeCategory"
      :tabs="cats"
    />

      <!-- Gallery -->
      <div class="mx-auto max-w-7xl px-4 pt-12 pb-24 sm:px-6 lg:px-8">
        <!-- Empty -->
        <div v-if="sorted.length === 0" class="py-24 text-center">
          <div class="saya-display saya-italic text-3xl text-default">{{ t('saya.photos.empty_title') }}</div>
          <p class="mt-2 text-sm text-muted">{{ t('saya.photos.empty_desc') }}</p>
        </div>

        <!-- Masonry -->
        <div v-else class="saya-masonry">
          <button
            v-for="(photo, i) in sorted"
            :key="photo.id"
            class="group relative block w-full overflow-hidden rounded-2xl bg-black"
            @click="openLightbox(i)"
          >
            <UImage
              :src="photo.public_url"
              :alt="typeof photo.alt_text === 'string' ? photo.alt_text : ''"
              loading="lazy"
              class="block w-full transition-opacity duration-200 group-hover:opacity-80"
            />
            <!-- If the sticky tab/header div is needed, move it here, outside the <img> -->
            <!-- <div class="sticky top-0 z-40 border-b border-default bg-default"> ... </div> -->
            <div class="absolute inset-0 flex items-end bg-linear-to-t from-black/60 to-transparent p-6 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
              <span class="saya-eyebrow rounded-full bg-white/25 px-4 py-1.5 text-[10px] font-bold tracking-widest text-white backdrop-blur-md border border-white/20">
                {{ categoryLabel(photo.category) }}
              </span>
            </div>
          </button>
        </div>
      </div>

    <!-- Lightbox -->
    <MediaLightbox v-model:open="lightboxOpen" v-model:index="lightboxIdx" :items="lightboxItems" :title="location?.title" />
    </template>
  </div>
</template>

<script setup lang="ts">
const { localePath, t } = useI18n()
definePageMeta({ layout: 'saya' })

const route = useRoute()
const { organization } = useTenantOrganization()
const slug = computed(() => String(route.params.slug))
const organizationName = computed(() => String((organization as ApiValue)?.name ?? '').trim())

const { location, media: photos } = await usePublicPageData({ lazy: false })
// A slug naming no location is a URL that does not exist. Rendering the page
// around a null location answered 200 with an empty shell — a soft 404 a
// crawler indexes. The sibling menu and product indexes already refuse it.
if (!location.value) throw createError({ statusCode: 404, statusMessage: 'Location not found' })


const photoCategoryKeys: Record<string, string> = {
  FOOD: 'saya.photos.category_food',
  INTERIOR: 'saya.photos.category_interior',
  EXTERIOR: 'saya.photos.category_exterior',
  MENU: 'saya.photos.category_menu',
  TEAM: 'saya.photos.category_team',
  OTHER: 'saya.photos.category_other',
}
const cats = computed(() => [
  { key: 'ALL', label: t('saya.photos.category_all') },
  { key: 'FOOD', label: t('saya.photos.category_food') },
  { key: 'INTERIOR', label: t('saya.photos.category_interior') },
  { key: 'EXTERIOR', label: t('saya.photos.category_exterior') },
  { key: 'MENU', label: t('saya.photos.category_menu') },
  { key: 'TEAM', label: t('saya.photos.category_team') }
])
const activeCategory = ref('ALL')

function categoryLabel(category: unknown): string {
  if (typeof category !== 'string') return t('saya.photos.category_other')
  const key = photoCategoryKeys[category]
  return typeof key === 'string' ? t(key) : t('saya.photos.category_other')
}

const sorted = computed(() => {
  const filtered = activeCategory.value === 'ALL'
    ? photos.value
    : activeCategory.value === 'FOOD'
      ? photos.value.filter((p: ApiValue) => p.category === 'FOOD' || p.category === 'MENU')
      : photos.value.filter((p: ApiValue) => p.category === activeCategory.value)
  return [...filtered].sort((a: ApiValue, b: ApiValue) => (a.sort_order ?? 999) - (b.sort_order ?? 999))
})

// Lightbox
const lightboxOpen = ref(false)
const lightboxIdx = ref(0)

function openLightbox(i: number) {
  lightboxIdx.value = i
  lightboxOpen.value = true
}

const lightboxItems = computed(() =>
  sorted.value.map((p: ApiValue) => ({
    url: p.public_url,
    kind: 'image' as const,
    description: p.alt_text,
    alt: typeof p.alt_text === 'string' ? p.alt_text : ''
  }))
)


const organizationUrl = useRequestURL().origin

function toAbsoluteUrl(value?: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value, organizationUrl).toString()
  } catch {
    return null
  }
}

useSocialMetadata(() => ({
  path: `/locations/${slug.value}/photos`,
  title: t('saya.subnav.photos'),
  description: t('saya.photos.meta_description', {
    count: photos.value.length,
    location: location.value?.title || slug.value,
    organization: organizationName.value,
  }),
  socialImage: location.value?.social_image ?? null,
  breadcrumbs: [
    { name: t('saya.header.locations'), url: '/locations' },
    { name: location.value?.title ?? slug.value, url: `/locations/${slug.value}` },
    { name: t('saya.subnav.photos'), url: `/locations/${slug.value}/photos` },
  ],
}))

useSchemaOrg([
  computed(() => ({
    '@type': 'ImageGallery',
    name: `${location.value?.title ?? ''} · ${t('saya.subnav.photos')}`,
    image: photos.value.slice(0, 20).map((p: ApiValue) => {
      const contentUrl = toAbsoluteUrl(p.public_url)
      const thumbnailUrl = toAbsoluteUrl(p.thumbnail_url)
      if (!contentUrl) return null
      return {
        '@type': 'ImageObject',
        contentUrl,
        thumbnailUrl,
        description: p.alt_text,
        about: p.category
      }
    }).filter(Boolean)
  })),
])
</script>
