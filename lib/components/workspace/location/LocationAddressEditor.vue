<template>
  <DashboardLeafPanel
    id="location-address"
    title="Address"
    :lead="lead"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value && !(navigationError && !editor.dirty.value)"
    :error="[editor.editorError.value, navigationError].filter(Boolean).join(' ')"
    desktop-cancel
    @cancel="editor.revert"
    @save="save"
  >
    <UAlert v-if="editor.error.value" class="mb-6" color="error" variant="soft" :description="editor.error.value" />
    <div class="space-y-5">
      <div class="divide-y divide-default overflow-hidden rounded-xl border border-default">
        <UFormField v-for="(line, index) in addressLines" :key="index" :label="index === 0 ? 'Street address' : index === 1 ? 'Apt, suite, unit' : `Address line ${index + 1}`" :ui="{ label: 'text-xs font-normal text-muted' }" class="px-4 py-3 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary">
          <UInput :model-value="line" :autofocus="index === 0" :disabled="editor.saving.value" variant="none" :ui="{ base: 'px-0 py-0' }" class="w-full" @update:model-value="updateLine(index, $event)" />
        </UFormField>
        <UFormField label="Neighbourhood" :ui="{ label: 'text-xs font-normal text-muted' }" class="px-4 py-3 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary"><UInput v-model="editor.detailsForm.sublocality" :disabled="editor.saving.value" variant="none" :ui="{ base: 'px-0 py-0' }" class="w-full" /></UFormField>
        <UFormField label="City or town" :ui="{ label: 'text-xs font-normal text-muted' }" class="px-4 py-3 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary"><UInput v-model="editor.detailsForm.locality" :disabled="editor.saving.value" variant="none" :ui="{ base: 'px-0 py-0' }" class="w-full" /></UFormField>
        <UFormField label="State or territory" :ui="{ label: 'text-xs font-normal text-muted' }" class="px-4 py-3 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary"><UInput v-model="editor.detailsForm.administrativeArea" :disabled="editor.saving.value" variant="none" :ui="{ base: 'px-0 py-0' }" class="w-full" /></UFormField>
        <UFormField label="Postal code" :ui="{ label: 'text-xs font-normal text-muted' }" class="px-4 py-3 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary"><UInput v-model="editor.detailsForm.postalCode" :disabled="editor.saving.value" variant="none" :ui="{ base: 'px-0 py-0' }" class="w-full" /></UFormField>
        <UFormField label="Country" :ui="{ label: 'text-xs font-normal text-muted' }" class="px-4 py-3 focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary">
          <div class="flex items-center gap-2">
            <USelectMenu
              v-model="countryCode"
              :items="countries"
              value-key="code"
              label-key="name"
              aria-label="Country"
              class="min-w-0 flex-1"
              variant="none"
              :ui="{ base: 'ps-0 py-0' }"
              :disabled="editor.saving.value"
              placeholder="Select country"
              :search-input="{ placeholder: 'Search country...' }"
              :filter-fields="['name', 'code']"
            />
            <UButton v-if="countryCode" icon="i-lucide-x" aria-label="Clear country" color="neutral" variant="link" :disabled="editor.saving.value" @click="countryCode = undefined" />
          </div>
        </UFormField>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-4">
        <UButton color="neutral" variant="link" class="px-0" :disabled="editor.saving.value" @click="addLine">Add address line</UButton>
        <UButton color="neutral" variant="link" class="px-0" :disabled="editor.saving.value" @click="clearAddress">Clear address</UButton>
      </div>
    </div>
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'
import { getPhoneCountry, listPhoneCountries, type CountryCode } from '~/utils/phone'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ organizationId: string; locationId: string; lead?: string; saveTo?: string }>()
const editor = await useLocationEditor(props.organizationId, computed(() => props.locationId), 'address')
const navigationError = ref('')
const countries = listPhoneCountries()
const countryCode = computed({
  get: () => getPhoneCountry(editor.detailsForm.regionCode)?.code,
  set: (value: CountryCode | null | undefined) => { editor.detailsForm.regionCode = value ?? '' },
})
const addressLines = computed(() => {
  const lines = editor.detailsForm.addressLines.split('\n')
  return lines.length < 2 ? [...lines, ''] : lines
})

function updateLine(index: number, value: string | number | null | undefined) {
  const lines = [...addressLines.value]
  lines[index] = String(value ?? '')
  editor.detailsForm.addressLines = lines.join('\n')
}

function addLine() {
  editor.detailsForm.addressLines = [...addressLines.value, ''].join('\n')
}

function clearAddress() {
  editor.detailsForm.addressLines = ''
  editor.detailsForm.regionCode = ''
  editor.detailsForm.locality = ''
  editor.detailsForm.sublocality = ''
  editor.detailsForm.administrativeArea = ''
  editor.detailsForm.postalCode = ''
}

async function save() {
  if ((!navigationError.value || editor.dirty.value) && await editor.save() !== true) return
  navigationError.value = ''
  if (!props.saveTo) return
  try {
    const result = await navigateTo(props.saveTo)
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    navigationError.value = getErrorMessage(error, 'The address was saved, but the editor could not be closed.')
  }
}
</script>
