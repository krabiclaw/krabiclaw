<template>
  <div class="min-h-screen bg-default text-default">


    <template v-if="location">
      <!-- Sub-nav (Level 2) -->
      <TenantSubNav 
        :location-slug="slug" 
        active="photos" 
      />

      <!-- Compact Page header -->
      <header class="tenant-container pt-12 pb-10 text-center">
        <NuxtLink :to="localePath(`/locations/${slug}`)" class="tenant-kicker mb-8 inline-block text-muted no-underline hover:text-default">
          ← {{ t('site.location.back_to', { title: location?.title }) }}
        </NuxtLink>
        
        <div class="flex flex-col gap-2">
          <h1 class="tenant-display-md text-default">{{ t('site.photos.title') }}</h1>
          <p class="text-sm text-muted">
            {{ location?.title }}
          </p>
        </div>
      </header>


    <!-- Category filter tabs -->
    <TenantFilterTabs
      v-model="activeCategory"
      :tabs="cats"
    />

      <!-- Gallery -->
      <div class="tenant-container pt-12 pb-24">
        <!-- Empty -->
        <div v-if="sorted.length === 0" class="py-24 text-center">
          <div class="tenant-display tenant-italic text-3xl text-default">{{ t('site.photos.empty_title') }}</div>
          <p class="mt-2 text-sm text-muted">{{ t('site.photos.empty_desc') }}</p>
        </div>

        <!-- Masonry -->
        <div v-else class="tenant-masonry">
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
              <span class="tenant-eyebrow rounded-full bg-white/25 px-4 py-1.5 text-[10px] font-bold tracking-widest text-white backdrop-blur-md border border-white/20">
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
definePageMeta({ layout: 'tenant' })

const route = useRoute()
const { organization } = useTenantOrganization()
const slug = computed(() => String(route.params.slug))
const organizationName = computed(() => String((organization as ApiValue)?.name ?? '').trim())

const { location, media: photos } = await usePublicPageData({ lazy: false })
// A slug naming no location is a URL that does not exist. Rendering the page
// around a null location answered 200 with an empty shell — a soft 404 a
// crawler indexes. The sibling menu and product indexes already refuse it.
if (!location.value) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
// A section with nothing on it is not a page; the navigation hides it by the same flag.
if (!location.value.sections.photos) throw createError({ statusCode: 404 })


const photoCategoryKeys: Record<string, string> = {
  FOOD: 'site.photos.category_food',
  INTERIOR: 'site.photos.category_interior',
  EXTERIOR: 'site.photos.category_exterior',
  MENU: 'site.photos.category_menu',
  TEAM: 'site.photos.category_team',
  OTHER: 'site.photos.category_other',
}
const cats = computed(() => [
  { key: 'ALL', label: t('site.photos.category_all') },
  { key: 'FOOD', label: t('site.photos.category_food') },
  { key: 'INTERIOR', label: t('site.photos.category_interior') },
  { key: 'EXTERIOR', label: t('site.photos.category_exterior') },
  { key: 'MENU', label: t('site.photos.category_menu') },
  { key: 'TEAM', label: t('site.photos.category_team') }
])
const activeCategory = ref('ALL')

function categoryLabel(category: unknown): string {
  if (typeof category !== 'string') return t('site.photos.category_other')
  const key = photoCategoryKeys[category]
  return typeof key === 'string' ? t(key) : t('site.photos.category_other')
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
  title: t('site.subnav.photos'),
  description: t('site.photos.meta_description', {
    count: photos.value.length,
    location: location.value?.title || slug.value,
    organization: organizationName.value,
  }),
  socialImage: location.value?.social_image ?? null,
  breadcrumbs: [
    { name: t('site.header.locations'), url: '/locations' },
    { name: location.value?.title ?? slug.value, url: `/locations/${slug.value}` },
    { name: t('site.subnav.photos'), url: `/locations/${slug.value}/photos` },
  ],
}))

useSchemaOrg([
  computed(() => ({
    '@type': 'ImageGallery',
    name: `${location.value?.title ?? ''} · ${t('site.subnav.photos')}`,
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
