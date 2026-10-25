<template>
  <div class="space-y-10" data-stay-arrival-guide>
    <section v-if="guide.directions">
      <h2 class="text-xl font-medium text-highlighted">{{ t('stay.directions') }}</h2>
      <p class="mt-3 whitespace-pre-wrap break-words text-base text-muted">{{ guide.directions }}</p>
    </section>
    <section v-if="guide.check_in_method || guide.check_in_instructions">
      <h2 class="text-xl font-medium text-highlighted">{{ t('stay.check_in_method') }}</h2>
      <p v-if="guide.check_in_method" class="mt-3 text-base text-muted">{{ STAY_CHECK_IN_METHODS[guide.check_in_method].label }}</p>
      <p v-if="guide.check_in_instructions" class="mt-3 whitespace-pre-wrap break-words text-base text-muted">{{ guide.check_in_instructions }}</p>
    </section>
    <section v-if="guide.wifi_network || guide.wifi_password">
      <h2 class="text-xl font-medium text-highlighted">{{ t('stay.wifi_details') }}</h2>
      <dl class="mt-4 space-y-4">
        <div v-if="guide.wifi_network"><dt class="text-sm text-muted">{{ t('stay.wifi_network') }}</dt><dd class="mt-1 whitespace-pre-wrap break-words text-base text-highlighted">{{ guide.wifi_network }}</dd></div>
        <div v-if="guide.wifi_password"><dt class="text-sm text-muted">{{ t('stay.wifi_password') }}</dt><dd class="mt-1 whitespace-pre-wrap break-words text-base text-highlighted">{{ guide.wifi_password }}</dd></div>
      </dl>
    </section>
    <section v-if="guide.house_manual">
      <h2 class="text-xl font-medium text-highlighted">{{ t('stay.house_manual') }}</h2>
      <p class="mt-3 whitespace-pre-wrap break-words text-base text-muted">{{ guide.house_manual }}</p>
    </section>
    <section v-if="rules.length">
      <h2 class="text-xl font-medium text-highlighted">{{ t('stay.house_rules') }}</h2>
      <ul class="mt-3 space-y-3 text-base text-muted"><li v-for="(line, index) in rules" :key="index" class="whitespace-pre-wrap break-words">{{ line }}</li></ul>
    </section>
    <section v-if="safety.length">
      <h2 class="text-xl font-medium text-highlighted">{{ t('stay.safety_property') }}</h2>
      <ul class="mt-3 space-y-3 text-base text-muted"><li v-for="(line, index) in safety" :key="index" class="whitespace-pre-wrap break-words">{{ line }}</li></ul>
    </section>
    <section v-if="guide.checkout_instructions.length">
      <h2 class="text-xl font-medium text-highlighted">{{ t('stay.checkout_instructions') }}</h2>
      <ul class="mt-4 space-y-6">
        <li v-for="instruction in guide.checkout_instructions" :key="instruction.task" class="flex gap-4">
          <UIcon :name="STAY_CHECKOUT_TASKS[instruction.task].icon" class="mt-0.5 size-6 shrink-0 text-highlighted" aria-hidden="true" />
          <div><h3 class="text-base font-medium text-highlighted">{{ STAY_CHECKOUT_TASKS[instruction.task].label }}</h3><p v-if="instruction.details" class="mt-1 whitespace-pre-wrap break-words text-base text-muted">{{ instruction.details }}</p></div>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { StayArrivalGuide } from '~/shared/stay-arrival'
import { STAY_CHECK_IN_METHODS, STAY_CHECKOUT_TASKS } from '~/shared/stay-listing'
defineProps<{ guide: StayArrivalGuide; rules: string[]; safety: string[] }>()
const { t } = useI18n()
</script>
