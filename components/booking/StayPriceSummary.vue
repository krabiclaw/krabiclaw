<template>
  <span v-if="quotePending" role="status" class="text-sm text-muted">{{ t('stay.updating_price') }}</span>
  <component
    v-else-if="quote && priceSummary"
    :is="mobile ? UDrawer : UPopover"
    v-model:open="open"
    portal="#tenant-portal-root"
    v-bind="mobile ? { title: t('payment.price_details'), handle: false } : { content: { side: 'bottom', align: 'start', sideOffset: 12, collisionPadding: 16 } }"
    :ui="mobile ? { overlay: 'z-[80] bg-black/40', content: 'z-[80] inset-x-0 bottom-0 rounded-t-2xl' } : { content: 'z-[80] w-[360px] max-w-[calc(100vw-32px)] rounded-2xl' }"
  >
    <button type="button" class="text-left text-default" :class="large ? 'text-2xl tabular-nums' : 'text-sm'" :aria-label="`${priceSummary.headline} ${priceSummary.period}`">
      <span class="font-semibold underline underline-offset-4">{{ priceSummary.headline }}</span>{{ ' ' }}<span class="font-normal text-muted">{{ priceSummary.period }}</span>
    </button>
    <template #content>
      <div class="relative flex max-h-[calc(100dvh-32px)] flex-col overflow-y-auto p-6 text-default">
        <button type="button" class="absolute right-4 top-4 flex size-7 items-center justify-center rounded-full" :class="mobile ? undefined : 'border border-default'" :aria-label="t('stay.close_dates')" @click="open = false"><span aria-hidden="true">×</span></button>
        <h2 class="mb-6 pr-8 text-xl font-semibold">{{ t('payment.price_details') }}</h2>
        <dl class="space-y-3 text-sm">
          <div v-if="priceSummary.monthly" class="flex justify-between gap-4">
            <dt>{{ t('stay.average_monthly_price') }}</dt><dd>{{ priceSummary.amount }}</dd>
          </div>
          <template v-else>
            <div v-for="line in breakdown" :key="line.label" class="flex justify-between gap-4"><dt>{{ line.label }}</dt><dd>{{ line.amount }}</dd></div>
          </template>
          <div class="flex justify-between gap-4 border-t border-default pt-4 font-semibold"><dt>{{ t('stay.total') }}</dt><dd>{{ money(quote.total_minor) }}</dd></div>
        </dl>
        <template v-if="mobile">
          <div class="mt-6 flex items-center justify-between gap-4 border-t border-default pt-5 text-sm">
            <div><h3 class="font-semibold">{{ t('payment.dates') }}</h3><p class="mt-1">{{ dates }}</p></div>
            <button type="button" class="rounded-lg bg-muted px-3 py-2 font-semibold" @click="editDates">{{ t('payment.change') }}</button>
          </div>
          <TenantButton block class="mt-6" :to="checkout ? undefined : enquiryPath" @click="continueBooking">{{ t(checkout ? 'stay.reserve' : 'stay.send_enquiry') }}</TenantButton>
        </template>
      </div>
    </template>
  </component>
</template>

<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { UDrawer, UPopover } from '#components'
import type { StayBookingController } from '~/composables/useStayBooking'
const props = defineProps<{ controller: StayBookingController; large?: boolean }>()
const { quote, quotePending, priceSummary, breakdown, money, checkout, enquiryPath } = props.controller
const { t, locale } = useI18n()
const mobile = useMediaQuery('(max-width: 767px)')
const open = ref(false)
const dates = computed(() => quote.value ? new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  .formatRange(new Date(`${quote.value.check_in_date}T00:00:00Z`), new Date(`${quote.value.check_out_date}T00:00:00Z`)) : '')
async function editDates() {
  open.value = false
  await nextTick()
  props.controller.openBooking(1)
}
async function continueBooking() {
  open.value = false
  if (!checkout.value) return
  await nextTick()
  props.controller.openBooking(2)
}
</script>
