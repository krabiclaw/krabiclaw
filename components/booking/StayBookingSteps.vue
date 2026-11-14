<template>
  <div v-if="submittedRequest" class="space-y-4">
    <h2 class="text-lg font-semibold">{{ t(requestTitle) }}</h2>
    <p v-if="submittedRequest.request_status === 'awaiting_approval'" role="status" class="text-sm text-muted">{{ t('stay.request_received_help') }}</p>
    <TenantButton :to="activityUrl">{{ t('booking.manage_account') }}</TenantButton>
  </div>
  <div v-else class="flex-1 min-h-0">
    <BookingRecap
      :main-line="rangeLabel"
      :meta-line="quote ? `${nightsLabel(quote.nights)} · ${guestsLabel} · ${money(quote.total_minor)}` : ''"
      :edit-label="t('site.experience_detail.change')"
      @edit="controller.openBooking(1)"
    />
    <StayGuestFields :controller="controller" class="mb-4" />
    <p v-if="bookingError" role="alert" class="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">{{ bookingError }}</p>
    <p v-if="needsApproval" class="mb-4 text-sm text-muted">{{ t('stay.pay_after_approval') }}</p>
    <BookingContactForm v-model="contactForm" :questions="formQuestions.questions.value" :answer-errors="formQuestions.answerErrors.value" :questions-notice="formQuestions.notice.value" :default-country="defaultPhoneCountry" :loading="submitting || quotePending" :submit-text="needsApproval ? t('stay.request_to_book') : t('payment.continue_to_pay')" @submit="submitBooking" />
  </div>
</template>

<script setup lang="ts">
import BookingRecap from '~/components/booking/BookingRecap.vue'
import BookingContactForm from '~/components/booking/BookingContactForm.vue'
import StayGuestFields from '~/components/booking/StayGuestFields.vue'
import type { StayBookingController } from '~/composables/useStayBooking'

const props = defineProps<{ controller: StayBookingController }>()
const { submittedRequest, needsApproval, contactForm, formQuestions, defaultPhoneCountry, rangeLabel, quote, quotePending, guestsLabel, bookingError, submitting, submitBooking, money, nightsLabel } = props.controller
const { t } = useI18n()
const platformOrigin = useRuntimeConfig().public.platformDomain
const activityUrl = computed(() => submittedRequest.value ? new URL(submittedRequest.value.activity_path, platformOrigin).href : undefined)
const requestTitle = computed(() => {
  if (submittedRequest.value?.status === 'confirmed') return 'booking.confirmed'
  if (submittedRequest.value?.status === 'cancelled') return 'site.experience_cancel.cancelled_title'
  return submittedRequest.value?.request_status === 'awaiting_payment' ? 'booking.stay_request_approved' : 'booking.request_received'
})
</script>
