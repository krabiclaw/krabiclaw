<template>
  <BookingRecord v-if="!rawType && bookingId" :booking-id="bookingId" :editor-path="level.path.value" />
  <BookingDetails v-else-if="purchase && bookingId" :booking-type="purchase" :booking-id="bookingId" :editor-path="level.path.value" />
</template>

<script setup lang="ts">
import BookingRecord from '~/components/dashboard/BookingRecord.vue'
import BookingDetails from '~/components/dashboard/BookingDetails.vue'
import { showNotFound } from '~/utils/errors'

definePageMeta({ layout: 'dashboard', key: route => `${route.params.org_slug}:${route.params.booking_type ?? ''}:${route.params.record_id}` })
useSeoMeta({ title: 'Booking details | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const level = useRouteLevel()
const rawType = route.params.booking_type
const purchase = rawType === 'order' || rawType === 'payment' ? rawType : null
const bookingId = String(route.params.record_id || '')
const redirectToBooking = (id: string) => navigateTo({
  path: `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/bookings/${encodeURIComponent(id)}`,
  query: route.query, hash: route.hash,
}, { replace: true })
if (!bookingId) showNotFound()
else if (rawType === 'stay') await redirectToBooking(bookingId)
else if (rawType === 'booking' || rawType === 'reservation') {
  if (!/^[\w:-]+$/u.test(bookingId)) showNotFound()
  else {
    const { thread, error } = await useGuestThread(computed(() => bookingId))
    if (error.value && error.value.statusCode !== 403 && error.value.statusCode !== 404) showError(error.value)
    else if (thread.value?.record_kind === 'booking' && thread.value.booking_id) await redirectToBooking(thread.value.booking_id)
    else showNotFound()
  }
} else if (rawType && !purchase) showNotFound()
</script>
