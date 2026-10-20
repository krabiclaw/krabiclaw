<template>
  <StayDatesStep v-if="bookingStep === 1" :controller="controller" @next="bookingStep = 2" />
  <div v-else class="flex-1 min-h-0">
    <BookingRecap
      :main-line="rangeLabel"
      :meta-line="quote ? `${nightsLabel(quote.nights)} · ${guestsLabel} · ${money(quote.total_minor)}` : ''"
      :edit-label="t('saya.experience_detail.change')"
      @edit="bookingStep = 1"
    />
    <p class="mb-4 text-sm text-muted">{{ t('stay.charged_in_full') }}</p>
    <p v-if="bookingError" role="alert" class="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">{{ bookingError }}</p>
    <BookingContactForm :loading="submitting" :submit-text="t('payment.continue_to_pay')" @submit="submitBooking" />
  </div>
</template>

<script setup lang="ts">
import BookingRecap from '~/components/booking/BookingRecap.vue'
import BookingContactForm from '~/components/booking/BookingContactForm.vue'
import StayDatesStep from '~/components/booking/StayDatesStep.vue'
import type { StayBookingController } from '~/composables/useStayBooking'

const props = defineProps<{ controller: StayBookingController }>()
const { bookingStep, rangeLabel, quote, guestsLabel, bookingError, submitting, submitBooking, money, nightsLabel } = props.controller
const { t } = useI18n()
</script>
