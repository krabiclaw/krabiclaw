<template>
  <!--
    The record's summary, a level under the conversation. Changing it, a note,
    the guest — those are levels under the record's own URL, which the rows link
    into, so the editors exist once here and once there.
  -->
  <DashboardLeafPanel v-if="stayId" id="thread-record" :title="recordTitle" :footer="false">
    <StayDetails :stay-id="stayId" embedded />
  </DashboardLeafPanel>
  <DashboardLeafPanel v-else-if="bookingType && bookingConversationId" id="thread-record" :title="recordTitle" :footer="false">
    <BookingDetails
      :booking-type="bookingType"
      :booking-id="bookingConversationId"
      :editor-path="`/dashboard/${String(route.params.org_slug)}/bookings/${bookingType}/${encodeURIComponent(bookingConversationId)}`"
      embedded
    />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import BookingDetails from '~/components/dashboard/BookingDetails.vue'
import StayDetails from '~/components/dashboard/StayDetails.vue'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const threadId = computed(() => String(route.params.conversation_id))

// Airbnb's Reservation pane: the record the conversation is about, read from
// the thread. A conversation with no record has no level here.
const { thread } = await useGuestThread(threadId)
if (thread.value && !thread.value.booking_id) {
  showError(createError({ statusCode: 404, statusMessage: 'This conversation has no reservation' }))
}
// A stay is shown by its own record screen, keyed by the stay; a booking or reservation by its conversation.
const stayId = computed(() => thread.value?.record_kind === 'stay' ? thread.value.booking_id : null)
const bookingType = computed(() => thread.value?.record_kind === 'booking' ? thread.value.record_kind : null)
const bookingConversationId = computed(() => bookingType.value ? threadId.value : null)
const recordTitle = computed(() => thread.value?.record_title ?? 'Reservation')

useSeoMeta({ title: 'Reservation | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
