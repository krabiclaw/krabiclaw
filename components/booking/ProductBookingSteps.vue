<template>
        <div v-if="bookingStep === 1" class="flex min-h-0 flex-1 flex-col">
          <!-- What is being booked. One option is not a choice; several are,
               and the guest makes it rather than the server picking an order. -->
          <fieldset v-if="sellableVariants.length > 1" class="mb-5">
            <legend class="mb-2 text-sm font-medium">{{ t('site.product_detail.choose_option') }}</legend>
            <div class="flex flex-col gap-2">
              <label
                v-for="variant in sellableVariants"
                :key="variant.id"
                class="flex cursor-pointer items-baseline justify-between gap-3 rounded-lg border border-default px-4 py-3 text-sm"
                :class="selectedVariantId === variant.id ? 'border-primary bg-primary/5' : ''"
              >
                <span class="flex items-baseline gap-3">
                  <input v-model="selectedVariantId" type="radio" :value="variant.id" :name="variantGroup">
                  <span>{{ variant.name }}</span>
                </span>
                <span v-if="variantPriceLabel(variant)" class="tabular-nums">{{ variantPriceLabel(variant) }}</span>
              </label>
            </div>
          </fieldset>
          <BookingTimezoneSelect v-if="allowTimezoneSelection && bookingTimezone" :model-value="bookingTimezone" :options="timezoneOptions" @update:model-value="guestTimezone = $event" />
          <BookingTimeStep
            v-model="timeSelection"
            :dates="availabilityDates"
            :reference-date="referenceDate"
            :month="calendarMonth"
            :last-month="lastCalendarMonth"
            @update:month="changeMonth"
            :loading="sessionsPending || quotePending"
            :guests="partySize"
            :show-party-size="showPartySize"
            :guests-min="guestsMin"
            :guests-max="guestsMax"
            :show-minimum-at-limit="false"
            @update:guests="partySize = $event"
            @next="reviewSelection"
          />
          <p v-if="bookingError" role="alert" class="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">
            {{ bookingError }}
          </p>
        </div>

        <div v-else class="flex-1 min-h-0">
          <BookingRecap
            v-if="timeSelection"
            :main-line="`${timeSelection.label} · ${formatTime(timeSelection.time, locale)}`"
            :meta-line="allowTimezoneSelection ? (bookingTimezone ?? '') : showPartySize ? `${partySize} ${t(partySize === 1 ? 'site.experience_detail.guest' : 'site.experience_detail.guests')}` : ''"
            :edit-label="t('site.experience_detail.change')"
            @edit="bookingStep = 1"
          />
          <p v-if="bookingError" role="alert" class="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-error">
            {{ bookingError }}
          </p>
          <BookingContactForm
            v-model="contactForm"
            :questions="formQuestions.questions.value"
            :answer-errors="formQuestions.answerErrors.value"
            :questions-notice="formQuestions.notice.value"
            :default-country="defaultPhoneCountry"
            :phone-required="phoneRequired"
            :loading="submitting"
            :submit-text="timedQuote?.payment_required ? t('payment.continue_to_pay') : confirmationMode === 'review' ? t('booking.request_appointment') : t('site.experience_detail.confirm_booking')"
            @submit="submitBooking"
          />
        </div>
</template>
<script setup lang="ts">
import BookingRecap from '~/components/booking/BookingRecap.vue'
import BookingContactForm from '~/components/booking/BookingContactForm.vue'
import BookingTimeStep from '~/components/booking/BookingTimeStep.vue'
import BookingTimezoneSelect from '~/components/booking/BookingTimezoneSelect.vue'
import type { SessionBookingController } from '~/composables/useSessionBooking'
import { formatTime } from '~/utils/timezone'
// A paid booking is not confirmed in the dialog: the guest goes on to pay, so the button says so.
const props = defineProps<{ controller: SessionBookingController; confirmationMode: 'instant' | 'review'; phoneRequired?: boolean }>()
const { bookingStep, contactForm, formQuestions, defaultPhoneCountry, sellableVariants, selectedVariantId, variantPriceLabel, sessionsPending,
  availabilityDates, referenceDate, calendarMonth, lastCalendarMonth, changeMonth, timeSelection, partySize, showPartySize, allowTimezoneSelection, guestTimezone, bookingTimezone, timezoneOptions, guestsMin, guestsMax, bookingError, submitting, timedQuote, quotePending, reviewSelection, submitBooking } = props.controller
const { t, locale } = useI18n()
const variantGroup = useId()
</script>
