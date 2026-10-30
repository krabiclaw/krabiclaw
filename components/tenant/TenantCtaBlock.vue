<template>
  <section
    class="relative overflow-hidden py-24 sm:py-32"
    :class="backgroundUrl ? 'bg-zinc-950 text-white' : 'bg-[var(--tenant-band)] text-default'"
    data-parity-section="consultation"
  >
    <template v-if="backgroundUrl">
      <img :src="backgroundUrl" alt="" loading="lazy" class="absolute inset-0 size-full object-cover">
      <!-- The words sit on the picture's darker side, whatever the picture is. -->
      <div class="absolute inset-0 bg-gradient-to-r from-black/80 via-black/55 to-black/10" aria-hidden="true" />
    </template>
    <div class="tenant-container relative flex flex-col-reverse items-center gap-10 lg:flex-row lg:justify-between">
      <div class="w-full max-w-2xl text-center lg:text-left">
        <h2 class="tenant-display text-3xl font-bold sm:text-4xl" :class="backgroundUrl ? 'text-white' : 'text-highlighted'">{{ title }}</h2>
        <p v-if="description" class="mt-4 text-lg leading-8" :class="backgroundUrl ? 'text-white/90' : 'text-muted'">{{ description }}</p>
        <p v-if="priceLine" class="mt-4 font-semibold">{{ priceLine }}</p>
        <p v-if="notice" class="mt-4 text-sm" :class="backgroundUrl ? 'text-white/80' : 'text-muted'">{{ notice }}</p>
        <div v-if="destination && label" class="mt-10">
          <TenantButton :to="destination" size="lg" @click="trackClick">
            {{ label }}
          </TenantButton>
        </div>
      </div>
      <img v-if="featuredMedia?.public_url" :src="featuredMedia.public_url" :alt="featuredMedia.alt_text ?? ''" width="300" height="370" loading="lazy" class="max-h-[160px] object-contain lg:max-h-[370px]">
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockMedia, isInternalRoute } from '~/utils/tenant-page-block-data'

const props = defineProps<{
  block: TenantPageBlock
  page: PublicTenantPage
}>()

const { localePath, t } = useI18n()
const { consultation, canSchedule } = useOrganizationShellState()

const title = computed(() => blockText(props.block.data.title))
const description = computed(() => blockTextOrNull(props.block.data.description))
const targetsSchedule = computed(() => {
  const url = blockText(props.block.data.url)
  // A legal practice's call to action with no address of its own books a consultation.
  return Boolean(consultation.value && (url === consultation.value.schedule_path || !url))
})

const destination = computed(() => {
  const rawUrl = blockText(props.block.data.url)
  const url = rawUrl || (consultation.value ? consultation.value.schedule_path : '')
  if (targetsSchedule.value && consultation.value) {
    if (props.page.recipe === 'schedule') {
      if (!canSchedule.value) return localePath('/contact')
      if (consultation.value.mode === 'native') return '#consultations'
      if (!consultation.value.external_url) throw new Error('An external scheduler has no address')
      return consultation.value.external_url
    }
    if (!canSchedule.value) return ''
  }
  return url ? (isInternalRoute(url) ? localePath(url) : url) : ''
})

const label = computed(() => targetsSchedule.value && props.page.recipe === 'schedule' && consultation.value && !canSchedule.value ? t('site_pages.contact') : blockText(props.block.data.label))
const priceLine = computed(() => blockTextOrNull(props.block.data.price_line))
const notice = computed(() => blockTextOrNull(props.block.data.notice))
const backgroundUrl = computed(() => blockMedia(props.block, 'media')[0]?.public_url ?? null)
const featuredMedia = computed(() => blockMedia(props.block, 'featured')[0] ?? null)

const emit = defineEmits<{ click: [] }>()
const { trackConsultationClick } = useOrganizationConversionTracking()

function trackClick() {
  if (destination.value) {
    trackConsultationClick(props.page.recipe ?? 'page', props.page.path, destination.value, props.page.page_id)
  }
  emit('click')
}
</script>
