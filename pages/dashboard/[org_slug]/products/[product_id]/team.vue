<template>
  <DashboardLeafPanel
    id="product-team"
    :title="p.sectionLabels.team"
    lead="Choose the host responsible for this home’s stays and guest conversations."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <ResponsibilityPicker v-if="p.isNew.value || p.product.value" v-model:member-id="p.form.stay_member_id" :organization-id="p.organizationId" :disabled="p.saving.value" required />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import ResponsibilityPicker from '~/components/dashboard/ResponsibilityPicker.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
</script>
