<template>
  <!-- Airbnb's line under the title: the host's face and name. -->
  <div v-if="hosts.length" class="flex items-center gap-3" data-hosted-by>
    <div class="flex -space-x-3">
      <img v-for="host in hosts.filter(host => host.photo_url).slice(0, 3)" :key="host.name" :src="host.photo_url!" alt="" class="size-10 rounded-full border-2 border-default object-cover">
    </div>
    <p class="text-sm font-medium text-default">{{ t('booking.hosted_by', { name: names }) }}</p>
  </div>
</template>
<script setup lang="ts">
import { useProductHosts } from '~/composables/useProductHosts'
const props = defineProps<{ organizationId: string; productId: string; slug: string; sessionId?: string }>()
const { t, locale } = useI18n()
const { data } = await useProductHosts(() => props)
const hosts = computed(() => data.value?.hosts ?? [])
const names = computed(() => new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(hosts.value.map(host => host.name)))
</script>
