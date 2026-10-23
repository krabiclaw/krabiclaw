<template>
  <DashboardLeafPanel id="product-visibility" :title="isStay ? 'Listing status' : 'Status'" :lead="isStay ? undefined : `Choose whether ${legal ? 'clients' : 'customers'} can see this offering on your website.`" :saving="p.saving.value" :disabled="p.saveDisabled.value || (!p.saveError.value && p.form.published === p.published.value)" :save-label="p.saveLabel.value" :error="p.loadError.value || p.saveError.value || ''" :desktop-cancel="isStay" @cancel="p.revert" @save="p.save(level.to.value ?? undefined, 'publication-visibility')">
    <URadioGroup
      v-if="isStay && !p.loadError.value"
      v-model="status"
      :items="[{ value: 'listed', label: 'Listed', description: 'Your listing is visible on your website.' }, { value: 'unlisted', label: 'Unlisted', description: 'Your listing is hidden from your website.' }]"
      aria-label="Listing status"
      :disabled="p.saving.value"
      variant="card"
      indicator="hidden"
      color="neutral"
      class="w-full"
    />
    <SettingRow v-else-if="p.product.value && !p.loadError.value" v-model="p.form.published" label="Published" :description="`${legal ? 'Clients' : 'Customers'} can find this offering on your website.`" :disabled="p.saving.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const isStay = computed(() => p.product.value?.kind === 'stay')
const legal = computed(() => p.product.value?.kind === 'service')
const status = computed({
  get: () => p.form.published ? 'listed' : 'unlisted',
  set: (value: string) => { if (!p.saving.value && (value === 'listed' || value === 'unlisted')) p.form.published = value === 'listed' },
})
onBeforeRouteLeave(() => p.revert())
</script>
