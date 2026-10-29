<template>
  <div class="min-h-screen bg-default text-default">
    <div v-if="pending" class="tenant-container py-20">
      <div class="h-64 w-full animate-pulse rounded bg-elevated" />
    </div>

    <template v-else>
      <!-- Page header -->
      <header class="tenant-container pt-16 pb-12 text-center">
        <p class="tenant-kicker mb-6">{{ t('site.footer.gallery') }}</p>
        <h1 class="tenant-display-md tenant-italic text-default">{{ t('site.photos.title') }}</h1>

        <!-- Multi-location pills -->
        <div v-if="locations.length > 1" class="mt-8 flex flex-wrap justify-center gap-3">
          <NuxtLink
            v-for="loc in locations"
            :key="loc.id"
            :to="localePath(`/locations/${loc.slug}/photos`)"
            class="inline-flex items-center gap-2 rounded-full border border-default px-5 py-2.5 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
          >
            <TenantIcon name="map-pin" class="size-3.5 opacity-70" />
            {{ loc.title }}
          </NuxtLink>
        </div>
      </header>

      <!-- Empty state -->
      <div v-if="photos.length === 0" class="mx-auto max-w-xl px-4 py-24 text-center sm:px-6">
        <h1 class="tenant-display-md text-muted">{{ t('site.photos.empty_title') }}</h1>
        <p class="mt-4 text-sm text-muted">{{ t('site.photos.empty_desc') }}</p>
      </div>

      <template v-else>
        <!-- Category filter tabs -->
        <TenantFilterTabs v-model="activeCategory" :tabs="cats" />

        <!-- Gallery -->
        <div class="tenant-container pt-12 pb-24">
          <div class="tenant-masonry">
            <button
              v-for="(photo, i) in sorted"
              :key="photo.id"
              class="group relative block w-full overflow-hidden rounded-2xl bg-black"
              @click="openLightbox(i)"
            >
              <img
                :src="photo.public_url"
                :alt="typeof photo.alt_text === 'string' ? photo.alt_text : ''"
                loading="lazy"
                class="block w-full transition-opacity duration-200 group-hover:opacity-80"
              />
              <div class="absolute inset-0 flex items-end bg-linear-to-t from-black/60 to-transparent p-6 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                <span v-if="photoLabel(photo)" class="tenant-eyebrow rounded-full bg-white/25 px-4 py-1.5 text-[10px] font-bold tracking-widest text-white backdrop-blur-md border border-white/20">
                  {{ photoLabel(photo) }}
                </span>
              </div>
            </button>
          </div>
        </div>

        <!-- Lightbox -->
        <MediaLightbox v-model:open="lightboxOpen" v-model:index="lightboxIdx" :items="lightboxItems" :title="organizationName" />
      </template>
    </template>
  </div>
</template>

<script setup>
definePageMeta({ layout: 'tenant' })

const { localePath, t } = useI18n()
const { organization } = useTenantOrganization()
const { locations, media: photos, pending, sections } = await usePublicPageData()
// A section with nothing on it is not a page; the navigation hides it by the same flag.
if (sections.value?.photos === false) throw createError({ statusCode: 404 })
const organizationName = organization.name

const locationsById = computed(() => Object.fromEntries(locations.value.map(l => [l.id, l])))
function locationTitle(photo) {
  if (locations.value.length <= 1) return null
  const title = locationsById.value[photo.owner_id]?.title
  return typeof title === 'string' ? title : null
}

const photoCategoryKeys = {
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

function categoryLabel(category) {
  const key = photoCategoryKeys[category]
  return typeof key === 'string' ? t(key) : t('site.photos.category_other')
}

function photoLabel(photo) {
  const title = locationTitle(photo)
  if (locations.value.length > 1) return title
  return categoryLabel(photo.category)
}

const sorted = computed(() => {
  const filtered = activeCategory.value === 'ALL'
    ? photos.value
    : activeCategory.value === 'FOOD'
      ? photos.value.filter(p => p.category === 'FOOD' || p.category === 'MENU')
      : photos.value.filter(p => p.category === activeCategory.value)
  return [...filtered].sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999))
})

const lightboxOpen = ref(false)
const lightboxIdx = ref(0)
function openLightbox(i) {
  lightboxIdx.value = i
  lightboxOpen.value = true
}

const lightboxItems = computed(() =>
  sorted.value.map(p => ({
    url: p.public_url,
    kind: 'image',
    description: p.alt_text,
    alt: typeof p.alt_text === 'string' ? p.alt_text : ''
  }))
)

useSocialMetadata(() => ({
  path: '/photos',
  title: `${t('site.subnav.photos')} | ${organizationName}`,
  description: t('site.photos.meta_description', {
    count: photos.value.length,
    location: organizationName,
    organization: organizationName,
  }),
  socialImage: organization.social_image,
  breadcrumbs: [
    { name: t('site.subnav.photos'), url: '/photos' },
  ],
}))
</script>
