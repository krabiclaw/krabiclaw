<template>
  <USelect :model-value="selected" :items="items" aria-label="Offering" icon="i-lucide-calendar-days" placeholder="Choose an offering" class="min-w-48 max-w-full" :disabled="disabled" @update:model-value="choose" />
</template>

<script setup lang="ts">
defineProps<{ items: { label: string; value: string }[]; disabled?: boolean }>()
const route = useRoute()
const selected = computed(() => typeof route.query.product_id === 'string' ? route.query.product_id : AGENDA_FILTER_ALL)
function choose(value: string) {
  return navigateTo({ path: `/dashboard/${route.params.orgSlug}/calendar`, query: {
    product_id: value === AGENDA_FILTER_ALL ? undefined : value,
    locationId: value === selected.value && typeof route.query.locationId === 'string' ? route.query.locationId : undefined,
    month: typeof route.query.month === 'string' ? route.query.month : undefined,
    view: typeof route.query.view === 'string' ? route.query.view : undefined,
  } })
}
</script>
