<template>
  <div class="my-12 w-full rounded-2xl border border-default bg-elevated p-6 shadow-sm sm:p-10">
    <h3 class="mb-3 text-center text-3xl font-semibold text-highlighted">{{ title }}</h3>
    <p class="mx-auto mb-8 max-w-2xl text-center text-muted">{{ description }}</p>

    <div class="grid grid-cols-1 gap-10 lg:grid-cols-2">
      <div class="space-y-6">
        <fieldset>
          <legend class="mb-2 flex w-full items-baseline justify-between gap-4 text-sm font-semibold text-[var(--blawby-primary,var(--ui-text-highlighted))]">
            <span>Household Size</span><span class="text-xs font-normal text-muted">Includes you + dependents</span>
          </legend>
          <div class="grid grid-cols-4 gap-2 sm:grid-cols-8">
            <label v-for="size in 8" :key="size" class="cursor-pointer">
              <input v-model.number="householdSize" type="radio" name="household-size" :value="size" class="peer sr-only">
              <span class="flex aspect-square items-center justify-center rounded-lg text-lg font-semibold ring-1 ring-default transition peer-checked:bg-[var(--blawby-accent,var(--ui-primary))] peer-checked:text-on-primary peer-checked:ring-[var(--blawby-accent,var(--ui-primary))] peer-focus-visible:ring-2 peer-focus-visible:ring-primary">{{ size }}</span>
            </label>
          </div>
        </fieldset>

        <div>
          <div class="mb-2 flex items-baseline justify-between gap-4">
            <label for="tenant-income" class="text-sm font-semibold text-[var(--blawby-primary,var(--ui-text-highlighted))]">Household Income</label>
            <div class="flex rounded-md bg-muted p-1 text-xs font-medium" aria-label="Income period">
              <button v-for="option in ['annual', 'monthly'] as const" :key="option" type="button" class="rounded px-2 py-1 capitalize cursor-pointer" :class="period === option ? 'bg-elevated text-highlighted shadow' : 'text-muted'" @click="period = option">{{ option }}</button>
            </div>
          </div>
          <div class="relative">
            <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted">$</span>
            <input id="tenant-income" :value="income" inputmode="decimal" autocomplete="off" class="block w-full rounded-md border-0 py-3 pl-7 pr-12 text-highlighted ring-1 ring-inset ring-accented focus:ring-2 focus:ring-inset focus:ring-primary" placeholder="0.00" @input="onIncomeInput">
            <span class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-sm text-muted">USD</span>
          </div>
        </div>
      </div>

      <div class="flex flex-col justify-center rounded-xl border border-muted bg-[var(--blawby-primary-100,var(--ui-bg-muted))] p-6">
        <h4 class="mb-1 text-lg font-semibold text-[var(--blawby-primary,var(--ui-text-highlighted))]">Estimated Hourly Rate</h4>
        <p v-if="!income" class="mb-6 text-sm italic text-muted">Enter income to see your specific rate</p>
        <div class="space-y-4">
          <div class="flex items-center justify-between text-sm"><span class="text-muted">Standard Rate</span><span class="font-medium">${{ result.standardRate }}/hr</span></div>
          <div class="flex items-center justify-between text-sm"><span class="text-muted">Discount<span v-if="result.percentage"> ({{ result.percentage }}%)</span></span><span class="font-medium" :class="result.percentage ? 'text-success' : ''">{{ result.percentage ? `-$${result.standardRate - result.rate}/hr` : 'None' }}</span></div>
          <div class="border-t border-default pt-4"><div class="flex items-center justify-between"><span class="text-xl font-bold text-[var(--blawby-primary,var(--ui-text-highlighted))]">Your Rate</span><span class="text-3xl font-bold text-[var(--blawby-accent-strong,var(--ui-primary))]">${{ result.rate }}/hr</span></div></div>
        </div>
      </div>
    </div>
    <p v-if="note" class="mt-6 text-center text-xs text-muted">{{ note }}</p>
  </div>
</template>

<script setup lang="ts">
import { calculateSlidingScaleRate, parsePricingAmount } from '~/utils/blawby-pricing'

const props = withDefaults(defineProps<{
  title?: string
  description?: string
  note?: string
  rows: unknown[][]
}>(), {
  title: 'Calculate Your Rate',
  description: 'Estimate your hourly rate using the imported Federal Poverty Level guidelines.',
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
  const parts = next.split('.')
  if (parts.length > 2) return
  income.value = next
  target.value = next
}
</script>
