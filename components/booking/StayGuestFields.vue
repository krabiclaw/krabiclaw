<template>
  <div class="divide-y divide-default">
    <div v-for="row in rows" :key="row.label" class="flex items-center justify-between gap-6 py-3">
      <div><div class="text-sm font-medium">{{ row.label }}</div><div class="text-xs text-muted">{{ row.hint }}</div></div>
      <div class="flex items-center gap-3">
        <button type="button" class="flex size-8 items-center justify-center rounded-full border border-default disabled:opacity-30" :disabled="row.value.value <= row.min" :aria-label="`${row.label} −`" @click="row.value.value--"><TenantIcon name="minus" class="size-3.5" /></button>
        <span class="min-w-6 text-center tabular-nums">{{ row.value.value }}</span>
        <button type="button" class="flex size-8 items-center justify-center rounded-full border border-default disabled:opacity-30" :disabled="row.max !== null && row.value.value >= row.max" :aria-label="`${row.label} +`" @click="row.value.value++"><TenantIcon name="plus" class="size-3.5" /></button>
      </div>
    </div>
    <p class="pt-3 text-xs text-muted">{{ t('stay.max_guests', { count: maxGuests }) }}</p>
  </div>
</template>

<script setup lang="ts">
import type { StayBookingController } from '~/composables/useStayBooking'
const props = defineProps<{ controller: StayBookingController }>()
const { adults, children, infants, maxGuests } = props.controller
const { t } = useI18n()
const rows = computed(() => [
  { label: t('stay.adults'), hint: t('stay.adults_hint'), value: adults, min: 1, max: maxGuests.value - children.value },
  { label: t('stay.children'), hint: t('stay.children_hint'), value: children, min: 0, max: maxGuests.value - adults.value },
  { label: t('stay.infants'), hint: t('stay.infants_hint'), value: infants, min: 0, max: null },
])
</script>
