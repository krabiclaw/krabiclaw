<template>
  <StayDetails v-if="isStay && bookingId" :stay-id="bookingId" />
  <BookingDetails v-else-if="bookingType && bookingId" :booking-type="bookingType" :booking-id="bookingId" :editor-path="level.path.value" />
</template>

<script setup lang="ts">
import BookingDetails from '~/components/dashboard/BookingDetails.vue'
import StayDetails from '~/components/dashboard/StayDetails.vue'

// Back is the mount's, not the page's: Today from here, the day from the calendar (build/booking-routes.ts).
definePageMeta({ layout: 'dashboard', key: route => `${route.params.orgSlug}:${route.params.bookingType}:${route.params.bookingId}` })
useSeoMeta({ title: 'Booking details | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const level = useRouteLevel()
const rawType = typeof route.params.bookingType === 'string' ? route.params.bookingType : undefined
const bookingType = rawType === 'reservation' || rawType === 'booking' || rawType === 'order' || rawType === 'payment' ? rawType : null
const bookingId = String(route.params.bookingId || '')
// A stay is opened here like a booking, from Today and from its calendar day.
const isStay = rawType === 'stay'
// Raised, not thrown: the dashboard renders on the client, where a throw in a nested page's setup leaves a blank screen (DESIGN.md).
if ((!bookingType && !isStay) || !bookingId) showError(createError({ statusCode: 404, statusMessage: 'Booking not found' }))
</script>
