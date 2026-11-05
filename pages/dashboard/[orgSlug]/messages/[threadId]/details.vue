<template>
  <!--
    The record's summary, a level under the conversation. Changing it, a note,
    the guest — those are levels under the record's own URL, which the rows link
    into, so the editors exist once here and once there.
  -->
  <DashboardLeafPanel v-if="stayId" id="thread-record" :title="recordTitle" :footer="false">
    <StayDetails :stay-id="stayId" embedded />
  </DashboardLeafPanel>
  <DashboardLeafPanel v-else-if="bookingType && bookingId" id="thread-record" :title="recordTitle" :footer="false">
    <BookingDetails
      :booking-type="bookingType"
      :booking-id="bookingId"
      :editor-path="`/dashboard/${String(route.params.orgSlug)}/bookings/${bookingType}/${encodeURIComponent(bookingId)}`"
      embedded
    />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import BookingDetails from '~/components/dashboard/BookingDetails.vue'
import StayDetails from '~/components/dashboard/StayDetails.vue'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const threadId = computed(() => String(route.params.threadId))

// Airbnb's Reservation pane: the record the conversation is about, read from
// the thread. A conversation with no record has no level here.
const { thread } = await useGuestThread(threadId)
if (thread.value && !thread.value.recordId) {
  showError(createError({ statusCode: 404, statusMessage: 'This conversation has no reservation' }))
}
// A stay is shown by its own record screen, keyed by the stay; a booking or reservation by its conversation.
const stayId = computed(() => thread.value?.recordKind === 'stay' ? thread.value.recordId : null)
const bookingType = computed(() => thread.value?.recordKind === 'booking' || thread.value?.recordKind === 'reservation' ? thread.value.recordKind : null)
const bookingId = computed(() => bookingType.value ? thread.value!.recordId : null)
const recordTitle = computed(() => thread.value?.recordTitle ?? 'Reservation')

useSeoMeta({ title: 'Reservation | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
