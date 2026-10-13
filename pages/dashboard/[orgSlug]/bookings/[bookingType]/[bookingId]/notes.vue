<template>
  <!--
    Your team's notes on this record: the ones written, each a leaf below, and
    the one being written, which this level's own footer saves.
  -->
  <DashboardIndexPanel id="booking-notes" title="Your notes" lead="Only your team can see these notes." column>
    <div class="space-y-6">
      <UAlert v-if="b.noteError.value" color="error" variant="soft" icon="i-lucide-circle-alert" :description="b.noteError.value" />
      <UFormField label="New note">
        <UTextarea v-model="b.noteDraft.value" :rows="6" maxlength="2000" class="w-full" placeholder="Add a note to yourself" />
      </UFormField>
      <div v-if="b.booking.value?.notes.length" class="divide-y divide-default border-t border-default">
        <NuxtLink
          v-for="note in b.booking.value.notes"
          :key="note.id"
          :to="`${level.path.value}/${note.id}`"
          class="block py-3"
          :aria-label="`Edit note: ${note.body}`"
        >
          <span class="block whitespace-pre-wrap text-sm text-highlighted">{{ note.body }}</span>
          <span class="block text-xs text-dimmed">{{ b.formatCreatedAt(note.createdAt) }}</span>
        </NuxtLink>
      </div>
    </div>

    <template #footer>
      <DashboardPanelFooter column :loading="b.noteSaving.value" :disabled="!b.noteDraft.value.trim()" @cancel="cancel" @save="save" />
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'

definePageMeta({ layout: 'dashboard' })

const level = useRouteLevel()
const b = inject(bookingEditorKey)!

// This level writes a new note; a leaf below edits an existing one.
b.openNote(null)

async function save() {
  if (await b.saveNote()) b.openNote(null)
}

function cancel() {
  b.openNote(null)
  return navigateTo(level.to.value ?? '/dashboard')
}
</script>
