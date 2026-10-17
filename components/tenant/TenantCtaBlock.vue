<template>
  <section
    class="relative overflow-hidden py-24 sm:py-32 text-white"
    :class="isService ? 'bg-black' : 'bg-zinc-950'"
    data-parity-section="consultation"
  >
    <img
      v-if="backgroundUrl"
      :src="backgroundUrl"
      alt=""
      loading="lazy"
      class="absolute inset-0 size-full object-cover"
      :class="isService ? undefined : 'opacity-30'"
    >
    <div
      class="tenant-container relative flex flex-col-reverse items-center lg:flex-row"
      :class="isService ? undefined : 'lg:justify-between'"
    >
      <div :class="isService ? 'w-full lg:w-1/2 lg:pl-16 lg:pr-8' : 'w-full max-w-2xl text-center lg:text-left'">
        <h2 class="tenant-display text-center text-3xl font-bold text-white sm:text-4xl lg:text-left">{{ title }}</h2>
        <p v-if="description" class="mt-4 text-center text-lg leading-8 text-white/90 lg:text-left">{{ description }}</p>
        <p v-if="priceLine" class="mt-4 text-center font-semibold text-white lg:text-left">{{ priceLine }}</p>
        <p v-if="notice" class="mt-4 text-center text-sm text-white/80 lg:text-left">{{ notice }}</p>
        <div v-if="destination && label" class="mt-10 text-center lg:text-left">
          <TenantButton :to="destination" size="lg" class="gap-2" @click="trackClick">
            <svg v-if="isService" class="-ml-0.5 mr-2 size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7.5 4.5h9A4.5 4.5 0 0 1 21 9v3a4.5 4.5 0 0 1-4.5 4.5h-4.86L7.2 20.2a.75.75 0 0 1-1.2-.6v-3.35A4.5 4.5 0 0 1 3 12V9a4.5 4.5 0 0 1 4.5-4.5Z" />
            </svg>
            {{ label }}
          </TenantButton>
        </div>
      </div>
      <div v-if="featuredUrl" :class="isService ? 'w-full lg:w-1/2 lg:max-w-[300px] lg:pl-24' : 'w-full lg:w-auto mb-8 lg:mb-0 flex justify-center'">
        <template v-if="isService">
          <div class="hidden justify-center lg:flex">
            <img :src="featuredUrl" alt="" width="300" height="370" loading="lazy" class="max-h-[370px] object-contain">
          </div>
          <div class="flex justify-center lg:hidden">
            <img :src="featuredUrl" alt="" width="300" height="370" loading="lazy" class="max-h-[120px] object-contain">
          </div>
        </template>
        <template v-else>
          <img :src="featuredUrl" alt="" width="300" height="370" loading="lazy" class="max-h-[300px] object-contain">
        </template>
      </div>
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
const { organization } = useTenantOrganization()
const { consultation, canSchedule } = useOrganizationShellState()

const isService = computed(() => organization.template?.slug === 'blawby' || organization.vertical === 'service')

const title = computed(() => blockText(props.block.data.title))
const description = computed(() => blockTextOrNull(props.block.data.description))
const targetsSchedule = computed(() => Boolean(consultation.value && blockText(props.block.data.url) === consultation.value.schedule_path))

const destination = computed(() => {
  const url = blockText(props.block.data.url)
  if (targetsSchedule.value && consultation.value) {
    if (props.page.recipe === 'schedule') {
      if (!canSchedule.value) return localePath('/contact')
      if (consultation.value.mode === 'native') return '#consultations'
      return consultation.value.external_url!
    }
    if (!canSchedule.value) return ''
  }
  return url ? (isInternalRoute(url) ? localePath(url) : url) : ''
})

const label = computed(() => targetsSchedule.value && props.page.recipe === 'schedule' && consultation.value && !canSchedule.value ? t('site_pages.contact') : blockText(props.block.data.label))
const priceLine = computed(() => blockTextOrNull(props.block.data.price_line))
const notice = computed(() => blockTextOrNull(props.block.data.notice))
const backgroundUrl = computed(() => blockMedia(props.block, 'background')[0]?.public_url ?? null)
const featuredUrl = computed(() => blockMedia(props.block, 'featured')[0]?.public_url ?? null)

const emit = defineEmits<{ click: [] }>()
const { trackConsultationClick } = useOrganizationConversionTracking(consultation)

function trackClick() {
  if (destination.value) {
    trackConsultationClick(props.page.recipe ?? 'page', props.page.path, destination.value, props.page.page_id)
  }
  emit('click')
}
</script>
