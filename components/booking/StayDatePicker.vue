<template>
  <component :is="mobile ? DialogRoot : PopoverRoot" v-model:open="open" :modal="mobile">
    <component :is="mobile ? DialogTrigger : PopoverTrigger" as-child><slot /></component>
    <component :is="mobile ? DialogPortal : PopoverPortal" to="#tenant-portal-root">
      <DialogOverlay v-if="mobile" class="fixed inset-0 z-[60] bg-black/30" />
      <component
        :is="mobile ? DialogContent : PopoverContent"
        :aria-label="t('stay.select_dates')"
        :aria-describedby="undefined"
        @open-auto-focus="rememberTrigger"
        @close-auto-focus="restoreTrigger"
        v-bind="mobile ? {} : { align: 'end', side: 'bottom', sideOffset: 8, collisionPadding: 16 }"
        class="z-[60] flex flex-col border border-default bg-default p-6 text-default shadow-xl outline-none"
        :class="mobile ? 'fixed inset-x-0 bottom-0 top-3 rounded-t-2xl' : 'w-[660px] max-w-[calc(100vw-32px)] max-h-[calc(100dvh-32px)] rounded-2xl'"
      >
        <DialogTitle v-if="mobile" class="sr-only">{{ t('stay.select_dates') }}</DialogTitle>
        <DialogClose v-if="mobile" class="absolute left-5 top-4 flex size-7 items-center justify-center" :aria-label="t('stay.close_dates')"><span aria-hidden="true">×</span></DialogClose>
        <StayDatesStep :controller="controller" @done="open = false" />
      </component>
    </component>
  </component>
</template>

<script setup lang="ts">
import { useMediaQuery, useMounted } from '@vueuse/core'
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogTrigger, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import type { StayBookingController } from '~/composables/useStayBooking'
import StayDatesStep from './StayDatesStep.vue'

const props = defineProps<{ controller: StayBookingController }>()
const { t } = useI18n()
const { bookingOpen, bookingStep, openBooking, checkIn, checkOut, dateField } = props.controller
const mounted = useMounted()
const smallScreen = useMediaQuery('(max-width: 767px)')
const mobile = computed(() => mounted.value && smallScreen.value)
let trigger: HTMLElement | null = null
function rememberTrigger() {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
}
function restoreTrigger(event: Event) {
  if (!trigger?.isConnected) return
  event.preventDefault()
  trigger.focus()
}
const open = computed({
  get: () => bookingOpen.value && bookingStep.value === 1,
  set: (value: boolean) => {
    if (value) openBooking(1)
    else {
      bookingOpen.value = false
      if (checkIn.value && checkOut.value) dateField.value = 'checkIn'
    }
  },
})
</script>
