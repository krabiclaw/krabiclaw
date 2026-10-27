<template>
  <!--
    The one way KrabiClaw offers something the business does not have yet, in
    Airbnb's shape: an illustrated card that opens "How it works", and one
    action. The card is shown only to someone who can act on it; everyone
    else reads who can.
  -->
  <button
    type="button"
    class="flex w-full items-center gap-5 rounded-2xl bg-elevated p-5 text-left transition-colors hover:bg-accented focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted sm:p-6"
    :data-testid="`offer-${offer.id}`"
    @click="open = true"
  >
    <img :src="offer.illustration" alt="" class="size-16 shrink-0 rounded-xl object-cover sm:size-20" loading="lazy" decoding="async">
    <span class="min-w-0 flex-1">
      <span class="block text-lg font-semibold leading-snug text-highlighted">{{ offer.headline }}</span>
      <span class="mt-1 block text-base text-muted">{{ summary }}</span>
    </span>
    <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" aria-hidden="true" />
  </button>

  <UModal v-model:open="open" :title="`How ${offer.name} works`" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <img :src="offer.illustration" alt="" class="size-24 rounded-2xl object-cover" decoding="async">
      <ol class="mt-6 space-y-6">
        <li v-for="step in offer.steps" :key="step.title" class="flex gap-5">
          <span class="flex size-14 shrink-0 items-center justify-center rounded-xl bg-elevated" aria-hidden="true">
            <UIcon :name="step.icon" class="size-6 text-highlighted" />
          </span>
          <span class="min-w-0">
            <span class="block text-base font-semibold text-highlighted">{{ step.title }}</span>
            <span class="mt-1 block text-base text-muted">{{ step.text }}</span>
          </span>
        </li>
      </ol>
    </template>
    <template #footer>
      <div class="w-full space-y-3">
        <UButton v-if="dashboard.canUpdateBilling.value" size="xl" block :to="actionTo" :label="actionLabel" @click="open = false" />
        <p v-else class="text-base text-muted">An owner of {{ dashboard.organization.value?.name }} can turn this on from Plan and billing.</p>
        <p class="text-center text-sm text-muted">{{ priceLine }}</p>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { Offer } from '~/shared/offers'
import { PAID_PLAN_PRICES, SERVICES } from '~/shared/billing-model'

const props = defineProps<{
  offer: Offer
  /** The card's second line; the offer's own line when the surface has nothing more specific to say. */
  summary?: string
}>()

const dashboard = useDashboardOrganization()
const route = useRoute()
const open = ref(false)
const base = computed(() => `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}`)
const planName = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1)
const summary = computed(() => props.summary ?? ('plan' in props.offer.unlock ? `${props.offer.name} comes with ${planName(props.offer.unlock.plan)}.` : props.offer.line))
// The offered plan travels to the upgrade leaf, so a Starter organization following a Business offer is not handed Growth.
const actionTo = computed(() => 'plan' in props.offer.unlock ? `${base.value}/billing/upgrade?plan=${props.offer.unlock.plan}` : `${base.value}/${props.offer.path}`)
const actionLabel = computed(() => 'plan' in props.offer.unlock ? `Upgrade to ${planName(props.offer.unlock.plan)}` : `See ${props.offer.name.toLowerCase()}`)
const priceLine = computed(() => {
  const unlock = props.offer.unlock
  if ('plan' in unlock) {
    const monthly = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(PAID_PLAN_PRICES[unlock.plan].monthly / 100)
    return `${planName(unlock.plan)} is ${monthly} per month. Change or cancel from Plan and billing.`
  }
  return `${SERVICES[unlock.service].price}. ${SERVICES[unlock.service].billing}`
})
</script>
