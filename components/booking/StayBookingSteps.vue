<template>
  <StayDatesStep v-if="bookingStep === 1" :controller="controller" @next="bookingStep = 2" />
  <div v-else class="flex-1 min-h-0">
    <BookingRecap
      :main-line="rangeLabel"
      :meta-line="quote ? `${nightsLabel(quote.nights)} · ${guestsLabel} · ${money(quote.total_minor)}` : ''"
      :edit-label="t('site.experience_detail.change')"
      @edit="bookingStep = 1"
    />
    <p class="mb-4 text-sm text-muted">{{ t('stay.charged_in_full') }}</p>
    <section v-if="policy" class="mb-4 rounded-xl border border-default p-4 text-sm">
      <h3 class="font-semibold text-default">{{ t('stay.cancellation_policy') }}</h3>
      <p class="mt-1 text-muted">{{ policy.summary }}</p>
      <details class="mt-2">
        <summary class="cursor-pointer font-semibold text-default underline underline-offset-4">{{ t('payment.full_policy') }}</summary>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-muted"><li v-for="term in policy.terms" :key="term">{{ term }}</li></ul>
        <p v-if="'detail' in policy" class="mt-2 text-muted">{{ policy.detail }}</p>
      </details>
    </section>
    <p v-if="bookingError" role="alert" class="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">{{ bookingError }}</p>
    <BookingContactForm v-model="contactForm" :default-country="defaultPhoneCountry" :loading="submitting" :submit-text="t('payment.continue_to_pay')" @submit="submitBooking" />
  </div>
</template>

<script setup lang="ts">
import BookingRecap from '~/components/booking/BookingRecap.vue'
import BookingContactForm from '~/components/booking/BookingContactForm.vue'
import StayDatesStep from '~/components/booking/StayDatesStep.vue'
import type { StayBookingController } from '~/composables/useStayBooking'
import { bookedPolicyTerms } from '~/shared/stay-cancellation'

const props = defineProps<{ controller: StayBookingController }>()
const { bookingStep, contactForm, defaultPhoneCountry, rangeLabel, quote, guestsLabel, bookingError, submitting, submitBooking, money, nightsLabel } = props.controller
const { t } = useI18n()
const policy = computed(() => quote.value ? bookedPolicyTerms(quote.value.cancellation_policy) : null)
</script>
