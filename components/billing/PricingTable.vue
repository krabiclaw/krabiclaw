<template>
  <div>
    <!-- Primary plans -->
    <div
      class="grid grid-cols-1 gap-6 items-stretch mx-auto lg:grid-cols-3 max-w-5xl"
    >
      <div
        v-for="plan in plans"
        :key="plan.id"
        :class="plan.highlighted ? 'sm:-mt-4 sm:mb-4' : ''"
        class="flex flex-col"
      >
        <BillingPlanCard :plan="plan" class="h-full flex-1" />
      </div>
    </div>

    <PlatformPricingComparison class="mt-24" />
  </div>
</template>

<script setup lang="ts">
import type { Plan } from '~/server/api/billing/plans.get'
import PlatformPricingComparison from '~/components/platform/marketing/PlatformPricingComparison.vue'

defineProps<{
  plans: Plan[]
}>()

</script>
