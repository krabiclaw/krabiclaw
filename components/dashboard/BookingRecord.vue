<template>
  <StayDetails v-if="unit === 'nights'" :stay-id="bookingId" :embedded="embedded" />
  <BookingDetails v-else-if="unit === 'slot'" booking-type="booking" :booking-id="bookingId" :editor-path="editorPath" :embedded="embedded" />
  <p v-else-if="error" role="alert" class="p-4 text-sm text-error">{{ getErrorMessage(error, 'Booking could not be loaded') }}</p>
</template>

<script setup lang="ts">
import BookingDetails from '~/components/dashboard/BookingDetails.vue'
import StayDetails from '~/components/dashboard/StayDetails.vue'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ bookingId: string; editorPath: string; embedded?: boolean }>()
const { data, error } = await useDashboardBooking(props.bookingId)
const unit = computed(() => data.value?.booking.unit)
</script>
