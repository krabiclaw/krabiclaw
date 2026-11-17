<template>
  <span role="img" :aria-label="nightMinimumLabel(nights)" class="h-4 shrink-0 self-start whitespace-nowrap text-[10px] font-medium leading-4 tabular-nums">
    Min {{ nights }}
  </span>
</template>

<script setup lang="ts">
import { nightMinimumLabel } from '~/composables/useStayNightEditor'

defineProps<{ nights: number }>()
</script>
