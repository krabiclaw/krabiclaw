<template>
  <div class="flex min-h-0 flex-col gap-6 py-6" :data-onboarding-step="step.id" data-onboarding-hydrated="true">
    <div class="flex flex-col gap-3">
      <h1 class="text-2xl font-bold leading-snug text-highlighted">{{ step.title(state) }}</h1>
      <p v-if="step.lede" class="text-[15px] leading-relaxed text-toned">{{ step.lede(state) }}</p>
    </div>

    <OnboardingChoiceGrid
      v-if="step.id === 'type'"
      :choices="VERTICAL_CHOICES"
      :model-value="state.vertical"
      @update:model-value="choose(() => { state.vertical = $event as OrganizationVertical })"
    />

    <OnboardingChoiceGrid
      v-else-if="step.id === 'language'"
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

    <DraftBrandCard v-else-if="step.id === 'look'" v-model:form="state.brand" v-model:revision="state.draftRevision" section="look" :draft-id="state.draftId" />

    <OnboardingReviewCard v-else-if="step.id === 'review'" />
  </div>
</template>

<script setup lang="ts">
import { PLATFORM_LOCALES } from '~/shared/platform-locales'
const LANGUAGE_CHOICES = PLATFORM_LOCALES.map(locale => ({ value: locale.locale, label: locale.label, icon: 'i-lucide-languages' }))
import IntakeDetailsCard from '~/lib/components/workspace/onboarding/IntakeDetailsCard.vue'
import DraftBrandCard from '~/lib/components/workspace/onboarding/DraftBrandCard.vue'
import LocationHoursCard from '~/lib/components/workspace/location/LocationHoursCard.vue'
import OnboardingChoiceGrid from '~/lib/components/workspace/onboarding/OnboardingChoiceGrid.vue'
import GooglePlacePicker from '~/lib/components/workspace/location/GooglePlacePicker.vue'
import OnboardingProductsCard from '~/lib/components/workspace/onboarding/OnboardingProductsCard.vue'
import OnboardingReviewCard from '~/lib/components/workspace/onboarding/OnboardingReviewCard.vue'
import { useOnboardingState, type OnboardingPlacePreview, type OnboardingStep } from '~/composables/useOnboardingFlow'
import { useOnboardingDraft } from '~/composables/useOnboardingDraft'
import { currencyForCountry } from '~/shared/currencies'
import { singleTimezoneForCountry } from '~/utils/timezone'
import type { OrganizationVertical } from '~/utils/vertical-copy'

/**
 * One step of the new-site flow, rendered.
 *
 * The screen owns the controls and nothing else: the shell owns the footer,
 * the server calls and where "next" goes.
 */
const props = defineProps<{ step: OnboardingStep }>()
const emit = defineEmits<{ advance: [] }>()

const state = useOnboardingState()

const VERTICAL_CHOICES = [
  { value: 'restaurant', label: 'Restaurant, café or bar', icon: 'i-lucide-utensils' },
  { value: 'experience', label: 'Experience or activity', icon: 'i-lucide-ticket' },
  { value: 'service', label: 'Professional services', icon: 'i-lucide-briefcase' },
]

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
// this step, and an answer already given is never overwritten. A country this
// platform has no supported currency for proposes nothing and the owner picks.
watch(() => props.step.id, (id) => {
  if (id !== 'currency' || state.value.details.currency) return
  state.value.details.currency = currencyForCountry(state.value.details.country)
}, { immediate: true })
</script>
