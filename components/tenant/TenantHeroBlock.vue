<template>
  <!-- Home: full-bleed picture under the site's own words -->
  <section
    v-if="isHome"
    data-tenant-critical-hero
    :data-has-background="backgroundSrc ? 'true' : undefined"
    class="relative isolate flex min-h-160 items-center overflow-hidden bg-zinc-900"
    data-parity-section="hero"
  >
    <div data-tenant-critical-hero-media class="absolute inset-0 opacity-50">
      <video
        v-if="background?.kind === 'video'"
        :src="background.public_url!"
        :poster="background.thumbnail_url ?? undefined"
        autoplay muted loop playsinline
        aria-hidden="true"
        class="absolute inset-0 size-full object-cover object-center"
      />
      <img
        v-else-if="backgroundSrc"
        :src="backgroundSrc"
        :srcset="backgroundSrcset ?? undefined"
        sizes="100vw"
        alt=""
        aria-hidden="true"
        width="1920"
        height="1080"
        fetchpriority="high"
        loading="eager"
        decoding="async"
        class="absolute inset-0 size-full object-cover object-center"
      >
      <div
        v-else
        aria-hidden="true"
        class="absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,var(--ui-primary)_0%,color-mix(in_srgb,var(--ui-primary)_60%,black)_100%)]"
      >
        <TenantIcon name="sparkles" class="size-24 text-white/25" />
      </div>
    </div>
    <div data-tenant-critical-hero-overlay class="absolute inset-0" style="background: linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.2) 50%, rgba(0,0,0,0.3) 100%)" />

    <div data-tenant-critical-hero-content class="tenant-container relative z-10 w-full py-36 text-left">
      <p v-if="eyebrow" data-field="hero.eyebrow" class="tenant-eyebrow mb-6 text-white/70">
        {{ eyebrow }}
      </p>
      <h1 data-field="hero.title" :class="longTitle ? 'tenant-display-md' : 'tenant-display-lg'" class="max-w-4xl whitespace-pre-line text-white">
        {{ splitTitle.before }}<span v-if="splitTitle.accent" class="text-[var(--tenant-accent)]">{{ splitTitle.accent }}</span>{{ splitTitle.after }}
      </h1>
      <p v-if="description" class="mt-6 max-w-2xl text-lg text-white">
        {{ description }}
      </p>
      <div v-if="actions.length" class="mt-10 flex flex-wrap gap-4">
        <TenantButton v-if="actions[0]" :to="actions[0].url" size="lg">
          {{ actions[0].label }}
        </TenantButton>
        <TenantButton v-if="actions[1]" :to="actions[1].url" variant="outline" size="lg" class="border-white/50 text-white hover:bg-white/10">
          {{ actions[1].label }}
        </TenantButton>
      </div>
    </div>
  </section>

  <!-- A page with pictures: the pictures beside its name, words and action -->
  <section
    v-else-if="gallery.length"
    class="mx-auto mb-8 max-w-7xl border-b border-default pt-8 sm:px-6 md:flex lg:px-8"
    data-parity-section="service-overview"
  >
    <TenantMediaGallery v-model="activeMedia" :media="gallery" :fallback-alt="page.title" />
    <div class="flex-1">
      <div class="tenant-container pb-8 pt-8">
        <h1 v-if="title" class="tenant-display mx-auto max-w-4xl text-3xl font-bold text-highlighted sm:text-4xl md:mt-2">
          {{ title }}
        </h1>
        <TenantRichText v-if="overviewProse" :content="overviewProse" unstyled class="prose mx-auto mt-6 max-w-2xl text-left text-lg text-default" />
        <div v-if="overviewActions.length" class="mt-10 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <TenantButton v-for="action in overviewActions" :key="action.url" :to="action.url" class="gap-2">
            {{ action.label }}
          </TenantButton>
        </div>
      </div>
    </div>
  </section>

  <!-- Every other page opens on the site's band; a divider closing the hero section cuts the shield from it -->
  <template v-else>
    <section class="relative overflow-hidden bg-[var(--tenant-band)]" data-parity-section="page-hero">
      <div class="tenant-container relative pb-16 pt-20 sm:pb-24 sm:pt-28">
        <div class="mx-auto max-w-4xl text-center">
          <p v-if="eyebrow" class="mb-4 text-sm font-semibold uppercase tracking-wide text-[var(--tenant-accent-strong)]">
            {{ eyebrow }}
          </p>
          <h1 v-if="title" class="tenant-display-md text-highlighted">
            {{ splitTitle.before }}<span v-if="splitTitle.accent" class="text-[var(--tenant-accent-strong)]">{{ splitTitle.accent }}</span>{{ splitTitle.after }}
          </h1>
          <TenantRichText
            v-for="(part, index) in descriptionParts"
            :key="index"
            :content="part"
            unstyled
            class="prose prose-lg mx-auto mt-6 max-w-2xl text-default"
          />
          <div v-if="pageAction" class="mt-10">
            <TenantButton :to="pageAction.url" size="lg">
              {{ pageAction.label }}
            </TenantButton>
          </div>
        </div>
      </div>
    </section>
    <!-- A legal practice's consultations, listed under its schedule page's hero -->
    <OnlineConsultationBooking v-if="isSchedule && nativeSchedule" />
  </template>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockMedia, isInternalRoute, overviewProseBlockId, splitAccent } from '~/utils/tenant-page-block-data'
