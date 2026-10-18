<template>
  <DashboardLeafPanel
    id="product-arrival-time"
    title="Check-in & checkout"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value || !checkInValid || !checkOutValid"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert('arrival-time')"
    @save="p.save(level.to.value ?? undefined, 'arrival-time')"
  >
    <div v-if="p.product.value && !p.loadError.value" class="space-y-8">
      <UFormField label="Check-in from" :error="checkInValid ? undefined : 'Choose a check-in time.'" required>
        <UInput v-model="p.form.check_in_time" type="time" :disabled="p.saving.value" class="w-full" />
      </UFormField>
      <UFormField label="Checkout by" :error="checkOutValid ? undefined : 'Choose a checkout time.'" required>
        <UInput v-model="p.form.check_out_time" type="time" :disabled="p.saving.value" class="w-full" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { MINUTE_TIME_PATTERN } from '~/utils/timezone'

const p = inject(productEditorKey)!
const level = useRouteLevel()
const checkInValid = computed(() => MINUTE_TIME_PATTERN.test(p.form.check_in_time))
const checkOutValid = computed(() => MINUTE_TIME_PATTERN.test(p.form.check_out_time))
watchEffect(() => {
  if (p.product.value && !p.loadError.value && p.product.value.kind !== 'stay') showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
onBeforeRouteLeave(() => p.revert('arrival-time'))
</script>
