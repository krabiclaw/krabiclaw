<template>
  <DashboardLeafPanel
    id="location-product-category-name"
    title="Name"
    :saving="c.saving.value"
    :disabled="c.saveDisabled.value"
    :save-label="c.saveLabel.value"
    :error="c.errorMessage.value"
    @cancel="c.revert"
    @save="c.save"
  >
    <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/120 available</p>
    <UInput v-model="c.form.name" aria-label="Name" placeholder="Starters" maxlength="120" autofocus class="w-full" />
    <DashboardResourceLocalization
      v-if="!c.isNew.value && c.hasRecord.value"
      class="mt-6"
      :organization-id="c.organizationId"
      resource-type="collection"
      :resource-id="c.collectionId.value"
      resource-label="section"
      :fields="c.localizationFields.value"
      :language-settings-path="c.organizationLocalizationSettingsPath.value"
    />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import { collectionEditorKey } from '../[collectionId].vue'

definePageMeta({ layout: 'dashboard' })

const c = inject(collectionEditorKey)!
const charactersRemaining = computed(() => 120 - (c.form.name?.length ?? 0))
</script>
