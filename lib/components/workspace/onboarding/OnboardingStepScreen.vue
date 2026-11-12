<template>
  <div class="flex min-h-0 flex-col gap-6" :class="{ 'py-6': step.id !== 'type' }" :data-onboarding-step="step.id" data-onboarding-hydrated="true">
    <div
      v-if="step.id === 'type'"
      class="flex flex-col gap-6 md:gap-8"
    >
      <figure class="flex items-center justify-center bg-[var(--kc-coral-50)] px-8 py-6 md:py-9">
        <div class="w-full max-w-[15rem] overflow-hidden rounded-2xl bg-white p-2 text-slate-900 shadow-xl md:max-w-[27rem] md:p-3">
          <img
            :src="websiteExample?.image ?? '/images/website/onboarding-neutral.webp'"
            :alt="websiteExample ? `Website preview for ${websiteExample.name}` : ''"
            class="aspect-[3/2] w-full rounded-xl object-cover object-top"
            fetchpriority="high"
          >
          <figcaption class="truncate px-2 py-2 text-sm font-semibold md:py-3" aria-live="polite">
            {{ websiteExample?.name ?? 'Your business website' }}
          </figcaption>
        </div>
      </figure>
      <div class="mx-auto w-full max-w-4xl space-y-5 px-5 pb-5 sm:px-8 md:pb-6">
        <h1 class="text-center text-2xl font-semibold tracking-tight md:text-4xl">{{ step.title }}</h1>
        <OnboardingChoiceGrid
          compact
          :choices="plan?.businessTypes ?? []"
          :model-value="state.vertical"
          @update:model-value="selectVertical"
        />
      </div>
    </div>

    <h1 v-else :class="dashboardTitleClass">{{ step.title }}</h1>

    <OnboardingChoiceGrid
      v-if="step.id === 'language'"
      :choices="LANGUAGE_CHOICES"
      :model-value="state.details.sourceLocale"
      @update:model-value="choose(() => { state.details.sourceLocale = $event })"
    />

    <div v-else-if="step.id === 'business'" class="flex flex-col gap-3">
      <template v-if="!googleImport">
        <UFormField label="Name" required>
          <UInput :model-value="state.details.name" class="w-full" autofocus @update:model-value="setManualName" />
        </UFormField>
        <UButton label="Import from Google Maps" variant="link" class="self-start" @click="googleImport = true" />
      </template>
      <template v-else>
        <GooglePlacePicker v-model="businessSearch" @select="choosePlace" />
        <UButton label="Enter details manually" color="neutral" variant="ghost" class="self-start" @click="enterManually" />
      </template>
    </div>

    <IntakeDetailsCard
      v-else-if="step.id === 'location'"
      v-model:form="detailsForm"
      section="location"
      :require-location-basics="false"
    />

    <IntakeDetailsCard
      v-else-if="step.id === 'contact'"
      v-model:form="detailsForm"
      section="contact"
      :require-location-basics="false"
    />

    <!-- One control and nothing else to confirm, so the selection is the answer
         and the flow moves on — the same as the other single-choice steps. The
         card emits submit when a currency is picked. -->
    <IntakeDetailsCard
      v-else-if="step.id === 'currency'"
      v-model:form="detailsForm"
      section="currency"
      :require-location-basics="true"
      @submit="emit('advance')"
    />

    <LocationHoursCard v-else-if="step.id === 'hours'" v-model:form="state.hours" />

    <OnboardingProductsCard v-else-if="step.id === 'products'" />

    <DraftBrandCard v-else-if="step.id === 'look'" v-model:form="state.brand" v-model:revision="state.draftRevision" section="look" :draft-id="state.draftId" @uploading="emit('uploading', $event)" />

    <OnboardingReviewCard v-else-if="step.id === 'review'" />
  </div>
</template>

