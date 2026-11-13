<template>
  <div class="grid gap-4">
    <UFormField
      :label="countryField?.label"
      required
      class="rounded-xl border border-accented px-4 py-2 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary"
      :ui="{ label: 'text-xs font-normal text-muted' }"
    >
      <CountrySelect
        :model-value="countryCode"
        :items="countries"
        class="w-full"
        :aria-label="countryField?.label"
        variant="none"
        placeholder="Select country"
        :search-input="{ placeholder: 'Search country...', icon: 'i-lucide-search' }"
        :filter-fields="['name', 'code', 'dialCode']"
        :ui="{ base: ['min-h-8 py-0 pe-8 text-base', countryCode ? 'ps-7' : 'ps-0'], leading: 'ps-0' }"
        @update:model-value="emit('changeCountry', $event ?? '')"
      />
    </UFormField>
    <div class="divide-y divide-accented overflow-hidden rounded-xl border border-accented">
      <UFormField
        v-for="field in addressFields"
        :key="field.key"
        :label="field.label"
        class="px-4 py-2 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary"
        :ui="{ label: 'text-xs font-normal text-muted' }"
      >
        <UInput
          v-model="form[field.key]"
          :autocomplete="autocomplete[field.key]"
          class="w-full"
          variant="none"
          :ui="{ base: 'min-h-8 px-0 py-0 text-base' }"
        />
      </UFormField>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getPhoneCountry, listPhoneCountries } from '~/utils/phone'
import type { OnboardingFlowState } from '~/composables/useOnboardingFlow'
import type { OnboardingStepField } from '~/shared/onboarding-flow'

const props = defineProps<{ fields: OnboardingStepField[] }>()
const form = defineModel<OnboardingFlowState['details']>('form', { required: true })
const emit = defineEmits<{ changeCountry: [value: string] }>()

const autocomplete = {
  streetAddress: 'address-line1',
  addressLine2: 'address-line2',
  city: 'address-level2',
  region: 'address-level1',
  postalCode: 'postal-code',
} as const
const countries = listPhoneCountries()
const countryCode = computed(() => getPhoneCountry(form.value.country)?.code)
const countryField = computed(() => props.fields.find(field => field.key === 'country'))
const addressFields = computed(() => props.fields.filter(
  (field): field is OnboardingStepField & { key: keyof typeof autocomplete } => Object.hasOwn(autocomplete, field.key),
))
</script>
