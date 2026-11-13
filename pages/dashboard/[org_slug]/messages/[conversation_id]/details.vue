<template>
  <DashboardLeafPanel v-if="bookingId" id="thread-record" :title="recordTitle" :footer="false">
    <BookingRecord :booking-id="bookingId" :editor-path="`/dashboard/${String(route.params.org_slug)}/bookings/${encodeURIComponent(bookingId)}`" embedded />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import BookingRecord from '~/components/dashboard/BookingRecord.vue'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const threadId = computed(() => String(route.params.conversation_id))

// Airbnb's Reservation pane: the record the conversation is about, read from
// the thread. A conversation with no record has no level here.
const { data } = await useConversation(threadId).request
const thread = computed(() => data.value?.conversation?.kind === 'team' ? null : data.value?.conversation)
if (thread.value && !thread.value.booking_id) {
  showError(createError({ statusCode: 404, statusMessage: 'This conversation has no reservation' }))
}
const bookingId = computed(() => thread.value?.booking_id ?? null)
const recordTitle = computed(() => thread.value?.record_title ?? 'Reservation')

useSeoMeta({ title: 'Reservation | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
