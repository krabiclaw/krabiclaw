<template>
  <DashboardLeafPanel
    id="product-arrival-time"
    title="Check-in & checkout"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value || !checkInValid || !checkInEndValid || !checkOutValid"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert('arrival-time')"
    @save="p.save(level.to.value ?? undefined, 'arrival-time')"
  >
    <div v-if="p.product.value && !p.loadError.value" class="space-y-8">
      <fieldset class="space-y-4">
        <legend class="text-base font-medium text-highlighted">Check-in window</legend>
        <UFormField label="Start time" :error="checkInValid ? undefined : 'Choose a check-in start time.'" required>
          <UInput v-model="p.form.check_in_time" type="time" :disabled="p.saving.value" class="w-full" />
        </UFormField>
        <UFormField label="End time" :error="checkInEndValid ? undefined : 'Choose an end time other than the start, or Flexible.'">
          <StayCheckInEndSelect v-model="p.form.check_in_end_time" :disabled="p.saving.value" />
        </UFormField>
      </fieldset>
      <fieldset class="space-y-4">
        <legend class="text-base font-medium text-highlighted">Checkout</legend>
        <UFormField label="Time" :error="checkOutValid ? undefined : 'Choose a checkout time.'" required>
          <UInput v-model="p.form.check_out_time" type="time" :disabled="p.saving.value" class="w-full" />
        </UFormField>
      </fieldset>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import StayCheckInEndSelect from '~/components/dashboard/StayCheckInEndSelect.vue'
import { MINUTE_TIME_PATTERN } from '~/utils/timezone'

const p = inject(productEditorKey)!
const level = useRouteLevel()
const checkInValid = computed(() => MINUTE_TIME_PATTERN.test(p.form.check_in_time))
const checkInEndValid = computed(() => p.form.check_in_end_time === '' || (MINUTE_TIME_PATTERN.test(p.form.check_in_end_time) && p.form.check_in_end_time !== p.form.check_in_time))
const checkOutValid = computed(() => MINUTE_TIME_PATTERN.test(p.form.check_out_time))
watchEffect(() => {
  if (p.product.value && !p.loadError.value && p.product.value.kind !== 'stay') showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
onBeforeRouteLeave(() => p.revert('arrival-time'))
</script>
