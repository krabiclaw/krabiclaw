<template>
  <section class="relative overflow-hidden bg-zinc-950 py-24 text-white" data-parity-section="consultation">
    <img v-if="backgroundUrl" :src="backgroundUrl" alt="" loading="lazy" class="absolute inset-0 size-full object-cover opacity-30">
    <div class="tenant-container relative flex flex-col-reverse items-center lg:flex-row lg:justify-between">
      <div class="w-full max-w-2xl text-center lg:text-left">
        <h2 class="tenant-display text-3xl font-bold text-white sm:text-4xl">{{ title }}</h2>
        <p v-if="description" class="mt-4 text-lg leading-8 text-white/90">{{ description }}</p>
        <p v-if="priceLine" class="mt-4 font-semibold text-white">{{ priceLine }}</p>
        <p v-if="notice" class="mt-4 text-sm text-white/80">{{ notice }}</p>
        <div v-if="destination && label" class="mt-8">
          <TenantButton :to="destination" size="lg" @click="trackClick">
            {{ label }}
          </TenantButton>
        </div>
      </div>
      <div v-if="featuredUrl" class="w-full lg:w-auto mb-8 lg:mb-0 flex justify-center">
        <img :src="featuredUrl" alt="" width="300" height="370" loading="lazy" class="max-h-[300px] object-contain">
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
const targetsSchedule = computed(() => Boolean(document?.value && blockText(props.block.data.url) === document.value.shell.consultation.schedule_path))

const destination = computed(() => {
  const url = blockText(props.block.data.url)
  if (targetsSchedule.value && document?.value) {
    if (props.page.recipe === 'schedule') {
      if (!document.value.shell.canSchedule) return localePath('/contact')
      if (document.value.shell.consultation.mode === 'native') return '#consultations'
      return document.value.shell.consultation.external_url!
    }
    if (!document.value.shell.canSchedule) return ''
  }
  return url ? (isInternalRoute(url) ? localePath(url) : url) : ''
})

const label = computed(() => targetsSchedule.value && props.page.recipe === 'schedule' && document?.value && !document.value.shell.canSchedule ? t('site_pages.contact') : blockText(props.block.data.label))
const priceLine = computed(() => blockTextOrNull(props.block.data.price_line))
const notice = computed(() => blockTextOrNull(props.block.data.notice))
const backgroundUrl = computed(() => blockMedia(props.block, 'background')[0]?.public_url ?? null)
const featuredUrl = computed(() => blockMedia(props.block, 'featured')[0]?.public_url ?? null)

const emit = defineEmits<{ click: [] }>()
const { trackConsultationClick } = useOrganizationConversionTracking(() => document?.value?.shell.consultation)

function trackClick() {
  if (destination.value) {
    trackConsultationClick(props.page.recipe ?? 'page', props.page.path, destination.value, props.page.page_id)
  }
  emit('click')
}
</script>
