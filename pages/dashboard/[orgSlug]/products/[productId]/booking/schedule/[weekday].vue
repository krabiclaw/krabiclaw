<template>
  <DashboardLeafPanel :id="`booking-schedule-${route.params.weekday}`" :title="day?.label ?? ''" :lead="lead" :saving="p.saving.value" :disabled="!p.product.value || !valid || !dirty || Boolean(scopeError || p.scheduleError.value)" :error="p.loadError.value ?? p.saveError.value ?? scopeError ?? p.scheduleError.value ?? ''" @cancel="p.revert" @save="save">
    <UButton v-if="scopeError" :to="chooseLocationPath" color="neutral" variant="outline">Choose a location</UButton>
    <div v-else-if="day && p.product.value" class="space-y-4">
      <div v-for="(slot, index) in slots" :key="index" class="flex items-end gap-3">
        <UFormField :label="`Start time ${index + 1}`" class="flex-1">
          <UInput v-model="slot.start_time" type="time" step="60" class="w-full" />
        </UFormField>
        <UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" :aria-label="`Remove start time ${index + 1}`" @click="p.removeSlot(slot)" />
      </div>
      <UButton icon="i-lucide-plus" color="neutral" variant="outline" label="Add a start time" @click="p.addSlot(day.value)" />
    </div>
    <UButton v-if="p.saveError.value" class="mt-6" color="neutral" variant="outline" :loading="recovering" @click="useSavedSchedule">Use saved values</UButton>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { MINUTE_TIME_PATTERN, timezoneLabel } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const chooseLocationPath = computed(() => router.resolve({ path: router.resolve(p.sectionPath('booking/schedule')).path, query: { ...route.query, location_id: undefined } }).fullPath)
const day = computed(() => p.weekdays.find(day => day.label.toLowerCase() === route.params.weekday))
const slots = computed(() => day.value ? p.slotsFor(day.value.value) : [])
const scopeError = computed(() => !p.locationId.value || p.location.value?.status !== 'active' ? 'Choose an active physical location in Weekly schedule before editing start times.' : null)
const lead = computed(() => `Choose when sessions start${p.location.value ? ` in ${timezoneLabel(p.location.value.timezone)}` : ''}. Removing a time leaves appointments with booking history unchanged.`)
const valid = computed(() => slots.value.every(slot => MINUTE_TIME_PATTERN.test(slot.start_time)) && new Set(slots.value.map(slot => slot.start_time)).size === slots.value.length)
const dirty = computed(() => day.value && JSON.stringify(slots.value) !== JSON.stringify(p.savedSlotsFor(day.value.value)))
const recovering = ref(false)
async function useSavedSchedule() {
  recovering.value = true
  try {
    await p.reloadSchedule()
    p.revert()
  } catch (error) { p.saveError.value = getErrorMessage(error, 'The saved schedule could not be loaded') }
  finally { recovering.value = false }
}
watchEffect(() => {
  if (level.mode.value !== 'yield' && (!day.value || (p.product.value && !p.loadError.value && !p.product.value.booking))) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
watch(() => route.params.weekday, () => p.revert())
onBeforeRouteLeave(() => { p.revert() })
function save() { if (day.value && !scopeError.value) return p.save(level.to.value ?? undefined, day.value.value) }
</script>
