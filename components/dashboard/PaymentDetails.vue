<template>
  <!-- Airbnb's reservation page: what was bought, then "Payment info" with the amount paid and a receipt row. -->
  <section v-if="order" class="mt-6 border-t border-default pt-6">
    <h2 class="text-base font-semibold text-highlighted">Order details</h2>
    <div v-for="line in order.lines" :key="line.id" class="mt-4 flex items-start justify-between gap-4 text-base">
      <span class="text-highlighted">{{ line.title }} <span class="text-muted">× {{ line.quantity }}</span></span>
      <span class="shrink-0 text-muted">{{ paymentMoney(line.quantity * line.unit_amount, line.currency) }}</span>
    </div>
  </section>
  <section class="mt-6 border-t border-default pt-6">
    <h2 class="text-base font-semibold text-highlighted">Payment info</h2>
    <div class="mt-4">
      <p class="text-base font-medium text-highlighted">{{ amountLabel }}</p>
      <p class="mt-1 text-base text-muted">{{ paymentMoney(payment.captured_amount, payment.currency) }}</p>
    </div>
    <div v-if="payment.refunded_amount" class="mt-4">
      <p class="text-base font-medium text-highlighted">Refunded</p>
      <p class="mt-1 text-base text-muted">{{ paymentMoney(payment.refunded_amount, payment.currency) }}</p>
    </div>
    <div v-for="refund in shownRefunds" :key="refund.id" class="mt-4">
      <p class="text-base font-medium text-highlighted">{{ refundLabel(refund.status) }}</p>
      <p class="mt-1 text-base text-muted">{{ refund.amount === null ? 'Everything still held for this payment' : paymentMoney(refund.amount, payment.currency) }}</p>
      <p v-if="refund.note" class="mt-1 text-base text-muted">“{{ refund.note }}”</p>
    </div>
    <div class="mt-4">
      <NuxtLink v-if="payment.receipt_url" :to="payment.receipt_url" target="_blank" rel="noopener noreferrer" class="flex items-center gap-4 border-t border-default py-4">
        <UIcon name="i-lucide-receipt" class="size-5 shrink-0 text-highlighted" />
        <span class="min-w-0 flex-1 text-base font-medium text-highlighted">Get receipt</span>
        <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
      </NuxtLink>
      <slot name="actions" />
    </div>
  </section>
</template>

<script setup lang="ts">
import {paymentMoney,paymentStateLabel,type PaymentDisplay,type PaymentRefundDisplay,type PaymentOrderDisplay} from '~/shared/payment-display'

const props=withDefaults(defineProps<{payment:PaymentDisplay;refunds?:PaymentRefundDisplay[];order?:PaymentOrderDisplay|null}>(),{refunds:()=>[],order:null})
// Money that has landed reads "Amount paid"; anything else reads its state.
const amountLabel=computed(()=>props.payment.captured_amount>0?'Amount paid':paymentStateLabel(props.payment))
// A succeeded refund is in the refunded amount and shows again only for what the business said; the rest are still moving or did not.
const shownRefunds=computed(()=>props.refunds.filter(refund=>refund.status!=='succeeded'||refund.note))
function refundLabel(status:string){return status==='succeeded'?'Refund sent':status==='failed'?'Refund failed':status==='canceled'?'Refund cancelled':'Refund on its way'}
</script>
