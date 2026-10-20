<template>
  <!-- Read-only guest details are a description list, not a form: nothing to save. -->
  <DashboardLeafPanel id="booking-guest" :title="b.booking.value?.guestName ?? ''" :footer="false">
    <div v-if="b.booking.value" class="space-y-6">
      <dl class="space-y-4">
        <div>
          <dt class="text-sm text-muted">Email</dt>
          <dd class="mt-1 break-words text-highlighted">{{ b.booking.value.guestEmail }}</dd>
        </div>
        <div v-if="b.booking.value.guestPhone">
          <dt class="text-sm text-muted">Phone</dt>
          <dd class="mt-1 text-highlighted">{{ formatPhone(b.booking.value.guestPhone) }}</dd>
        </div>
      </dl>
      <div class="flex gap-3">
        <UButton :to="b.messageTo.value || undefined" label="Message" icon="i-lucide-message-circle" color="neutral" variant="soft" :disabled="!b.messageTo.value" />
        <UButton :to="b.callTo.value || undefined" label="Call" icon="i-lucide-phone" color="neutral" variant="soft" :disabled="!b.callTo.value" />
      </div>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'

definePageMeta({ layout: 'dashboard' })

const b = inject(bookingEditorKey)!
</script>
