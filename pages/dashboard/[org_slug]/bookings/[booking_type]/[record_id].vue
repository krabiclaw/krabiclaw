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
if (!bookingId || (rawType && !purchase)) showNotFound()
</script>
