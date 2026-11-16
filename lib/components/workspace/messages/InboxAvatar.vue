<template>
  <!-- The person's circle: their initial, or Airbnb's for a support case, with the channel's mark at its corner. -->
  <span
    class="relative flex shrink-0 items-center justify-center rounded-full font-semibold"
    :class="[sizes[size].circle, support ? 'bg-inverted text-inverted' : 'bg-accented text-highlighted']"
    :aria-label="name"
    role="img"
  >
    <span :class="support ? sizes[size].support : undefined" aria-hidden="true">{{ support ? 'Airbnb' : initial }}</span>
    <ChannelMark v-if="channel && size === 'lg'" :channel="channel" class="absolute -bottom-1 -right-1" />
  </span>
</template>

<script setup lang="ts">
import ChannelMark from './ChannelMark.vue'
withDefaults(defineProps<{ name: string; initial: string; support?: boolean; channel?: 'airbnb' | 'direct' | null; size?: 'sm' | 'lg' }>(), { support: false, channel: null, size: 'lg' })
// 56px in the list and the header, 32px at the foot of a guest's run, as the cards draw them.
const sizes = {
  lg: { circle: 'size-14 text-xl', support: 'text-sm' },
  sm: { circle: 'size-8 text-[13px]', support: 'text-[9px]' },
} as const
</script>
