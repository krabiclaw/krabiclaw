<template>
  <section class="overflow-hidden rounded-3xl bg-elevated shadow-[0_4px_24px_rgb(0_0_0/0.08)]">
    <div class="grid sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div v-if="offer.banner" class="grid min-h-0 place-items-center bg-[#f9efe7]">
        <img :src="offer.banner" alt="" width="512" height="512" class="h-36 w-full object-contain sm:h-full sm:max-h-56" />
      </div>
      <div class="flex flex-col justify-center gap-3 p-5 sm:p-6">
        <h2 class="text-xl font-semibold leading-snug tracking-tight text-highlighted sm:text-2xl">{{ offer.headline }}</h2>
        <p class="text-sm leading-relaxed text-toned">{{ offer.line }}</p>
      </div>
    </div>
    <p class="border-t border-default px-5 py-4 text-sm font-semibold text-highlighted sm:px-6">{{ price }}</p>
  </section>
</template>

<script setup lang="ts">
import type { Offer } from '~/shared/offers'

defineProps<{ offer: Offer; price: string }>()
</script>
