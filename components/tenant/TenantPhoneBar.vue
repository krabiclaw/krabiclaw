<template>
  <div v-if="phone" data-tenant-critical-banner data-blawby-critical-banner class="bg-[var(--tenant-primary-dark,var(--tenant-primary-dark,#1e293b))] py-2.5">
    <div class="tenant-container flex justify-end">
      <a :href="`tel:${phone}`" class="whitespace-nowrap text-sm font-semibold leading-6 text-white no-underline hover:text-white/85">{{ formatPhone(phone) }}</a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
defineProps<{
  phone?: string | null
}>()
</script>
