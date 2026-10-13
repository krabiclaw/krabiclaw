<template>
  <div data-parity-root>
    <section class="relative isolate overflow-hidden bg-[var(--blawby-primary-dark)]" data-parity-section="schedule-hero">
      <div class="blawby-container relative z-20 text-center" :class="nativeSchedule ? 'py-12 sm:py-16' : 'py-24 sm:py-32 lg:py-40 min-[1920px]:py-48 min-[2560px]:py-64'">
        <div class="mx-auto max-w-4xl min-[1920px]:max-w-6xl min-[2560px]:max-w-7xl">
          <p class="font-bold uppercase text-[var(--blawby-accent)]">{{ organizationName }}</p>
          <h1 v-if="scheduleTitle.before || scheduleTitle.accent" class="blawby-display font-medium text-white" :class="nativeSchedule ? 'mt-3 text-4xl sm:text-5xl' : 'text-5xl sm:text-7xl min-[1920px]:text-8xl min-[2560px]:text-9xl'">
            {{ scheduleTitle.before }}<span v-if="scheduleTitle.accent" class="text-[var(--blawby-accent)]">{{ scheduleTitle.accent }}</span>{{ scheduleTitle.after }}
          </h1>
          <p v-if="scheduleHero?.subtitle" class="mt-6 text-lg leading-8 text-gray-300 sm:text-xl min-[1920px]:text-2xl">{{ scheduleHero.subtitle }}</p>
          <p v-if="priceLine && !nativeSchedule" class="mt-6 text-lg font-bold text-[var(--blawby-accent)] sm:text-xl min-[1920px]:text-2xl">{{ priceLine }}</p>
          <BlawbyButton v-if="!nativeSchedule" :to="scheduleDestination" class="mt-10 w-full px-8 py-4 text-lg min-[1920px]:px-4 min-[1920px]:py-4 min-[1920px]:text-base min-[2560px]:px-5 min-[2560px]:py-5 min-[2560px]:text-lg" @click="trackConsultation('schedule_hero', scheduleDestination)">
            <svg class="-ml-0.5 mr-2 size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 2v4m8-4v4M3 10h18" /><rect x="3" y="4" width="18" height="18" rx="2" /></svg>
            {{ canSchedule ? scheduleHero?.cta_label || consultation.cta_label : t('site_pages.contact') }}
          </BlawbyButton>
          <p v-if="notice" class="mt-6 text-sm leading-6 text-gray-300">{{ notice }}</p>
        </div>
      </div>
    </section>

    <OnlineConsultationBooking v-if="nativeSchedule" />

    <TenantPageRenderer :page="contentPage" />
  </div>
</template>

<script setup lang="ts">
import OnlineConsultationBooking from '~/components/booking/OnlineConsultationBooking.vue'
import type { BlawbyDocumentPayload } from '~/utils/blawby-document-contract'
import { blawbySplitAccent } from '~/types/blawby'
import { blockText, blockTextOrNull } from '~/utils/tenant-page-block-data'

const document = inject<Ref<BlawbyDocumentPayload> | null>('blawby-document', null)
if (!document) throw createError({ statusCode: 500, statusMessage: 'Blawby layout did not provide the requested page' })
const routeData = computed(() => document.value.route)
const page = computed(() => routeData.value.page!)
if (!routeData.value.page) throw createError({ statusCode: 404, statusMessage: 'Schedule content not found' })
const shell = computed(() => document.value.shell)
const consultation = computed(() => shell.value.consultation)
const { localePath, t } = useI18n()

const scheduleHeroBlock = computed(() => page.value.blocks.find(block => block.type === 'hero'))
const scheduleHero = computed(() => scheduleHeroBlock.value?.data)
const canSchedule = computed(() => shell.value.canSchedule)
const nativeSchedule = computed(() => canSchedule.value && consultation.value.mode === 'native')
const scheduleDestination = computed(() => nativeSchedule.value ? '#consultations' : canSchedule.value && consultation.value.external_url ? consultation.value.external_url : localePath('/contact'))
const scheduleTitle = computed(() => blawbySplitAccent(blockText(scheduleHero.value?.title), blockTextOrNull(scheduleHero.value?.accent)))
const scheduleCta = computed(() => page.value.blocks.find(block => block.type === 'booking_cta')?.data)
const contentPage = computed(() => ({ ...page.value, blocks: page.value.blocks.filter(block => block.id !== scheduleHeroBlock.value?.id) }))
/**
 * What a consultation costs and what booking one does not create. Both belong
 * to the booking prompt, which is the block that declares them; they were read
 * off the hero as `priceLine` and `notice`, keys no list declared, so the page
 * said them twice from two different places and neither could be translated.
 */
const priceLine = computed(() => blockTextOrNull(scheduleCta.value?.price_line))
const notice = computed(() => blockTextOrNull(scheduleCta.value?.notice))
const { trackConsultationClick } = useOrganizationConversionTracking(consultation)
function trackConsultation(pageType: string, destination: string) {
  trackConsultationClick(pageType, '/schedule', destination)
}

// A page about the business: its image is the organization's.
const { name: organizationName, social_image: socialImage } = useTenantOrganization().organization
useSocialMetadata(() => ({
  path: '/schedule',
  socialImage,
  title: `${page.value.title} | ${organizationName}`,
  description: page.value.summary || '',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: page.value.title, url: '/schedule' },
  ],
  contentBlocks: page.value.blocks,
  professionalService: {
    recipe: 'schedule',
    consultationUrl: canSchedule.value ? (nativeSchedule.value ? localePath(consultation.value.schedule_path) : scheduleDestination.value) : null,
  },
}))
</script>
