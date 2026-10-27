<template>
  <DashboardLeafPanel
    id="booking-note"
    title="Edit note"
    lead="Only your team can see these notes."
    :saving="b.noteSaving.value"
    :disabled="!b.noteDraft.value.trim() || b.noteDraft.value === b.selectedNote.value?.body"
    :error="b.noteError.value ?? ''"
    @save="save"
  >
    <div class="space-y-6">
      <UFormField label="Note">
        <UTextarea v-model="b.noteDraft.value" :disabled="b.noteSaving.value" :rows="10" maxlength="2000" autofocus class="w-full" placeholder="Add a note to yourself" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const b = inject(bookingEditorKey)!
// The draft points at this note for as long as this leaf is open.
let ownedNoteId = ''
watch(() => route.params.noteId, (noteId) => {
  if (typeof noteId !== 'string' || !noteId) return
  ownedNoteId = noteId
  b.openNote(noteId)
}, { immediate: true })
onUnmounted(() => {
  if (b.selectedNote.value?.id === ownedNoteId) b.openNote(null)
})
// A note that is not there is not a page.
watchEffect(() => {
  if (typeof route.params.noteId === 'string' && route.params.noteId && b.booking.value && !b.selectedNote.value) showError(createError({ statusCode: 404, statusMessage: 'Note not found' }))
})

async function save() {
  if (await b.saveNote()) await navigateTo(level.to.value ?? '/dashboard')
}
</script>
