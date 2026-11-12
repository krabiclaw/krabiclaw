<template>
  <USelect :model-value="selected" :items="items" aria-label="Calendar" icon="i-lucide-calendar-days" placeholder="Choose a calendar" class="h-10 min-w-48 max-w-full rounded-full" :disabled="disabled" @update:model-value="choose" />
</template>

<script setup lang="ts">
defineProps<{ items: { label: string; value: string }[]; disabled?: boolean }>()
const route = useRoute()
const selected = computed(() => typeof route.query.product_id === 'string' ? route.query.product_id : AGENDA_FILTER_ALL)
function choose(value: string) {
  return navigateTo({ path: `/dashboard/${route.params.org_slug}/calendar`, query: {
    product_id: value === AGENDA_FILTER_ALL ? undefined : value,
    location_id: value === selected.value && typeof route.query.location_id === 'string' ? route.query.location_id : undefined,
    month: typeof route.query.month === 'string' ? route.query.month : undefined,
    view: typeof route.query.view === 'string' ? route.query.view : undefined,
  } })
}
</script>
