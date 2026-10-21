<template>
  <!-- Airbnb's host card: who runs it, in their own published words. -->
  <section v-if="status !== 'success' || hosts.length" class="border-t border-default py-10" :aria-label="t('booking.provider_title')">
    <h2 class="tenant-display text-2xl text-default sm:text-3xl">{{ t('booking.provider_title') }}</h2>
    <div v-if="error" class="mt-4 space-y-3">
      <UAlert color="error" :title="t('booking.provider_failed')" :description="getErrorMessage(error, '') || undefined" />
      <UButton color="neutral" variant="soft" @click="refresh()">{{ t('booking.provider_retry') }}</UButton>
    </div>
    <p v-else-if="status !== 'success'" role="status" class="mt-4 text-muted">{{ t('booking.provider_loading') }}</p>
    <ul v-else class="mt-6 grid gap-6 md:grid-cols-2">
      <li v-for="host in hosts" :key="host.name" class="flex flex-col gap-5 rounded-2xl border border-default bg-elevated p-6 sm:flex-row sm:items-start">
        <img v-if="host.photo_url" :src="host.photo_url" :alt="host.name" class="size-24 shrink-0 rounded-full object-cover">
        <div class="min-w-0">
          <p class="text-xl font-semibold text-default">{{ host.name }}</p>
          <p v-if="host.bio" class="mt-3 whitespace-pre-line leading-relaxed text-muted">{{ host.bio }}</p>
        </div>
      </li>
    </ul>
    <TenantButton v-if="contactTo && status === 'success' && hosts.length" variant="outline" class="mt-6" :to="contactTo">{{ t('booking.message_host') }}</TenantButton>
  </section>
</template>
<script setup lang="ts">
import { useProductHosts } from '~/composables/useProductHosts'
const props = defineProps<{ organizationId: string; productId: string; slug: string; sessionId?: string; /** Where a guest writes to the host about this offering. */ contactTo?: string }>()
const { t } = useI18n()
const { data, error, status, refresh } = await useProductHosts(() => props)
const hosts = computed(() => data.value?.hosts ?? [])
</script>
