<template>
  <nav v-if="locations.length + Number(onlineAvailable) > 1" class="mx-auto flex max-w-7xl flex-wrap justify-center gap-3 px-4 py-6" :aria-label="t('booking.choose_location')">
    <NuxtLink v-for="location in locations" :key="location.id" :to="{ path: route.path, query: { ...route.query, location_id: location.id } }" class="rounded-full border border-default px-5 py-2.5 text-sm" :aria-current="selectedLocationId === location.id ? 'page' : undefined">{{ location.title }}</NuxtLink>
    <NuxtLink v-if="onlineAvailable" :to="{ path: route.path, query: { ...route.query, location_id: 'online' } }" class="rounded-full border border-default px-5 py-2.5 text-sm" :aria-current="!scopeRequired && !selectedLocationId ? 'page' : undefined">{{ t('booking.online') }}</NuxtLink>
  </nav>
</template>

<script setup lang="ts">
import type { PublicProductLocation } from '~/server/utils/public-products'
defineProps<{ locations: PublicProductLocation[]; onlineAvailable?: boolean; selectedLocationId: string | null; scopeRequired?: boolean }>()
const route = useRoute()
const { t } = useI18n()
</script>