<script setup lang="ts">
import { dashboardTitleClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
import { PLATFORM_LOCALES } from '~/shared/platform-locales'
const LANGUAGE_CHOICES = PLATFORM_LOCALES.map(locale => ({ value: locale.locale, label: locale.label, icon: 'i-lucide-languages' }))
import IntakeDetailsCard from '~/lib/components/workspace/onboarding/IntakeDetailsCard.vue'
import DraftBrandCard from '~/lib/components/workspace/onboarding/DraftBrandCard.vue'
import LocationHoursCard from '~/lib/components/workspace/location/LocationHoursCard.vue'
import OnboardingChoiceGrid from '~/lib/components/workspace/onboarding/OnboardingChoiceGrid.vue'
import GooglePlacePicker from '~/lib/components/workspace/location/GooglePlacePicker.vue'
import OnboardingProductsCard from '~/lib/components/workspace/onboarding/OnboardingProductsCard.vue'
import OnboardingReviewCard from '~/lib/components/workspace/onboarding/OnboardingReviewCard.vue'
import { useOnboardingPlan, useOnboardingState, type OnboardingPlacePreview } from '~/composables/useOnboardingFlow'
import type { OnboardingStep } from '~/shared/onboarding-flow'
import { useOnboardingDraft } from '~/composables/useOnboardingDraft'
import { currencyForCountry } from '~/shared/currencies'
import { singleTimezoneForCountry } from '~/utils/timezone'

/**
 * One step of the new-site flow, rendered.
 *
 * The screen owns the controls and nothing else: the shell owns the footer,
 * the server calls and where "next" goes.
 */
const props = defineProps<{ step: OnboardingStep }>()
const emit = defineEmits<{ advance: []; uploading: [value: boolean] }>()

const state = useOnboardingState()

const plan = useOnboardingPlan()
const websiteExample = computed(() => plan.value?.businessTypes.find(choice => choice.value === state.value.vertical)?.example)

function selectVertical(value: string) {
  const choice = plan.value?.businessTypes.find(option => option.value === value)
  if (choice) state.value.vertical = choice.value
}

// A single-choice step has nothing left to confirm once the card is pressed, so
// the press is the answer and the flow moves on.
function choose(answer: () => void) {
  answer()
  emit('advance')
}

// The business search starts from the name already given, so Back to this step
// shows what the owner picked rather than an empty box. Both shells keep this
// screen mounted across steps, so it is read each time the step is entered.
const businessSearch = ref('')
const googleImport = ref(false)
watch(() => props.step.id, (id) => {
  if (id === 'business') {
    businessSearch.value = state.value.details.name
    state.value.source ??= 'manual'
  }
}, { immediate: true })
const { seedFromPlace } = useOnboardingDraft()

function choosePlace(place: OnboardingPlacePreview) {
  googleImport.value = false
  choose(() => seedFromPlace(place))
}

function setManualName(value: string | number | undefined) {
  const previousName = state.value.details.name
  state.value.details.name = String(value ?? '')
  state.value.source = 'manual'
  state.value.placeId = null
  if (!state.value.brand.heroHeadline || state.value.brand.heroHeadline === previousName) state.value.brand.heroHeadline = state.value.details.name
}

function enterManually() {
  choose(() => {
    googleImport.value = false
    setManualName(businessSearch.value.trim())
  })
}

// IntakeDetailsCard owns its own form object; the flow's details are that
// object, so the card edits the answers directly rather than a copy that has to
// be synced back.
const detailsForm = computed({
  get: () => state.value.details,
  set: (value) => { state.value.details = value },
})

// The owner named their country on the location step. When that country has
// exactly one IANA zone, that is their timezone; when it has several, the field
// stays empty and they search the list. Never overwrite a zone the owner or the
// Google import already set.
watch(() => props.step.id, (id) => {
  if (id !== 'hours' || state.value.hours.timezone) return
  const zone = singleTimezoneForCountry(state.value.details.country)
  if (zone) state.value.hours.timezone = zone
}, { immediate: true })

// Same shape for the currency: the country proposes it, the owner confirms it on
// this step, and an answer already given is never overwritten.
watch(() => props.step.id, (id) => {
  if (id !== 'currency' || state.value.details.currency) return
  state.value.details.currency = currencyForCountry(state.value.details.country)
}, { immediate: true })
</script>
