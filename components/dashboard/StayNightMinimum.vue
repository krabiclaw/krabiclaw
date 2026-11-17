<template>
  <span v-if="isDefault" class="text-[11px] leading-tight text-muted sm:text-xs">Default minimum {{ nights }} {{ nights === 1 ? 'night' : 'nights' }}</span>
  <span v-else role="img" :aria-label="nightMinimumLabel(nights)" :title="`${nights}-night minimum for arrivals on this date`" class="h-4 shrink-0 self-start whitespace-nowrap text-[10px] font-medium leading-4 tabular-nums">
    Min {{ nights }}
  </span>
</template>

<script setup lang="ts">
import { nightMinimumLabel } from '~/composables/useStayNightEditor'

defineProps<{ nights: number; isDefault?: boolean }>()
</script>
