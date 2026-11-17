<template>
  <div class="mt-5">
    <div class="mt-4">
      <p class="text-sm font-medium text-highlighted">{{ amountLabel }}</p>
      <p class="mt-1 text-sm text-muted">{{ paymentMoney(payment.captured_amount, payment.currency) }}</p>
      <p v-if="payment.surcharge_amount" class="mt-1 text-sm text-muted" data-payment-surcharge>Includes a {{ paymentMoney(payment.surcharge_amount, payment.currency) }} card surcharge</p>
    </div>
    <div v-if="payment.refunded_amount" class="mt-4">
      <p class="text-sm font-medium text-highlighted">Refunded</p>
      <p class="mt-1 text-sm text-muted">{{ paymentMoney(payment.refunded_amount, payment.currency) }}</p>
    </div>
    <div v-for="refund in shownRefunds" :key="refund.id" class="mt-4">
      <p class="text-sm font-medium text-highlighted">{{ refundLabel(refund.status) }}</p>
      <p class="mt-1 text-sm text-muted">{{ refund.amount === null ? 'Everything still held for this payment' : paymentMoney(refund.amount, payment.currency) }}</p>
      <p v-if="refund.note" class="mt-1 text-sm text-muted">“{{ refund.note }}”</p>
    </div>
    <div class="mt-4">
      <NuxtLink v-if="payment.receipt_url" :to="payment.receipt_url" target="_blank" rel="noopener noreferrer" class="flex items-center gap-3 py-2.5 text-sm text-highlighted">
        <UIcon name="i-lucide-receipt" class="size-4 shrink-0 text-highlighted" />
        <span class="min-w-0 flex-1 text-sm font-medium text-highlighted">Get receipt</span>
        <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-muted" />
      </NuxtLink>
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import {paymentMoney,paymentStateLabel,type PaymentDisplay,type PaymentRefundDisplay} from '~/shared/payment-display'

const props=withDefaults(defineProps<{payment:PaymentDisplay;refunds?:PaymentRefundDisplay[]}>(),{refunds:()=>[]})
// Money that has landed reads "Amount paid"; anything else reads its state.
const amountLabel=computed(()=>props.payment.captured_amount>0?'Amount paid':paymentStateLabel(props.payment))
// A succeeded refund is in the refunded amount and shows again only for what the business said; the rest are still moving or did not.
const shownRefunds=computed(()=>props.refunds.filter(refund=>refund.status!=='succeeded'||refund.note))
function refundLabel(status:string){return status==='succeeded'?'Refund sent':status==='failed'?'Refund failed':status==='canceled'?'Refund cancelled':'Refund on its way'}
</script>
