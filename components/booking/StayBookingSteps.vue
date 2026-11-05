<template>
  <div class="flex-1 min-h-0">
    <BookingRecap
      :main-line="rangeLabel"
      :meta-line="quote ? `${nightsLabel(quote.nights)} · ${guestsLabel} · ${money(quote.total_minor)}` : ''"
      :edit-label="t('site.experience_detail.change')"
      @edit="controller.openBooking(1)"
    />
    <StayGuestFields :controller="controller" class="mb-4" />
    <p v-if="bookingError" role="alert" class="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">{{ bookingError }}</p>
    <BookingContactForm v-model="contactForm" :questions="formQuestions.questions.value" :answer-errors="formQuestions.answerErrors.value" :questions-notice="formQuestions.notice.value" :default-country="defaultPhoneCountry" :loading="submitting || quotePending" :submit-text="t('payment.continue_to_pay')" @submit="submitBooking" />
  </div>
</template>

<script setup lang="ts">
import BookingRecap from '~/components/booking/BookingRecap.vue'
import BookingContactForm from '~/components/booking/BookingContactForm.vue'
import StayGuestFields from '~/components/booking/StayGuestFields.vue'
import type { StayBookingController } from '~/composables/useStayBooking'

const props = defineProps<{ controller: StayBookingController }>()
const { contactForm, formQuestions, defaultPhoneCountry, rangeLabel, quote, quotePending, guestsLabel, bookingError, submitting, submitBooking, money, nightsLabel } = props.controller
const { t } = useI18n()
</script>
