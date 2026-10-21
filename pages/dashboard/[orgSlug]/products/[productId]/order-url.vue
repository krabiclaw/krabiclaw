<template>
  <DashboardLeafPanel
    id="product-order-url"
    :desktop-cancel="!p.isNew.value"
    :title="p.sectionLabels['order-url']"
    lead="Customers continue to this website to order or book. Adding a link replaces the booking action on your website."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || p.photoError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <template v-if="p.isNew.value || p.product.value">
      <UFormField label="Website address" hint="Optional">
        <UInput v-model="p.form.order_url" type="url" placeholder="https://…" class="w-full" />
      </UFormField>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
</script>
