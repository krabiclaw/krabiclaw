<template>
  <DashboardLeafPanel
    v-if="snapshot"
    id="booking-private-note"
    title="Private note"
    lead="Only your team can see this note."
    desktop-cancel
    :saving="saving"
    :disabled="!dirty || draft.length > noteLimit"
    :error="failure"
    @save="save"
  >
    <UTextarea
      v-model="draft"
      aria-label="Private note"
      placeholder="Add a note for your team"
      :rows="5"
      :maxlength="noteLimit"
      :disabled="saving"
      class="w-full"
    />
    <p class="mt-2 text-right text-sm text-muted">{{ draft.length }}/{{ noteLimit }}</p>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'
import { getErrorMessage, showNotFound } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const editor = inject(bookingEditorKey, null)
const level = useRouteLevel()
const record = editor?.booking.value
const snapshot = record?.type === 'booking' && record.unit === 'slot' && record.booking_id && record.version !== null
  ? { id: record.booking_id, version: record.version, text: record.private_notes ?? '' }
  : null
if (!snapshot) showNotFound('This reservation has no private note editor')

const noteLimit = 2000
const draft = ref(snapshot?.text ?? '')
const dirty = computed(() => draft.value.trim() !== snapshot?.text.trim())
const saving = ref(false)
const failure = ref('')

async function save() {
  if (!editor || !snapshot || saving.value || !dirty.value || draft.value.length > noteLimit) return
  saving.value = true
  failure.value = ''
  try {
    const backTo = level.to.value
    if (!backTo || editor.booking.value?.booking_id !== snapshot.id) throw new Error('The reservation is no longer available')
    await editor.savePrivateNote({ id: snapshot.id, version: snapshot.version, text: draft.value })
    await navigateTo(backTo, { replace: true })
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The private note could not be saved')
  } finally {
    saving.value = false
  }
}
</script>
