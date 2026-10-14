<template>
  <DashboardLeafPanel
    id="product-order-url"
    :title="p.sectionLabels['order-url']"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || p.photoError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <template v-if="p.isNew.value || p.product.value">
      <p v-if="p.form.kind === 'stay'" class="mb-6 text-base text-muted">Guests book this place here, such as its Airbnb listing. A place to stay is shown on your website only with this link.</p>
      <p v-else class="mb-6 text-base text-muted">Customers continue to this website to order or book. Adding a link replaces the booking action on your website.</p>
      <UFormField label="Website address">
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
