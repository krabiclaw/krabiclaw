<template>
  <!-- Airbnb's Change reservation: the dates and who is coming, saved once. -->
  <DashboardLeafPanel
    id="booking-dates"
    title="Change reservation"
    :saving="saving"
    :disabled="!draft || !dirty || draft.check_out_date <= draft.check_in_date || draft.adults < 1"
    save-label="Save"
    :error="failure"
    @save="save"
  >
    <template v-if="draft">
      <UFormField label="Check-in" required>
        <UInput v-model="draft.check_in_date" type="date" class="w-full" />
      </UFormField>
      <UFormField label="Checkout" required>
        <UInput v-model="draft.check_out_date" type="date" class="w-full" />
      </UFormField>
      <UFormField label="Adults" required>
        <UInputNumber v-model="draft.adults" :min="1" class="w-full" />
      </UFormField>
      <UFormField label="Children">
        <UInputNumber v-model="draft.children" :min="0" class="w-full" />
      </UFormField>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const b = inject(bookingEditorKey)!
const level = useRouteLevel()
const draft = ref<{ check_in_date: string; check_out_date: string; adults: number; children: number } | null>(null)
// The step opens on the stay as it is; it is read once, when the stay arrives.
watch(b.stayChange.stay, (stay) => { if (stay && !draft.value) draft.value = { ...stay } }, { immediate: true })
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(b.stayChange.stay.value))
const saving = ref(false)
const failure = ref('')

async function save() {
  if (saving.value || !draft.value) return
  saving.value = true
  failure.value = ''
  try {
    await b.stayChange.save(draft.value)
    await navigateTo(level.to.value ?? level.path.value)
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The reservation could not be changed')
  } finally {
    saving.value = false
  }
}
</script>
