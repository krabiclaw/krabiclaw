<template>
  <!--
    One setting, answered by a switch on the right — Airbnb's instant-book and
    Smart Pricing rows (goal/airbnb/…/details/instant-book). A control that
    belongs to the setting once it is on sits underneath, in the same row.
  -->
  <div class="border-b border-default py-6 last:border-b-0">
    <div class="flex items-start gap-4">
      <label :for="switchId" class="min-w-0 flex-1 cursor-pointer">
        <span class="block text-base text-highlighted">{{ label }}</span>
        <span v-if="description" class="mt-1 block text-sm text-muted">{{ description }}</span>
      </label>
      <USwitch :id="switchId" v-model="model" :aria-label="label" :disabled="disabled" class="mt-0.5 shrink-0" />
    </div>
    <div v-if="$slots.default" class="mt-4">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label: string
  /** One line under the label. */
  description?: string
  disabled?: boolean
}>()

const model = defineModel<boolean>({ required: true })
const switchId = useId()
</script>
