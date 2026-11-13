<template>
  <div class="flex min-h-0 flex-col gap-6" :data-onboarding-step="step.id" data-onboarding-hydrated="true">
    <div
      v-if="step.id === 'type'"
      class="flex flex-col gap-6 md:gap-8"
    >
      <figure v-if="websiteExample" class="flex items-center justify-center bg-[var(--kc-coral-50)] px-8 py-6 md:py-9">
        <div class="w-full max-w-[15rem] overflow-hidden rounded-2xl bg-white p-2 text-slate-900 shadow-xl md:max-w-[27rem] md:p-3">
          <img
            :src="websiteExample.image"
            alt=""
            class="aspect-[3/2] w-full rounded-xl object-cover object-top"
            fetchpriority="high"
          >
          <figcaption class="truncate px-2 py-2 text-sm font-semibold md:py-3" aria-live="polite">
            {{ websiteExample.name }}
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

    <div v-else-if="step.id === 'business'" class="flex flex-col gap-3">
      <template v-if="!googleImport">
        <UFormField :label="fieldLabel('name')" required>
          <UInput :model-value="state.details.name" class="w-full" size="lg" autocomplete="organization" @update:model-value="setBusinessName" />
        </UFormField>
        <UButton v-if="plan" type="button" :label="plan.businessLookup.importLabel" color="neutral" variant="link" class="self-start px-0" @click="googleImport = true" />
      </template>
      <template v-else-if="plan">
        <GooglePlacePicker v-model="businessSearch" :placeholder="plan.businessLookup.searchPlaceholder" @select="choosePlace" />
        <UButton type="button" :label="plan.businessLookup.manualLabel" color="neutral" variant="link" class="self-start px-0" @click="enterManually" />
      </template>
      <UFormField v-if="!googleImport && fieldLabel('subdomain')" :label="fieldLabel('subdomain')"
        :hint="plan?.includedDomain ? `.${plan.includedDomain}` : undefined" :error="plan?.subdomainError"
        :description="field('subdomain')?.description" required>
        <UInput v-model="state.subdomain" class="w-full" size="lg" maxlength="63" autocapitalize="none" :spellcheck="false" />
      </UFormField>
    </div>

    <template v-else-if="step.id === 'location'">
      <OnboardingAddressFields
        :fields="addressFields"
        :countries="plan?.countries ?? []"
        @answer="setAddress"
      />
      <LocationTimezoneField v-if="fieldLabel('timezone')" v-model="timezone" :items="plan?.timezones" :label="fieldLabel('timezone')" />
    </template>

    <LocationTimezoneField v-else-if="step.id === 'timezone'" v-model="timezone" :items="plan?.timezones" :label="fieldLabel('timezone')" />

    <div v-else-if="step.id === 'language'" role="group" :aria-label="fieldLabel('sourceLocale')">
      <p v-if="state.languageLocked && selectedLanguage">{{ selectedLanguage.label }}</p>
      <OnboardingChoiceGrid
        v-else
        :choices="plan?.languages ?? []"
        :model-value="state.details.sourceLocale"
        @update:model-value="state.details.sourceLocale = $event"
      />
    </div>

    <UFormField v-else-if="step.id === 'currency'" :label="fieldLabel('currency')" required>
      <USelectMenu
        :model-value="state.details.currency ?? plan?.proposedCurrency ?? undefined"
        :items="plan?.currencies ?? []"
        :filter-fields="['label', 'value']"
        value-key="value"
        placeholder="Select currency"
        class="w-full"
        size="lg"
        @update:model-value="state.details.currency = isCurrencyCode($event) ? $event : null"
      />
    </UFormField>
  </div>
</template>

<script setup lang="ts">
import OnboardingAddressFields from '~/lib/components/workspace/onboarding/OnboardingAddressFields.vue'
import OnboardingChoiceGrid from '~/lib/components/workspace/onboarding/OnboardingChoiceGrid.vue'
import GooglePlacePicker from '~/lib/components/workspace/location/GooglePlacePicker.vue'
import LocationTimezoneField from '~/lib/components/workspace/location/LocationTimezoneField.vue'
import { useOnboardingPlan, useOnboardingState, type OnboardingPlacePreview } from '~/composables/useOnboardingFlow'
import { useOnboardingDraft } from '~/composables/useOnboardingDraft'
import type { OnboardingStep, OnboardingStepField } from '~/shared/onboarding-flow'
import { isCurrencyCode } from '~/shared/currencies'

const props = defineProps<{ step: OnboardingStep }>()
const state = useOnboardingState()
const plan = useOnboardingPlan()
const { seedFromPlace } = useOnboardingDraft()
const websiteExample = computed(() => plan.value?.businessTypes.find(choice => choice.value === state.value.vertical)?.example ?? plan.value?.neutralWebsiteExample)
const selectedLanguage = computed(() => plan.value?.languages.find(choice => choice.value === state.value.details.sourceLocale))

const field = (key: OnboardingStepField['key']) => props.step.fields.find(field => field.key === key)
const fieldLabel = (key: OnboardingStepField['key']) => field(key)?.label
const addressKeys = ['country', 'streetAddress', 'addressLine2', 'city', 'region', 'postalCode'] as const
type AddressKey = typeof addressKeys[number]
const isAddressKey = (key: string): key is AddressKey => addressKeys.some(candidate => candidate === key)
const addressFields = computed(() => props.step.fields.flatMap(field => isAddressKey(field.key)
  ? [{ ...field, value: state.value.details[field.key], required: field.key === 'country' }]
  : []))

function selectVertical(value: string) {
  const choice = plan.value?.businessTypes.find(option => option.value === value)
  if (choice) state.value.vertical = choice.value
}

const businessSearch = ref('')
const googleImport = ref(false)
watch(() => props.step.id, (id) => {
  if (id !== 'business') return
  businessSearch.value = state.value.details.name
  state.value.source ??= 'manual'
}, { immediate: true })

function choosePlace(place: OnboardingPlacePreview) {
  seedFromPlace(place)
  googleImport.value = false
}

function setBusinessName(value: string | number | undefined) {
  state.value.details.name = String(value ?? '')
}

function enterManually() {
  googleImport.value = false
  state.value.source = 'manual'
  state.value.placeId = null
  setBusinessName(businessSearch.value.trim())
}

function setAddress(key: string, value: string) {
  if (!isAddressKey(key) || state.value.details[key] === value) return
  state.value.details[key] = value
  if (key === 'country') {
    state.value.timezone = ''
    state.value.timezoneStepVisited = false
  }
}

const timezone = computed({
  get: () => state.value.timezone || plan.value?.proposedTimezone || '',
  set: (value) => {
    state.value.timezone = value
    if (props.step.id === 'location') state.value.timezoneStepVisited = false
  },
})
</script>
