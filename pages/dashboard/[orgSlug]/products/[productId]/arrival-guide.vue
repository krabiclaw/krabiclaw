<template>
  <DashboardIndexPanel id="product-arrival-guide" title="Arrival guide" lead="Private preview for your team." column="leaf">
    <UAlert v-if="p.arrivalError.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.arrivalError.value" />
    <div v-if="p.arrivalHome.value && !p.arrivalError.value" class="space-y-10" data-testid="arrival-guide-preview">
      <section>
        <h2 class="text-xl font-medium text-highlighted">Check-in &amp; checkout</h2>
        <dl class="mt-4 grid grid-cols-2 gap-6">
          <div><dt class="text-sm text-muted">Check-in from</dt><dd class="mt-1 text-base text-highlighted">{{ p.product.value?.stay?.check_in_time }}</dd></div>
          <div><dt class="text-sm text-muted">Checkout by</dt><dd class="mt-1 text-base text-highlighted">{{ p.product.value?.stay?.check_out_time }}</dd></div>
        </dl>
      </section>
      <section v-if="p.arrivalHome.value.directions">
        <h2 class="text-xl font-medium text-highlighted">Directions</h2>
        <p class="mt-3 whitespace-pre-wrap break-words text-base text-muted">{{ p.arrivalHome.value.directions }}</p>
      </section>
      <section v-if="method || p.arrivalHome.value.check_in_instructions">
        <h2 class="text-xl font-medium text-highlighted">Check-in method</h2>
        <p v-if="method" class="mt-3 text-base text-muted">{{ method.label }}</p>
        <p v-if="p.arrivalHome.value.check_in_instructions" class="mt-3 whitespace-pre-wrap break-words text-base text-muted">{{ p.arrivalHome.value.check_in_instructions }}</p>
      </section>
      <section v-if="p.arrivalHome.value.wifi_network || p.arrivalHome.value.wifi_password">
        <h2 class="text-xl font-medium text-highlighted">Wifi details</h2>
        <dl class="mt-4 space-y-4">
          <div v-if="p.arrivalHome.value.wifi_network"><dt class="text-sm text-muted">Wifi network</dt><dd class="mt-1 whitespace-pre-wrap break-words text-base text-highlighted">{{ p.arrivalHome.value.wifi_network }}</dd></div>
          <div v-if="p.arrivalHome.value.wifi_password"><dt class="text-sm text-muted">Wifi password</dt><dd class="mt-1 whitespace-pre-wrap break-words text-base text-highlighted">{{ p.arrivalHome.value.wifi_password }}</dd></div>
        </dl>
      </section>
      <section v-if="p.arrivalHome.value.house_manual">
        <h2 class="text-xl font-medium text-highlighted">House manual</h2>
        <p class="mt-3 whitespace-pre-wrap break-words text-base text-muted">{{ p.arrivalHome.value.house_manual }}</p>
      </section>
      <section v-if="houseRules.length">
        <h2 class="text-xl font-medium text-highlighted">House rules</h2>
        <ul class="mt-3 space-y-3 text-base text-muted">
          <li v-for="(line, index) in houseRules" :key="index" class="whitespace-pre-wrap break-words">{{ line }}</li>
        </ul>
      </section>
      <section v-if="p.arrivalHome.value.checkout_instructions.length">
        <h2 class="text-xl font-medium text-highlighted">Checkout instructions</h2>
        <ul class="mt-4 space-y-6">
          <li v-for="instruction in p.arrivalHome.value.checkout_instructions" :key="instruction.task" class="flex gap-4">
            <UIcon :name="STAY_CHECKOUT_TASKS[instruction.task].icon" class="mt-0.5 size-6 shrink-0 text-highlighted" aria-hidden="true" />
            <div><h3 class="text-base font-medium text-highlighted">{{ STAY_CHECKOUT_TASKS[instruction.task].label }}</h3><p v-if="instruction.details" class="mt-1 whitespace-pre-wrap break-words text-base text-muted">{{ instruction.details }}</p></div>
          </li>
        </ul>
      </section>
      <p v-if="!hasGuideDetails" class="text-base text-muted">No arrival details added yet.</p>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_CHECK_IN_METHODS, STAY_CHECKOUT_TASKS } from '~/shared/stay-listing'
import { stayHouseRuleLines } from '~/shared/product-details'
import { formatTime } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const { locale } = useI18n()
const method = computed(() => p.arrivalHome.value?.check_in_method ? STAY_CHECK_IN_METHODS[p.arrivalHome.value.check_in_method] : null)
const houseRules = computed(() => p.product.value ? stayHouseRuleLines(p.product.value.details, value => formatTime(value, locale.value)) : [])
const hasGuideDetails = computed(() => {
  const home = p.arrivalHome.value
  return home && (home.directions || home.check_in_method || home.check_in_instructions || home.wifi_network || home.wifi_password || home.house_manual || home.checkout_instructions.length || houseRules.value.length)
})
</script>
