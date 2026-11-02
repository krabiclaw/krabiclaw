<template>
  <DashboardLeafPanel
    id="organization-currency"
    title="Currency"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <USelectMenu :model-value="editor.form.default_currency ?? undefined" :items="CURRENCY_OPTIONS" value-key="value" label-key="label" class="w-full" placeholder="Select currency" @update:model-value="editor.form.default_currency = ($event as CurrencyCode | undefined) ?? null" />
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { CURRENCY_OPTIONS, type CurrencyCode } from '~/shared/currencies'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
</script>
