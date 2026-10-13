<template>
  <DashboardLeafPanel :id="`booking-schedule-${route.params.weekday}`" :title="day?.label ?? ''" :lead="lead" :saving="p.saving.value" :disabled="!p.product.value || !valid || !dirty || Boolean(p.scheduleError.value)" :error="p.loadError.value ?? p.saveError.value ?? p.scheduleError.value ?? ''" @cancel="p.revert" @save="save">
    <div v-if="day && p.product.value" class="space-y-4">
      <div v-for="(slot, index) in slots" :key="index" class="flex items-end gap-3">
        <UFormField :label="`Start time ${index + 1}`" class="flex-1">
          <UInput v-model="slot.start_time" type="time" step="60" class="w-full" />
        </UFormField>
        <UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" :aria-label="`Remove start time ${index + 1}`" @click="p.removeSlot(slot)" />
      </div>
      <UButton icon="i-lucide-plus" color="neutral" variant="outline" label="Add a start time" @click="p.addSlot(day.value)" />
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { MINUTE_TIME_PATTERN, timezoneLabel } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const day = computed(() => p.weekdays.find(day => day.label.toLowerCase() === route.params.weekday))
const slots = computed(() => day.value ? p.slotsFor(day.value.value) : [])
const lead = computed(() => `Choose when sessions start${p.location.value ? ` in ${timezoneLabel(p.location.value.timezone)}` : ''}. Removing a time leaves appointments with booking history unchanged.`)
const valid = computed(() => slots.value.every(slot => MINUTE_TIME_PATTERN.test(slot.start_time)) && new Set(slots.value.map(slot => slot.start_time)).size === slots.value.length)
const dirty = computed(() => day.value && JSON.stringify(slots.value) !== JSON.stringify(p.savedSlotsFor(day.value.value)))
watchEffect(() => {
  if (level.mode.value !== 'yield' && (!day.value || (p.product.value && !p.loadError.value && !p.product.value.booking))) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
watch(() => route.params.weekday, () => p.revert())
onBeforeRouteLeave(() => { p.revert() })
function save() { if (day.value) return p.save(level.to.value ?? undefined, day.value.value) }
</script>
