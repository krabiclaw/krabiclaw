<template>
  <section class="relative overflow-hidden bg-black py-32" data-parity-section="consultation">
    <img v-if="backgroundUrl" :src="backgroundUrl" alt="" loading="lazy" class="absolute inset-0 size-full object-cover">
    <div class="blawby-container relative flex flex-col-reverse items-center lg:flex-row">
      <div class="w-full lg:w-1/2 lg:pl-16 lg:pr-8">
        <h2 class="blawby-display text-center text-3xl font-bold text-white sm:text-4xl lg:text-left">{{ title }}</h2>
        <p v-if="description" class="mt-4 text-center text-lg leading-8 text-white lg:text-left">{{ description }}</p>
        <p v-if="priceLine" class="mt-4 text-center font-semibold text-white lg:text-left">{{ priceLine }}</p>
        <p v-if="notice" class="mt-4 text-center text-sm text-white/80 lg:text-left">{{ notice }}</p>
        <div v-if="destination && label" class="mt-10 text-center lg:text-left">
          <BlawbyButton :to="destination" class="gap-2" @click="trackClick">
            <svg class="-ml-0.5 mr-2 size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.5 4.5h9A4.5 4.5 0 0 1 21 9v3a4.5 4.5 0 0 1-4.5 4.5h-4.86L7.2 20.2a.75.75 0 0 1-1.2-.6v-3.35A4.5 4.5 0 0 1 3 12V9a4.5 4.5 0 0 1 4.5-4.5Z" /></svg>
            {{ label }}
          </BlawbyButton>
        </div>
      </div>
      <div v-if="featuredUrl" class="w-full lg:w-1/2 lg:max-w-[300px] lg:pl-24">
        <div class="hidden justify-center lg:flex">
          <img :src="featuredUrl" alt="" width="300" height="370" loading="lazy" class="max-h-[370px] object-contain">
        </div>
        <div class="flex justify-center lg:hidden">
          <img :src="featuredUrl" alt="" width="300" height="370" loading="lazy" class="max-h-[120px] object-contain">
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import type { BlawbyDocumentPayload } from '~/utils/blawby-document-contract'
import { blockText, blockTextOrNull, blockMedia, isInternalRoute } from '~/utils/tenant-page-block-data'
const props = defineProps<{
  block: TenantPageBlock
  page: PublicTenantPage
}>()

const { localePath, t } = useI18n()
const title = computed(() => blockText(props.block.data.title))
const description = computed(() => blockTextOrNull(props.block.data.description))
const document = inject<Ref<BlawbyDocumentPayload> | null>('blawby-document', null)
if (!document) throw createError({ statusCode: 500, statusMessage: 'Scheduling context is unavailable' })
const destination = computed(() => {
  const url = blockText(props.block.data.url)
  if (url === document.value.shell.consultation.schedule_path) {
    if (props.page.recipe === 'schedule') {
      if (!document.value.shell.canSchedule) return localePath('/contact')
      if (document.value.shell.consultation.mode === 'native') return '#consultations'
      return document.value.shell.consultation.external_url!
    }
    if (!document.value.shell.canSchedule) return ''
  }
  return url ? (isInternalRoute(url) ? localePath(url) : url) : ''
})
const label = computed(() => props.page.recipe === 'schedule' && !document.value.shell.canSchedule ? t('site_pages.contact') : blockText(props.block.data.label))
const priceLine = computed(() => props.page.recipe === 'schedule' && document.value.shell.canSchedule && document.value.shell.consultation.mode === 'native' ? null : blockTextOrNull(props.block.data.price_line))
const notice = computed(() => blockTextOrNull(props.block.data.notice))
const backgroundUrl = computed(() => blockMedia(props.block, 'background')[0]?.public_url ?? null)
const featuredUrl = computed(() => blockMedia(props.block, 'featured')[0]?.public_url ?? null)

const emit = defineEmits<{ click: [] }>()
const { trackConsultationClick } = useOrganizationConversionTracking(() => document.value.shell.consultation)
function trackClick() {
  trackConsultationClick(props.page.recipe ?? 'page', props.page.path, destination.value, props.page.page_id)
  emit('click')
}
</script>
