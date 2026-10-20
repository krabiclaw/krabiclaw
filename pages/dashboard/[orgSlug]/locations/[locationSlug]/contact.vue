<template>
  <DashboardLeafPanel
    id="location-contact"
    title="Contact"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <div class="space-y-6">
      <UFormField label="Phone"><PhoneInput id="location-phone" autofocus v-model="editor.detailsForm.phone" :default-country="getPhoneCountry(editor.detailsForm.regionCode)?.code" /></UFormField>
      <UFormField label="Email"><UInput v-model="editor.detailsForm.email" type="email" class="w-full" /></UFormField>
    </div>
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import PhoneInput from '~/components/PhoneInput.vue'
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'
import { getPhoneCountry } from '~/utils/phone'

definePageMeta({ layout: 'dashboard' })

const dashboardLocation = useDashboardLocation()
const organizationId = await useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, 'contact')
</script>
