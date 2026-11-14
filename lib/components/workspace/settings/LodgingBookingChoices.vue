<template>
  <URadioGroup
    :model-value="selection ?? undefined"
    :items="choices"
    :aria-label="label"
    variant="card"
    indicator="hidden"
    :ui="{
      fieldset: 'gap-y-3',
      item: 'relative cursor-pointer rounded-2xl p-5 sm:p-6 has-data-[state=checked]:bg-muted',
      wrapper: 'block space-y-1.5 pe-12 text-start',
      icon: 'absolute end-5 top-5 size-7 sm:end-6 sm:top-6',
      label: 'text-base font-semibold sm:text-lg',
      description: 'text-sm sm:text-base',
    }"
    @update:model-value="selection = $event ?? null"
  />
</template>

<script setup lang="ts">
import type { LodgingBookingChoice, LodgingConfirmationMode } from '~/shared/lodging-booking'

defineProps<{ choices: LodgingBookingChoice[]; label: string }>()
const selection = defineModel<LodgingConfirmationMode | null>({ required: true })
</script>
