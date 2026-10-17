<template>
  <!-- When used as an overlay on images (like on thumbnail cards) -->
  <template v-if="overlay">
    <div class="absolute inset-x-0 bottom-0 z-10 h-2/5 bg-linear-to-t from-black/60 to-transparent pointer-events-none" />
    <span class="absolute bottom-3 left-3 z-10 rounded-md bg-black/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-white pointer-events-none">
      {{ text }}
    </span>
  </template>

  <!-- When used inline -->
  <span v-else class="inline-flex shrink-0 items-center rounded-md bg-black/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-white">
    {{ text }}
  </span>
</template>

<script setup lang="ts">
defineProps<{
  text: string
  overlay?: boolean
}>()
</script>
