<template>
  <section class="my-12 w-full rounded-2xl border border-default bg-default p-6 shadow-sm sm:p-10">
    <h2 class="mb-3 text-center text-3xl font-semibold text-primary">{{ title }}</h2>
    <div class="mx-auto max-w-xl">
      <fieldset>
        <legend class="mb-2 text-sm font-semibold text-primary">Household Size</legend>
        <div class="grid grid-cols-4 gap-2 sm:grid-cols-8">
          <label v-for="size in 8" :key="size" class="cursor-pointer">
            <input v-model.number="householdSize" type="radio" name="tenant-page-household-size" :value="size" class="peer sr-only">
            <span class="flex aspect-square items-center justify-center rounded-lg text-lg font-semibold ring-1 ring-default transition peer-checked:bg-primary peer-checked:text-inverted peer-checked:ring-primary peer-focus-visible:ring-2">{{ size }}</span>
          </label>
        </div>
      </fieldset>

      <div class="mt-6">
        <label for="tenant-page-income" class="mb-2 block text-sm font-semibold text-primary">Household Income</label>
        <div class="relative">
          <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted">$</span>
          <input id="tenant-page-income" :value="income" inputmode="decimal" autocomplete="off" class="block w-full rounded-md border-0 py-3 pl-7 pr-12 text-default ring-1 ring-inset ring-default focus:ring-2 focus:ring-inset focus:ring-primary" placeholder="0.00" @input="onIncomeInput">
          <span class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-sm text-muted">USD</span>
        </div>
      </div>
    </div>

    <div class="mx-auto mt-8 max-w-xl rounded-xl border border-default bg-elevated p-6">
      <h3 class="mb-1 text-lg font-semibold text-primary">Estimated Hourly Rate</h3>
      <div class="space-y-4">
        <div class="flex items-center justify-between text-sm"><span class="text-muted">Standard Rate</span><span class="font-medium">${{ result.standardRate }}/hr</span></div>
        <div class="flex items-center justify-between text-sm"><span class="text-muted">Discount<span v-if="result.percentage"> ({{ result.percentage }}%)</span></span><span class="font-medium">{{ result.percentage ? `-$${result.standardRate - result.rate}/hr` : 'None' }}</span></div>
        <div class="border-t border-default pt-4"><div class="flex items-center justify-between"><span class="text-xl font-bold text-primary">Your Rate</span><span class="text-3xl font-bold text-primary">${{ result.rate }}/hr</span></div></div>
      </div>
    </div>
    <p v-if="note" class="mx-auto mt-6 max-w-xl text-center text-xs text-muted">{{ note }}</p>
  </section>
</template>

<script setup lang="ts">
import { calculateSlidingScaleRate, parsePricingAmount } from '~/utils/pricing-calculator'

const props = withDefaults(defineProps<{
  title?: string
  note?: string
  rows: unknown[][]
}>(), {
  title: 'Calculate Your Rate',
  note: 'This calculator provides an estimate. Final rate determination requires verification of income.',
})

const householdSize = ref(1)
const income = ref('')
const period = ref<'annual' | 'monthly'>('annual')
const result = computed(() => calculateSlidingScaleRate({
  householdSize: householdSize.value,
  income: parsePricingAmount(income.value),
  period: period.value,
  rows: props.rows,
}))

function onIncomeInput(event: Event) {
  const target = event.target as HTMLInputElement
  const next = target.value.replace(/[^0-9.]/g, '')
  if (next.split('.').length > 2) return
  income.value = next
  target.value = next
}
</script>
