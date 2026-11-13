<template>
  <div class="grid gap-4">
    <UFormField
      v-if="countryField"
      :label="countryField.label"
      :required="countryField.required"
      class="rounded-xl border border-accented px-4 py-2 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary"
      :ui="{ label: 'text-xs font-normal text-muted' }"
    >
      <CountrySelect
        :model-value="countryCode"
        :items="countries"
        class="w-full"
        :aria-label="countryField.label"
        variant="none"
        placeholder="Select country"
        :search-input="{ placeholder: 'Search country...', icon: 'i-lucide-search' }"
        :filter-fields="['name', 'code', 'dialCode']"
        :ui="{ base: ['min-h-8 py-0 pe-8 text-base', countryCode ? 'ps-7' : 'ps-0'], leading: 'ps-0' }"
        @update:model-value="emit('answer', countryField.key, $event ?? '')"
      />
    </UFormField>
    <div class="divide-y divide-accented overflow-hidden rounded-xl border border-accented">
      <UFormField
        v-for="field in addressFields"
        :key="field.key"
        :label="field.label"
        :required="field.required"
        class="px-4 py-2 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary"
        :ui="{ label: 'text-xs font-normal text-muted' }"
      >
        <UInput
          :model-value="field.value"
          :aria-label="field.label"
          :autocomplete="autocomplete[field.key]"
          class="w-full"
          variant="none"
          :ui="{ base: 'min-h-8 px-0 py-0 text-base' }"
          @update:model-value="emit('answer', field.key, String($event ?? ''))"
        />
      </UFormField>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  fields: { key: string; label: string; value: string; required?: boolean }[]
  countries: { code: string; name: string; dialCode?: string }[]
}>()
const emit = defineEmits<{ answer: [key: string, value: string] }>()

const autocomplete: Record<string, string> = {
  streetAddress: 'address-line1',
  street_address: 'address-line1',
  addressLine2: 'address-line2',
  address_line_2: 'address-line2',
  city: 'address-level2',
  region: 'address-level1',
  postalCode: 'postal-code',
  postal_code: 'postal-code',
}
const countryCode = computed(() => props.countries.find(country => country.code === countryField.value?.value)?.code)
const countryField = computed(() => props.fields.find(field => field.key === 'country'))
const addressFields = computed(() => props.fields.filter(field => Object.hasOwn(autocomplete, field.key)))
</script>