import { cfImageSrcset } from '~/utils/cf-image'
import OnlineConsultationBooking from '~/components/booking/OnlineConsultationBooking.vue'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const route = useRoute()
const { localePath, t } = useI18n()
const { consultation, canSchedule } = useOrganizationShellState()

const isHome = computed(() => props.page.path === '/' || route.path === '/')
const isSchedule = computed(() => props.page.recipe === 'schedule')

const title = computed(() => blockText(props.block?.data?.title) || props.page.title || '')
const subtitle = computed(() => blockText(props.block?.data?.subtitle))
const eyebrow = computed(() => blockText(props.block?.data?.eyebrow))
// A hero's subtitle is the words beneath its title; a page hero without one reads the page summary.
const description = computed(() => blockText(props.block?.data?.description) || subtitle.value || (isHome.value ? '' : props.page.summary ?? ''))
const descriptionParts = computed(() => description.value.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean))
const splitTitle = computed(() => splitAccent(title.value, blockText(props.block?.data?.accent)))
// A home headline past a short line is set a size down, so it and its action fit the first screen.
const longTitle = computed(() => title.value.length > 48)

function destination(url: string): string {
  return url && isInternalRoute(url) ? localePath(url) : url
}
const primary = computed(() => ({ label: blockText(props.block?.data?.cta_label), url: destination(blockText(props.block?.data?.cta_url)) }))
const secondary = computed(() => ({ label: blockText(props.block?.data?.secondary_label), url: destination(blockText(props.block?.data?.secondary_url)) }))
const actions = computed(() => [primary.value, secondary.value].filter(action => action.label && action.url))

const mediaList = computed(() => props.block ? blockMedia(props.block, 'media') : (props.page.media || []))
const background = computed(() => mediaList.value[0] ?? null)
const backgroundSrc = computed(() => background.value?.public_url || null)
const backgroundSrcset = computed(() => backgroundSrc.value ? cfImageSrcset(backgroundSrc.value) : null)

const gallery = computed(() => (props.page.media ?? [])
  .filter(media => media.slot === 'gallery' || media.slot === 'cover')
  .map(media => ({
    asset_id: media.asset_id || media.public_url || '',
    public_url: media.public_url || '',
    alt_text: media.alt_text ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
  })))
const activeMedia = ref(0)
const overviewProse = computed(() => {
  const absorbedId = overviewProseBlockId(props.page)
  const absorbed = absorbedId ? props.page.blocks.find(item => item.id === absorbedId) : null
  return (absorbed ? (blockText(absorbed.data.markdown) || blockText(absorbed.data.body)) : '') || description.value
})
// An offering's own page asks for one thing: its primary action.
const overviewActions = computed(() => (props.page.product_id ? actions.value.slice(0, 1) : actions.value))

// The schedule page lists the consultations natively, sends visitors to the
// practice's external scheduler, or — with nothing bookable — to contact.
const nativeSchedule = computed(() => Boolean(canSchedule.value && consultation.value?.mode === 'native'))
const pageAction = computed(() => {
  if (!isSchedule.value || !consultation.value) return actions.value[0] ?? null
  if (nativeSchedule.value) return null
  if (canSchedule.value && consultation.value.mode === 'external_url' && consultation.value.external_url) {
    return { label: primary.value.label || consultation.value.cta_label || t('site_pages.schedule'), url: consultation.value.external_url }
  }
  return { label: t('site_pages.contact'), url: localePath('/contact') }
})
</script>
