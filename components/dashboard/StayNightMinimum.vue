<template>
  <span role="img" :aria-label="nightMinimumLabel(nights)" class="inline-flex h-4 min-w-4 shrink-0 items-center justify-center self-start rounded-full px-0.5 text-[10px] font-medium leading-none tabular-nums ring-1 ring-inset ring-current">
    {{ nights }}
  </span>
</template>

<script setup lang="ts">
import { nightMinimumLabel } from '~/composables/useStayNightEditor'

defineProps<{ nights: number }>()
</script>
