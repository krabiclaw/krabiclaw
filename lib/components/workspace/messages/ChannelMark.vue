<template>
  <!-- Where it was booked: the channel's mark in a small circle, at the corner of a person's avatar. -->
  <span
    class="flex items-center justify-center rounded-full border-2 border-(--ui-bg) text-[10px] font-bold text-white"
    :class="large ? 'size-8' : 'size-[22px]'"
    :style="{ backgroundColor: MARKS[channel].color }"
    role="img"
    :aria-label="`Booked through ${STAY_CHANNEL_LABELS[channel]}`"
  >
    <UIcon v-if="channel === 'airbnb'" name="i-simple-icons-airbnb" :class="large ? 'size-4' : 'size-3'" />
    <img v-else-if="channel === 'direct'" src="/platform/krabiclaw-symbol.svg" alt="" class="brightness-0 invert" :class="large ? 'size-4' : 'size-3'">
    <span v-else aria-hidden="true">{{ MARKS[channel].mark }}</span>
  </span>
</template>

<script setup lang="ts">
import { STAY_CHANNEL_LABELS, type StayChannel } from '~/shared/bookings'

defineProps<{ channel: StayChannel; large?: boolean }>()
/** Each channel's colour and, where the build has no official mark, the letters it reads. */
const MARKS: Record<StayChannel, { color: string; mark: string }> = {
  airbnb: { color: '#FF385C', mark: '' }, vrbo: { color: '#245ABC', mark: 'V' }, booking_com: { color: '#003580', mark: 'B.' }, direct: { color: 'var(--kc-navy)', mark: '' },
}
</script>
